#!/usr/bin/env node
/**
 * Post-event calibration retrospective (2026-10-31 review follow-up).
 *
 * The pre-event gate scores 3 anchor ideas and passes on a judge-level
 * Pearson correlation in [0.6, 0.95]. That is a sanity check, not a stable
 * estimate. This script applies the SAME metric to the actual judged
 * population stored in judge_scores — each judge's score for a target versus
 * the leave-one-out panel mean — and prints it next to the pre-event result.
 *
 * Diagnostic, not a gate: each judge scores one specialty criterion, the
 * judged population is small on some events, and a low correlation can mean
 * range restriction or genuine criterion disagreement, not only judge error.
 * Read it as "did the 3-anchor gate predict how much judges agree on real
 * work?", not as a pass/fail.
 *
 * Usage:
 *   node scripts/calibration_retrospective.mjs [eventId] [--json]
 *   node scripts/calibration_retrospective.mjs --all
 *   node scripts/calibration_retrospective.mjs --all --json
 *   node scripts/calibration_retrospective.mjs --target-type=team --phase=hackathon
 *
 * Credentials: CF_ACCOUNT_ID + CF_API_TOKEN (or CLOUDFLARE_*), from the shell
 * environment or the repo .env. The D1 database id is read from wrangler.toml.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const all = args.includes("--all");
const eventArg = args.find((a) => !a.startsWith("--"));
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const targetType = option("target-type", "idea");
const phase = option("phase", "ideathon");
const eventType = targetType === "team" ? "hackathon" : "ideathon";
const terminalStatus = eventType === "hackathon" ? "complete" : "judged";

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node scripts/calibration_retrospective.mjs [eventId] [--all] [--json] [--target-type=idea|team] [--phase=ideathon|hackathon]",
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
  process.env.CF_ACCOUNT_ID ||
  process.env.CLOUDFLARE_ACCOUNT_ID ||
  fileEnv.CF_ACCOUNT_ID ||
  fileEnv.CLOUDFLARE_ACCOUNT_ID;
const token =
  process.env.CF_API_TOKEN ||
  process.env.CLOUDFLARE_API_TOKEN ||
  fileEnv.CF_API_TOKEN ||
  fileEnv.CLOUDFLARE_API_TOKEN;
const wrangler = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
const databaseId = wrangler.match(/database_id\s*=\s*"([^"]+)"/)?.[1];

if (!account || !token || !databaseId) {
  console.error("Missing CF_ACCOUNT_ID/CF_API_TOKEN (or CLOUDFLARE_*) or wrangler.toml database_id.");
  process.exit(1);
}

async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    },
  );
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  const result = json.result;
  return Array.isArray(result) ? (result[0]?.results ?? []) : (result?.results ?? []);
}

const pearson = (a, b) => {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
};
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const round = (x) => (x === null ? null : Math.round(x * 1000) / 1000);

const caveat =
  "Diagnostic, not a gate. Each judge scores one specialty criterion; n is the judged population, not a random sample; low r can mean range restriction or genuine criterion disagreement, not only judge error.";

async function analyze(eventId) {
  const rows = await d1(
    `SELECT judge_name, target_id, score, criterion
     FROM judge_scores
     WHERE event_id = ? AND target_type = ? AND phase = ?`,
    [eventId, targetType, phase],
  );
  if (!rows.length) return null;

  const byTarget = new Map();
  const judgeCriterion = new Map();
  for (const row of rows) {
    if (!byTarget.has(row.target_id)) byTarget.set(row.target_id, new Map());
    byTarget.get(row.target_id).set(row.judge_name, Number(row.score));
    if (!judgeCriterion.has(row.judge_name)) judgeCriterion.set(row.judge_name, row.criterion);
  }
  const judges = [...judgeCriterion.keys()].sort();
  const targets = [...byTarget.keys()].filter((t) => byTarget.get(t).size >= 2);

  const perJudge = [];
  for (const judge of judges) {
    const xs = [];
    const ys = [];
    for (const target of targets) {
      const scores = byTarget.get(target);
      if (!scores.has(judge)) continue;
      const others = [...scores.entries()].filter(([name]) => name !== judge).map(([, s]) => s);
      if (!others.length) continue;
      xs.push(scores.get(judge));
      ys.push(mean(others));
    }
    perJudge.push({ judge, criterion: judgeCriterion.get(judge), targets: xs.length, r: pearson(xs, ys) });
  }

  const pairwise = [];
  for (let i = 0; i < judges.length; i += 1) {
    for (let k = i + 1; k < judges.length; k += 1) {
      const xs = [];
      const ys = [];
      for (const target of targets) {
        const scores = byTarget.get(target);
        if (scores.has(judges[i]) && scores.has(judges[k])) {
          xs.push(scores.get(judges[i]));
          ys.push(scores.get(judges[k]));
        }
      }
      const r = pearson(xs, ys);
      if (r !== null) pairwise.push(r);
    }
  }

  const valid = perJudge.map((p) => p.r).filter((r) => r !== null);
  const meanR = valid.length ? mean(valid) : null;
  const preEventRows = await d1(
    `SELECT correlation, passed, details, created_at FROM calibration_runs
     WHERE event_id = ? ORDER BY created_at DESC LIMIT 1`,
    [eventId],
  );
  const preEvent = preEventRows[0]
    ? {
        correlation: Number(preEventRows[0].correlation),
        passed: Boolean(preEventRows[0].passed),
        created_at: preEventRows[0].created_at,
      }
    : null;
  const band =
    meanR === null ? "insufficient_data" : meanR < 0.6 ? "below" : meanR > 0.95 ? "above" : "inside";

  return {
    event_id: eventId,
    target_type: targetType,
    phase,
    judges: judges.length,
    targets: targets.length,
    pre_event: preEvent,
    retrospective: {
      mean_correlation: round(meanR),
      min_correlation: round(valid.length ? Math.min(...valid) : null),
      max_correlation: round(valid.length ? Math.max(...valid) : null),
      mean_pairwise: round(pairwise.length ? mean(pairwise) : null),
      pairwise_pairs: pairwise.length,
      band,
      per_judge: perJudge.map((p) => ({ ...p, r: round(p.r) })),
    },
    caveat,
  };
}

function printDetail(result) {
  const pre = result.pre_event;
  const retro = result.retrospective;
  console.log(`Event: ${result.event_id}`);
  console.log(`Population: ${result.target_type}/${result.phase} — ${result.targets} targets, ${result.judges} judges`);
  console.log(
    `Pre-event 3-anchor: ${pre ? `r=${pre.correlation.toFixed(3)} (${pre.passed ? "passed" : "failed"}), ${pre.created_at}` : "none recorded"}`,
  );
  console.log(
    `Retrospective: mean per-judge r=${retro.mean_correlation === null ? "n/a" : retro.mean_correlation.toFixed(3)}` +
      (retro.min_correlation !== null
        ? ` (range ${retro.min_correlation.toFixed(3)}..${retro.max_correlation.toFixed(3)})`
        : "") +
      (retro.mean_pairwise !== null
        ? `, mean pairwise r=${retro.mean_pairwise.toFixed(3)} (${retro.pairwise_pairs} pairs)`
        : ""),
  );
  for (const p of retro.per_judge) {
    console.log(
      `  ${p.judge.padEnd(6)} ${String(p.criterion).padEnd(22)} n=${p.targets} r=${p.r === null ? "n/a" : p.r.toFixed(3)}`,
    );
  }
  console.log(`Band: ${retro.band}`);
  console.log(`Note: ${result.caveat}`);
}

async function main() {
  if (all) {
    const events = await d1(
      `SELECT id, start_date FROM archive_events
       WHERE type = ? AND status = ?
       ORDER BY start_date DESC`,
      [eventType, terminalStatus],
    );
    const results = [];
    for (const event of events) {
      try {
        const r = await analyze(event.id);
        if (!r) {
          console.error(`skip ${event.id}: no judge_scores for ${targetType}/${phase}`);
          continue;
        }
        results.push({ ...r, start_date: event.start_date });
      } catch (err) {
        console.error(`skip ${event.id}: ${err.message}`);
      }
    }
    if (jsonOut) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    console.log(
      "event".padEnd(14) + "start".padEnd(12) + "n".padStart(4) + "  pre-r  gate    retro  pair   band",
    );
    for (const r of results) {
      const pre = r.pre_event;
      console.log(
        r.event_id.slice(0, 12).padEnd(14) +
          String(r.start_date).slice(0, 10).padEnd(12) +
          String(r.targets).padStart(4) +
          "  " +
          (pre ? pre.correlation.toFixed(3) : "  n/a").padStart(5) +
          "  " +
          (pre ? (pre.passed ? "pass" : "FAIL") : " -- ").padEnd(6) +
          "  " +
          (r.retrospective.mean_correlation === null
            ? "  n/a"
            : r.retrospective.mean_correlation.toFixed(3)
          ).padStart(5) +
          "  " +
          (r.retrospective.mean_pairwise === null
            ? "  n/a"
            : r.retrospective.mean_pairwise.toFixed(3)
          ).padStart(5) +
          "  " +
          r.retrospective.band,
      );
    }
    return;
  }

  let eventId = eventArg;
  if (!eventId) {
    const rows = await d1(
      `SELECT id, start_date FROM archive_events
       WHERE type = ? AND status = ?
       ORDER BY start_date DESC LIMIT 1`,
      [eventType, terminalStatus],
    );
    if (!rows.length) {
      console.error("No event id given and no judged ideathon found.");
      process.exit(1);
    }
    eventId = rows[0].id;
    if (!jsonOut) console.log(`No event id given; using latest judged ideathon ${eventId} (${rows[0].start_date}).`);
  }

  const result = await analyze(eventId);
  if (!result) {
    const groups = await d1(
      `SELECT target_type, phase, COUNT(*) AS n FROM judge_scores WHERE event_id = ? GROUP BY target_type, phase`,
      [eventId],
    );
    console.error(`No judge_scores for ${eventId} ${targetType}/${phase}. Available: ${JSON.stringify(groups)}`);
    process.exit(1);
  }
  if (jsonOut) console.log(JSON.stringify(result, null, 2));
  else printDetail(result);
}

await main();
