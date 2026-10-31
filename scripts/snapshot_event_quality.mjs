#!/usr/bin/env node
/**
 * Backfill/refresh event quality snapshots (R-2 persistence, 2026-10-31).
 *
 * The Worker writes a snapshot when an event reaches a terminal judging state.
 * This script is the safety net for events judged before the snapshot hook
 * existed, and for any transition the Worker missed. It reads the live
 * `/events/summary` payload (the same computation the public API uses) and
 * upserts each terminal event's `quality` object into
 * `event_quality_snapshots`.
 *
 * Read-only with respect to the Worker; the only writes are D1 upserts.
 *
 * Usage:
 *   node scripts/snapshot_event_quality.mjs [--dry-run] [--json]
 *
 * Credentials: CF_ACCOUNT_ID + CF_API_TOKEN (or CLOUDFLARE_*), from the shell
 * environment or the repo .env. ARENA_API_BASE overrides the Worker URL.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonOut = args.includes("--json");
const apiBase = (process.env.ARENA_API_BASE || "https://arena-api.sadi21863.workers.dev").replace(/\/+$/, "");

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/snapshot_event_quality.mjs [--dry-run] [--json]");
  process.exit(0);
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileEnv = readEnvFile(path.join(root, ".env"));
const account =
  process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || fileEnv.CF_ACCOUNT_ID || fileEnv.CLOUDFLARE_ACCOUNT_ID;
const cfToken =
  process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || fileEnv.CF_API_TOKEN || fileEnv.CLOUDFLARE_API_TOKEN;
const wrangler = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
const databaseId = wrangler.match(/database_id\s*=\s*"([^"]+)"/)?.[1];

if (!account || !cfToken || !databaseId) {
  console.error("Missing CF_ACCOUNT_ID/CF_API_TOKEN (or CLOUDFLARE_*) or wrangler.toml database_id.");
  process.exit(1);
}

async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(60000),
    },
  );
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors ?? json)}`);
  const result = json.result;
  return Array.isArray(result) ? (result[0]?.results ?? []) : (result?.results ?? []);
}

const terminal = (event) =>
  (event.type === "ideathon" && event.status === "judged") ||
  (event.type === "hackathon" && ["judged", "tribunal", "complete"].includes(event.status));

const summaryRes = await fetch(`${apiBase}/events/summary`, { signal: AbortSignal.timeout(30000) });
if (!summaryRes.ok) {
  console.error(`GET /events/summary failed: HTTP ${summaryRes.status}`);
  process.exit(1);
}
const events = await summaryRes.json();
const candidates = events.filter((event) => terminal(event) && event.quality);

const updates = [];
for (const event of candidates) {
  const q = event.quality;
  const row = {
    event_id: event.id,
    judged_population: q.judged_population ?? 0,
    pre_correlation: q.pre_event?.correlation ?? null,
    pre_passed: q.pre_event ? (q.pre_event.passed ? 1 : 0) : null,
    retrospective_correlation: q.retrospective?.mean_correlation ?? null,
    retrospective_band: q.retrospective?.band ?? "insufficient_data",
    confidence_level: q.level,
    confidence_reasons: JSON.stringify(q.reasons ?? []),
  };
  updates.push(row);
  if (dryRun) continue;
  await d1(
    `INSERT INTO event_quality_snapshots
       (event_id, judged_population, pre_correlation, pre_passed,
        retrospective_correlation, retrospective_band, confidence_level,
        confidence_reasons, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(event_id) DO UPDATE SET
       judged_population = excluded.judged_population,
       pre_correlation = excluded.pre_correlation,
       pre_passed = excluded.pre_passed,
       retrospective_correlation = excluded.retrospective_correlation,
       retrospective_band = excluded.retrospective_band,
       confidence_level = excluded.confidence_level,
       confidence_reasons = excluded.confidence_reasons,
       computed_at = excluded.computed_at`,
    [
      row.event_id,
      row.judged_population,
      row.pre_correlation,
      row.pre_passed,
      row.retrospective_correlation,
      row.retrospective_band,
      row.confidence_level,
      row.confidence_reasons,
    ],
  );
}

if (jsonOut) {
  console.log(JSON.stringify({ dry_run: dryRun, count: updates.length, snapshots: updates }, null, 2));
} else {
  console.log(
    `${dryRun ? "Would snapshot" : "Snapshotted"} ${updates.length} terminal event(s) from ${apiBase}.`,
  );
  for (const row of updates) {
    console.log(
      `  ${row.event_id} ${row.confidence_level.padEnd(8)} n=${row.judged_population} ` +
        `r=${row.retrospective_correlation ?? "n/a"} band=${row.retrospective_band}`,
    );
  }
}
