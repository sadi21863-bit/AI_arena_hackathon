#!/usr/bin/env node
/**
 * Regression test for the G7 queue journal (src/events/queue.ts,
 * db/schema_week10_queue_journal.sql, GET /events/:id/journal in
 * src/index.ts).
 *
 * The journal is the replay timeline's only record of work that died: a
 * failed task leaves no archive_interactions row, and the in-place
 * event_queue status flips (pending -> in_progress -> completed/failed,
 * in_progress -> pending) destroy the history a replay needs. A future
 * refactor that drops one of the journal inserts produces no visible
 * symptom anywhere except a replay timeline with holes — exactly the
 * silent-regression shape this suite exists for (same as
 * test_dispatch_cap.js / test_recall_lessons.js): the code under test is
 * parsed straight out of the source so the test cannot drift from what
 * ships.
 *
 *   node scripts/test_queue_journal.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "events", "queue.ts"), "utf8");

/** Extracts just the BODY of `function name(...)` — braces matched, signature skipped. */
function extractBody(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in queue.ts — test is out of date with the source`);
  // The parameter list may itself contain `{...}` type annotations, so skip
  // to the paren that closes the signature before hunting for the body's `{`.
  // Depth starts at 1: parenStart already sits inside the signature's open `(`.
  let parenDepth = 1, close = -1;
  for (let i = start + `function ${name}(`.length; i < SRC.length; i++) {
    if (SRC[i] === "(") parenDepth++;
    else if (SRC[i] === ")") { parenDepth--; if (parenDepth === 0) { close = i; break; } }
  }
  assert.ok(close > 0, `could not find the end of ${name}'s parameter list`);
  const open = SRC.indexOf("{", close);
  let depth = 0, end = -1;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, `could not find the end of ${name}`);
  return SRC.slice(open, end + 1);
}

// Wrap each body in a plain-JS signature (the real param types live in the
// source's signature, which we skip). Strip the two TS-isms the bodies
// contain: method-call generics on .first and the (r: any) annotation.
const wrapped = {
  enqueue: `async function enqueue(env, item) ${extractBody("enqueue")}`,
  claimNext: `async function claimNext(env) ${extractBody("claimNext")}`,
  markCompleted: `async function markCompleted(env, id, eventId) ${extractBody("markCompleted")}`,
  markFailed: `async function markFailed(env, id, errorMessage) ${extractBody("markFailed")}`,
  resetStuckItems: `async function resetStuckItems(env, staleAfterMinutes) ${extractBody("resetStuckItems")}`,
  journal: `async function journal(env, e) ${extractBody("journal")}`,
};
let js = Object.values(wrapped).join("\n")
  .replace(/\.first<[^>]*>/g, ".first")
  .replace(/\(r: any\)/g, "(r)");

/** A fake DB that records every prepare/bind/run/first/all/batch call. */
function makeEnv() {
  const calls = [];
  const db = {
    calls,
    firstResult: null,
    allResult: { results: [] },
    prepare(sql) {
      // claimNext calls .first() directly on the prepared statement (no
      // .bind — its UPDATE takes no params), so the command object itself
      // must expose run/first/all and lazily record a call if bind never ran.
      let entry = null;
      const ensure = () => {
        if (!entry) { entry = { sql, params: [], op: null }; calls.push(entry); }
        return entry;
      };
      const cmd = {
        get entry() { return entry; },
        run: async () => { ensure().op = "run"; return {}; },
        first: async () => { ensure().op = "first"; return db.firstResult; },
        all: async () => { ensure().op = "all"; return db.allResult; },
        bind: (...params) => { entry = { sql, params, op: null }; calls.push(entry); return cmd; },
      };
      return cmd;
    },
    batch: async (list) => { list.forEach((s) => { s.entry.op = "batch"; }); return []; },
  };
  return { env: { DB: db }, db };
}

const ctx = { globalThis: null, makeEnv };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(
  js + "\nglobalThis.__wrapped = { enqueue, claimNext, markCompleted, markFailed, resetStuckItems };",
  ctx
);

const journalRows = (db) => db.calls.filter((c) => c.sql.includes("INSERT INTO queue_journal"));

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

console.log("G7 queue journal (src/events/queue.ts)");

check("enqueue journals the row's birth (NULL -> pending)", async () => {
  const { env, db } = makeEnv();
  db.firstResult = { id: 42 };
  await ctx.__wrapped.enqueue(env, { eventId: "ev1", agentId: "agent_x", taskType: "research", payload: { x: 1 } });
  const j = journalRows(db);
  assert.strictEqual(j.length, 1, "expected exactly one journal row from enqueue");
  const row = j[0];
  assert.strictEqual(row.params[0], 42, "item_id must come from the INSERT's RETURNING id");
  assert.strictEqual(row.params[1], "ev1");
  assert.strictEqual(row.params[2], "agent_x");
  assert.strictEqual(row.params[3], "research");
  assert.strictEqual(row.params[4], null, "from_status must be NULL on creation");
  assert.strictEqual(row.params[5], "pending");
});

check("claimNext journals pending -> in_progress", async () => {
  const { env, db } = makeEnv();
  db.firstResult = { id: 7, event_id: "ev1", agent_id: "agent_y", task_type: "critique" };
  const item = await ctx.__wrapped.claimNext(env);
  assert.strictEqual(item.id, 7, "claim must still return the claimed row");
  const j = journalRows(db);
  assert.strictEqual(j.length, 1);
  assert.strictEqual(j[0].params[4], "pending");
  assert.strictEqual(j[0].params[5], "in_progress");
});

check("markCompleted journals in_progress -> completed in the same batch", async () => {
  const { env, db } = makeEnv();
  await ctx.__wrapped.markCompleted(env, 7, "ev1");
  const j = journalRows(db);
  assert.strictEqual(j.length, 1);
  assert.strictEqual(j[0].op, "batch", "the journal row must ride the same batch as the status flip");
  assert.ok(j[0].sql.includes("'in_progress', 'completed'"), "completed transition must be journaled");
  assert.ok(j[0].sql.includes("FROM event_queue WHERE id = ?"), "must read agent/task from the live row");
  assert.strictEqual(j[0].params[0], 7);
});

check("markFailed journals in_progress -> failed with the error message", async () => {
  const { env, db } = makeEnv();
  const longErr = "x".repeat(2500);
  await ctx.__wrapped.markFailed(env, 9, longErr);
  const j = journalRows(db);
  assert.strictEqual(j.length, 1);
  assert.strictEqual(j[0].op, "batch");
  assert.ok(j[0].sql.includes("'in_progress', 'failed'"));
  assert.strictEqual(j[0].params[0].length, 2000, "error_message must be truncated to the column budget");
  assert.strictEqual(j[0].params[1], 9);
});

check("resetStuckItems journals every reset (in_progress -> pending)", async () => {
  const { env, db } = makeEnv();
  db.allResult = { results: [
    { id: 11, event_id: "ev1", agent_id: "agent_z", task_type: "architecture" },
    { id: 12, event_id: "ev1", agent_id: null, task_type: "team_formation" },
  ] };
  const n = await ctx.__wrapped.resetStuckItems(env, 10);
  assert.strictEqual(n, 2);
  const j = journalRows(db);
  assert.strictEqual(j.length, 2, "one journal row per reset row");
  assert.ok(db.calls[0].sql.includes("RETURNING id, event_id, agent_id, task_type"), "reset must RETURN the rows it flips");
  assert.strictEqual(j[0].params[0], 11);
  assert.strictEqual(j[0].params[1], "ev1");
  assert.strictEqual(j[0].params[2], "agent_z");
  assert.strictEqual(j[0].params[3], "architecture");
  assert.ok(j[0].sql.includes("'in_progress', 'pending'"),
    "reset transition must be journaled as in_progress -> pending (statuses are SQL literals here)");
});

check("every transition path reaches a journal insert (source-level wiring guard)", () => {
  const inlineSites = SRC.split("INSERT INTO queue_journal").length - 1;
  // Four inline inserts (markCompleted, markFailed, resetStuckItems, the
  // journal helper itself) plus the helper's callers (enqueue, claimNext).
  assert.ok(inlineSites >= 4, `expected >=4 inline queue_journal insert sites, found ${inlineSites}`);
  const enqueueBody = SRC.slice(SRC.indexOf("export async function enqueue("), SRC.indexOf("export async function claimNext("));
  const claimBody = SRC.slice(SRC.indexOf("export async function claimNext("), SRC.indexOf("export async function markCompleted("));
  assert.ok(enqueueBody.includes("await journal(env,"), "enqueue must route its birth entry through the journal helper");
  assert.ok(claimBody.includes("await journal(env,"), "claimNext must route its claim through the journal helper");
});

check("GET /events/:id/journal endpoint exists", () => {
  const idx = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");
  assert.ok(idx.includes("/journal"), "index.ts must expose the journal route");
  assert.ok(idx.includes("FROM queue_journal WHERE event_id = ?"), "route must read the journal table");
});

check("schema + registration are in place", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema_week10_queue_journal.sql"), "utf8");
  assert.ok(schema.includes("CREATE TABLE queue_journal"), "week10 schema must create queue_journal");
  assert.ok(schema.includes("idx_queue_journal_event"), "event-order index required for replay reads");
  const apply = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply_schema.js"), "utf8");
  assert.ok(apply.includes("schema_week10_queue_journal.sql"), "migration must be registered in apply_schema.js");
  assert.ok(apply.includes('sentinel: { type: "table", name: "queue_journal" }'), "sentinel must be the table itself");
  const order = fs.readFileSync(path.join(__dirname, "..", "db", "APPLY_ORDER.md"), "utf8");
  assert.ok(order.includes("schema_week10_queue_journal.sql"), "migration must be documented in APPLY_ORDER.md");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
