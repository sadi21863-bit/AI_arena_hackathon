#!/usr/bin/env node
/**
 * Regression test for the build-turn daily cap (src/events/scheduler.ts).
 *
 * The bug this exists to prevent, found live in production 2026-08-01: the
 * cap counted dispatches with `queuedPayloadValues`, which returns a SET.
 * Iterating a set of teamIds yields each team exactly once, so every team's
 * "dispatches today" was permanently 1 and a ceiling of 6 could never be
 * reached.
 *
 * It failed silently and looked healthy — turns were being dispatched, runs
 * were completing, nothing errored. The real hackathon ran 101+ turns per team
 * in a day against a cap of 6, and only the `cancelled` conclusions on the
 * GitHub side gave it away.
 *
 * Both helpers are exercised here, because the fix is precisely "use the other
 * one" and a future refactor could quietly swap it back.
 *
 *   node scripts/test_dispatch_cap.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "events", "payload-utils.ts"), "utf8");

// Strip the TypeScript annotations and evaluate the real helpers, so this
// cannot drift from the source it guards.
const js = SRC
  .replace(/^import[^\n]*\n/gm, "")
  .replace(/export /g, "")
  .replace(/:\s*Array<\{[^}]*\}>/g, "")
  .replace(/:\s*Map<[^>]*>/g, "")
  .replace(/:\s*Set<[^>]*>/g, "")
  .replace(/:\s*string \| null/g, "")
  .replace(/:\s*string \| undefined/g, "")
  .replace(/:\s*string/g, "")
  .replace(/:\s*number/g, "")
  .replace(/new Set<[^>]*>\(\)/g, "new Set()")
  .replace(/new Map<[^>]*>\(\)/g, "new Map()");

const ctx = { module: {} };
vm.createContext(ctx);
vm.runInContext(js + "\nmodule.exports = { queuedPayloadValues, countPayloadFieldMatches, payloadFieldCounts };", ctx);
const { queuedPayloadValues, payloadFieldCounts } = ctx.module.exports;

const MAX = 6;
const row = (teamId) => ({ payload: JSON.stringify({ teamId, teamName: teamId }) });

/** The real shape: two teams, dispatched many times each in one day. */
const todaysDispatches = [
  ...Array.from({ length: 40 }, () => row("team_alpha")),
  ...Array.from({ length: 37 }, () => row("team_beta")),
];

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

console.log("the cap must see real counts");

check("payloadFieldCounts reports actual per-team totals", () => {
  const counts = payloadFieldCounts(todaysDispatches, "teamId");
  assert.strictEqual(counts.get("team_alpha"), 40);
  assert.strictEqual(counts.get("team_beta"), 37);
});

check("the cap fires once a team is past the ceiling", () => {
  const counts = payloadFieldCounts(todaysDispatches, "teamId");
  assert.ok((counts.get("team_alpha") ?? 0) >= MAX, "40 dispatches must exceed a cap of 6");
  assert.ok((counts.get("team_beta") ?? 0) >= MAX, "37 dispatches must exceed a cap of 6");
});

check("the cap does NOT fire below the ceiling", () => {
  const counts = payloadFieldCounts([row("team_alpha"), row("team_alpha")], "teamId");
  assert.ok((counts.get("team_alpha") ?? 0) < MAX, "2 dispatches must stay under a cap of 6");
});

check("a team with no dispatches today counts as zero, not undefined-as-pass", () => {
  const counts = payloadFieldCounts(todaysDispatches, "teamId");
  assert.strictEqual(counts.get("team_gamma"), undefined);
  assert.ok((counts.get("team_gamma") ?? 0) < MAX);
});

console.log("\nthe original bug, pinned so it cannot return");

check("queuedPayloadValues collapses repeats — never use it to count", () => {
  const set = queuedPayloadValues(todaysDispatches, "teamId");
  assert.strictEqual(set.size, 2, "77 rows across 2 teams collapse to 2 entries");

  // Exactly the broken loop that shipped: iterate the set, +1 per entry.
  const broken = new Map();
  for (const id of set) broken.set(id, (broken.get(id) ?? 0) + 1);
  assert.strictEqual(broken.get("team_alpha"), 1, "the bug: 40 dispatches counted as 1");
  assert.ok((broken.get("team_alpha") ?? 0) < MAX, "and so the cap could never fire");
});

check("scheduler.ts uses the counting helper, not the set helper, for the cap", () => {
  const sched = fs.readFileSync(path.join(__dirname, "..", "src", "events", "scheduler.ts"), "utf8");
  const block = sched.match(/const dispatchedTodayCount[\s\S]{0,200}/);
  assert.ok(block, "dispatchedTodayCount not found in scheduler.ts");
  assert.ok(
    /payloadFieldCounts\(/.test(block[0]),
    "the daily cap must be built from payloadFieldCounts"
  );
  assert.ok(
    !/queuedPayloadValues\(/.test(block[0]),
    "queuedPayloadValues deduplicates — using it here reintroduces the runaway"
  );
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
