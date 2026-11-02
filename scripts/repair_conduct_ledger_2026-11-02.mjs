#!/usr/bin/env node
/**
 * One-off repair for the 2026-11-02 conduct saturation (dry-run by default).
 *
 * The R1 quota rule added a strike for every derived submission past the first
 * (src/conduct/classify.ts, fixed in 93f7233). With three evolution-class ideas
 * per agent per event, every agent reached the 3-strike suspension threshold,
 * and 30 of 33 ideas in event_40e6b8d8 were stored as `blocked`.
 *
 * This script:
 *   1. replays only genuine R4 strikes (violation +1, hard +2) with the
 *      per-event clean-arena decay, ignoring the quota strikes;
 *   2. rewrites archive_agents.conduct_strikes to that replay;
 *   3. unblocks current-event non-hard ideas whose agent is below the
 *      suspension threshold under the corrected ledger;
 *   4. queues the three critiques those ideas never received.
 *
 * It is idempotent: the replay is deterministic, the unblock only touches
 * `blocked` rows, and critique assignment counts existing critics before
 * adding any. Run with `--apply` to write.
 *
 * Usage:
 *   node scripts/repair_conduct_ledger_2026-11-02.mjs
 *   node scripts/repair_conduct_ledger_2026-11-02.mjs --apply
 *   node scripts/repair_conduct_ledger_2026-11-02.mjs --event=event_... --apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const eventArg = args.find((a) => a.startsWith("--event="));
const eventId = eventArg ? eventArg.slice("--event=".length) : "event_40e6b8d8-a3ca-48c6-af6b-f8297667dabb";
const PRIVILEGE_LIMIT = 3;
const CRITICS_PER_IDEA = 3;

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = readEnvFile(path.join(root, ".env"));
const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
const dbId = (toml.match(/database_id\s*=\s*"([^"]+)"/) || [])[1];
if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !dbId) {
  throw new Error("CF_ACCOUNT_ID, CF_API_TOKEN and wrangler.toml database_id are required");
}
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${dbId}/query`;

async function d1(sql, params = []) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json();
  if (!body.success) throw new Error(JSON.stringify(body.errors));
  return body.result[0];
}

const ideas = (await d1(
  `SELECT id, agent_id, event_id, recycle_class, status, created_at, title
   FROM archive_ideas WHERE recycle_class IS NOT NULL ORDER BY created_at ASC, id ASC`,
)).results;
const agents = (await d1(`SELECT id, name, conduct_strikes FROM archive_agents ORDER BY id`)).results;
const blocked = (await d1(
  `SELECT id, agent_id, title, recycle_class, conduct_penalty, created_at
   FROM archive_ideas WHERE event_id = ? AND status = 'blocked' ORDER BY created_at ASC, id ASC`,
  [eventId],
)).results;

// Replay genuine strikes per agent/event. Quota strikes are deliberately not
// counted; the corrected R1 rule is a score penalty only.
const byAgent = new Map();
for (const idea of ideas) {
  if (!byAgent.has(idea.agent_id)) byAgent.set(idea.agent_id, new Map());
  const events = byAgent.get(idea.agent_id);
  if (!events.has(idea.event_id)) events.set(idea.event_id, { first: idea.created_at, genuine: 0 });
  const e = events.get(idea.event_id);
  if (idea.recycle_class === "violation") e.genuine += 1;
  else if (idea.recycle_class === "hard") e.genuine += 2;
}

const replay = new Map();
for (const [agentId, events] of byAgent) {
  let ledger = 0;
  const trace = [];
  for (const e of [...events.values()].sort((a, b) => a.first.localeCompare(b.first))) {
    if (e.genuine > 0) {
      ledger += e.genuine;
      trace.push(`+${e.genuine}`);
    } else {
      ledger = Math.max(0, ledger - 1);
      trace.push("-1");
    }
  }
  replay.set(agentId, { ledger, trace });
}

console.log(`event: ${eventId}`);
console.log(`mode: ${apply ? "APPLY" : "DRY RUN"}`);
console.log("\nGenuine-only ledger replay:");
for (const agent of agents) {
  const r = replay.get(agent.id) ?? { ledger: 0, trace: [] };
  const mark = r.ledger !== agent.conduct_strikes ? " *" : "";
  console.log(
    `  ${agent.id.padEnd(14)} ${String(agent.conduct_strikes).padStart(2)} -> ${String(r.ledger).padStart(2)}${mark}  [${r.trace.join(" ")}]`,
  );
}

const unblock = blocked.filter((idea) => {
  const corrected = replay.get(idea.agent_id)?.ledger ?? 0;
  return idea.recycle_class !== "hard" && corrected < PRIVILEGE_LIMIT;
});
const stillBlocked = blocked.filter((idea) => !unblock.includes(idea));
console.log(`\nBlocked ideas: ${blocked.length} | unblock: ${unblock.length} | keep blocked: ${stillBlocked.length}`);
for (const idea of unblock) {
  console.log(`  unblock ${idea.id} (${idea.recycle_class}, ${idea.conduct_penalty}) ${idea.title}`);
}
for (const idea of stillBlocked) {
  console.log(`  keep    ${idea.id} (${idea.recycle_class}, ${idea.conduct_penalty}) ${idea.title}`);
}

// Existing critics: completed critiques (interactions) plus pending/in_progress
// queue assignments. A Set keeps a completed queue row and its interaction from
// double-counting the same critic.
const interactions = (await d1(
  `SELECT target_id, actor_id FROM archive_interactions WHERE event_id = ? AND type = 'critique'`,
  [eventId],
)).results;
const openCritiques = (await d1(
  `SELECT agent_id, payload FROM event_queue WHERE event_id = ? AND task_type = 'critique' AND status IN ('pending','in_progress')`,
  [eventId],
)).results;
const assigned = new Map();
for (const row of interactions) {
  if (!assigned.has(row.target_id)) assigned.set(row.target_id, new Set());
  assigned.get(row.target_id).add(row.actor_id);
}
for (const row of openCritiques) {
  let ideaId;
  try {
    ideaId = JSON.parse(row.payload ?? "{}").ideaId;
  } catch {
    continue;
  }
  if (!ideaId) continue;
  if (!assigned.has(ideaId)) assigned.set(ideaId, new Set());
  assigned.get(ideaId).add(row.agent_id);
}

const agentIds = agents.map((a) => a.id);
function pickCritics(idea) {
  const already = assigned.get(idea.id) ?? new Set();
  const candidates = agentIds.filter((id) => id !== idea.agent_id && !already.has(id));
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, Math.max(0, CRITICS_PER_IDEA - already.size));
}

const queueRows = [];
for (const idea of unblock) {
  for (const critic of pickCritics(idea)) {
    queueRows.push({ ideaId: idea.id, critic });
  }
}
console.log(`\nCritiques to queue: ${queueRows.length}`);
if (!apply) {
  console.log("\nDry run. Re-run with --apply to write.");
  process.exit(0);
}

// 1. Correct the ledger.
let ledgerUpdates = 0;
for (const agent of agents) {
  const target = replay.get(agent.id)?.ledger ?? 0;
  if (target === agent.conduct_strikes) continue;
  await d1(`UPDATE archive_agents SET conduct_strikes = ? WHERE id = ?`, [target, agent.id]);
  ledgerUpdates += 1;
}

// 2. Unblock eligible ideas.
if (unblock.length > 0) {
  const placeholders = unblock.map(() => "?").join(",");
  await d1(`UPDATE archive_ideas SET status = 'submitted' WHERE id IN (${placeholders})`, unblock.map((i) => i.id));
}

// 3. Queue critiques + journal births, in chunks to keep each statement small.
const now = new Date().toISOString().replace("T", " ").slice(0, 19);
let queued = 0;
for (let i = 0; i < queueRows.length; i += 20) {
  const chunk = queueRows.slice(i, i + 20);
  const values = chunk.map(() => "(?, ?, 'critique', ?, 6, ?)").join(",");
  const params = chunk.flatMap((row) => [eventId, row.critic, JSON.stringify({ ideaId: row.ideaId }), now]);
  const inserted = await d1(
    `INSERT INTO event_queue (event_id, agent_id, task_type, payload, priority, scheduled_for)
     VALUES ${values} RETURNING id`,
    params,
  );
  const ids = inserted.results.map((r) => r.id);
  if (ids.length !== chunk.length) throw new Error("event_queue RETURNING count mismatch");
  const journalValues = chunk.map(() => "(?, ?, ?, 'critique', NULL, 'pending')").join(",");
  const journalParams = chunk.flatMap((row, idx) => [ids[idx], eventId, row.critic]);
  await d1(
    `INSERT INTO queue_journal (item_id, event_id, agent_id, task_type, from_status, to_status)
     VALUES ${journalValues}`,
    journalParams,
  );
  queued += chunk.length;
}

console.log(`\nApplied: ${ledgerUpdates} ledger update(s), ${unblock.length} unblock(s), ${queued} critique(s) queued.`);
