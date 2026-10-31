#!/usr/bin/env node
/**
 * Semantic sample generator (R-3, 2026-10-31).
 *
 * The structural audit catches empty/placeholder artifacts; the semantic-lite
 * checks catch duplicates/thin code. Neither judges whether a well-written
 * idea is actually specific, differentiated and buildable. This selects a
 * deterministic sample and emits a review sheet for a human or agent to read.
 *
 * It is a sample, not a judge: no scores are written back, and a single
 * reviewer's verdict is not a calibrated quality signal. The point is to make
 * "plausible but bad" visible on a recurring basis without spending the event's
 * inference budget.
 *
 * Usage:
 *   node scripts/semantic_sample.mjs [--event=event_...] [--n=10]
 *                                    [--out=docs/SEMANTIC_SAMPLE.md] [--json]
 *
 * Selection: judged ideas first (by ideathon_score desc), then other statuses
 * by created_at desc, until n. Current events are small; --n is a cap, not a
 * random sample, so the finalists are always included.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const eventArg = option("event", null);
const sampleN = Math.max(1, Math.min(50, Number(option("n", "10")) || 10));

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node scripts/semantic_sample.mjs [--event=event_...] [--n=10] [--out=path] [--json]",
  );
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

const event = eventArg
  ? (await d1(`SELECT id, status, start_date FROM archive_events WHERE id = ?`, [eventArg]))[0]
  : (await d1(
      `SELECT id, status, start_date FROM archive_events
       WHERE type = 'ideathon' AND status = 'judged' ORDER BY start_date DESC LIMIT 1`,
    ))[0];

if (!event) {
  console.error("No judged ideathon found (pass --event=event_...).");
  process.exit(1);
}

const rows = await d1(
  `SELECT id, agent_id, title, one_liner, problem, solution, target_user, research_anchor,
          build_scope, status, ideathon_score, created_at
   FROM archive_ideas WHERE event_id = ?
   ORDER BY CASE status WHEN 'judged' THEN 0 ELSE 1 END,
            ideathon_score DESC, created_at DESC
   LIMIT ?`,
  [event.id, sampleN],
);

const generatedAt = new Date().toISOString();
const selection = rows.filter((row) => row.status === "judged").length;

if (jsonOut) {
  console.log(JSON.stringify({ generated_at: generatedAt, event, requested: sampleN, selection, ideas: rows }, null, 2));
  process.exit(0);
}

const lines = [];
lines.push(`# Semantic sample — ${event.id}`);
lines.push("");
lines.push(`Generated ${generatedAt}. Event status: \`${event.status}\`, start \`${event.start_date}\`.`);
lines.push("");
lines.push(
  `Selection: **${rows.length}** idea(s), judged finalists first. ` +
    `${selection} judged, ${rows.length - selection} non-finalist. This is a deterministic sample, not a random one.`,
);
lines.push("");
lines.push(
  "Review each idea against four questions: is the problem specific, is the solution " +
    "differentiated, is the build scope realistic, and is there evidence the agent did real " +
    "research? Record `pass`, `weak`, or `fail` plus one concrete note. Do not write a score " +
    "back to D1 — this sheet is a sample, not a judge.",
);
lines.push("");

rows.forEach((row, index) => {
  lines.push(`## ${index + 1}. ${row.title ?? "(untitled)"}`);
  lines.push("");
  lines.push(`- id: \`${row.id}\``);
  lines.push(`- status: \`${row.status}\`; ideathon score: ${row.ideathon_score ?? "—"}`);
  lines.push(`- one-liner: ${row.one_liner ?? "—"}`);
  lines.push(`- target user: ${row.target_user ?? "—"}`);
  lines.push(`- research anchor: ${row.research_anchor ?? "—"}`);
  lines.push("");
  lines.push(`**Problem.** ${row.problem ?? "—"}`);
  lines.push("");
  lines.push(`**Solution.** ${row.solution ?? "—"}`);
  lines.push("");
  lines.push(`**Build scope.** ${row.build_scope ?? "—"}`);
  lines.push("");
  lines.push("| criterion | verdict | note |");
  lines.push("|---|---|---|");
  lines.push("| Specific problem |  |  |");
  lines.push("| Differentiated solution |  |  |");
  lines.push("| Realistic build scope |  |  |");
  lines.push("| Research evidence |  |  |");
  lines.push("| Overall |  |  |");
  lines.push("");
});

lines.push("## Reviewer summary");
lines.push("");
lines.push("| idea | overall | strongest concern |");
lines.push("|---|---|---|");
for (const row of rows) lines.push(`| ${row.title ?? row.id} |  |  |`);
lines.push("");
lines.push(
  "Caveat: one reviewer, a small deterministic sample, and no inter-rater calibration. " +
    "This is a tripwire for plausible-but-bad output, not a replacement for judge scores.",
);
lines.push("");

const markdown = lines.join("\n");
const outPath = option("out", null);
if (outPath) {
  const resolved = path.resolve(root, outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, markdown, "utf8");
  console.log(`Wrote ${rows.length} idea(s) to ${resolved}`);
} else {
  console.log(markdown);
}
