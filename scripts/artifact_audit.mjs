#!/usr/bin/env node
/**
 * Artifact audit (2026-10-31 review follow-up, R-3).
 *
 * Row existence is not output. This checks the artifacts themselves:
 *   - ideas: required fields, minimum lengths, no placeholders, problem !== solution
 *   - critiques: JSON with strength/weakness/suggestion, each substantive
 *   - build repos: a real run+commit, product files outside the scaffold,
 *     a test, VERIFICATION_REPORT.md, and a parseable Verdict line
 *
 * Read-only by default: D1 via the Cloudflare HTTP API + public GitHub repos.
 * `--persist` writes a compact result to `event_quality` (the only write), so
 * the per-event audit is recorded and visible on GET /events/:id. Defaults to
 * all rows for the selected event (current events are small); `--n=N` samples
 * when needed.
 *
 * Usage:
 *   node scripts/artifact_audit.mjs [--event=event_...] [--hackathon=event_...]
 *                                   [--n=10] [--json] [--strict] [--persist]
 *
 * Credentials: CF_ACCOUNT_ID + CF_API_TOKEN (or CLOUDFLARE_*) and
 * GITHUB_TOKEN, from the shell environment or the repo .env. The D1 database
 * id is read from wrangler.toml.
 *
 * Exit code: 0 unless the audit itself errors; `--strict` exits 1 when a
 * contract check fails (notes such as a NOT READY verdict do not fail).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const strict = args.includes("--strict");
const persist = args.includes("--persist");
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const eventArg = option("event", null);
const hackathonArg = option("hackathon", null);
const sampleN = Math.max(0, Number(option("n", "0")) || 0);

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node scripts/artifact_audit.mjs [--event=event_...] [--hackathon=event_...] [--n=10] [--json] [--strict] [--persist]",
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
const githubToken = process.env.GITHUB_TOKEN || fileEnv.GITHUB_TOKEN;
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

async function gh(pathname) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "arena-artifact-audit",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(60000) });
  const body = await res.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // keep null; caller records the status
  }
  return { status: res.status, json, text: body };
}

const text = (v) => (typeof v === "string" ? v.trim() : "");
const PLACEHOLDER_RE = /\b(TBD|TODO|lorem ipsum|placeholder)\b/i;
const IDEA_MIN = { title: 3, one_liner: 40, problem: 60, solution: 80, build_scope: 80 };

function auditIdea(idea) {
  const core = {
    title: text(idea.title).length >= IDEA_MIN.title,
    one_liner: text(idea.one_liner).length >= IDEA_MIN.one_liner,
    problem: text(idea.problem).length >= IDEA_MIN.problem,
    solution: text(idea.solution).length >= IDEA_MIN.solution,
    no_placeholder: ![idea.title, idea.one_liner, idea.problem, idea.solution, idea.build_scope].some((v) =>
      PLACEHOLDER_RE.test(text(v)),
    ),
    distinct: text(idea.problem) !== text(idea.solution),
  };
  const finalist = idea.status === "judged" || idea.status === "architecture_complete";
  const checks = { ...core };
  const notes = [];
  if (finalist) {
    checks.build_scope = text(idea.build_scope).length >= IDEA_MIN.build_scope;
  } else if (!text(idea.build_scope)) {
    notes.push("build_scope missing (not a finalist)");
  } else if (text(idea.build_scope).length < IDEA_MIN.build_scope) {
    notes.push(`build_scope short (${text(idea.build_scope).length} < ${IDEA_MIN.build_scope}; not a finalist)`);
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { id: idea.id, status: idea.status, pass: failed.length === 0, checks, failed, notes };
}

function auditCritique(row) {
  let parsed = null;
  const raw = text(row.content)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    parsed = JSON.parse(raw);
  } catch {
    // handled below
  }
  const checks = {
    content_json: !!parsed && typeof parsed === "object",
    strength: !!parsed && text(parsed.strength).length >= 40,
    weakness: !!parsed && text(parsed.weakness).length >= 40,
    suggestion: !!parsed && text(parsed.suggestion).length >= 40,
    distinct:
      !!parsed &&
      text(parsed.strength) !== text(parsed.weakness) &&
      text(parsed.weakness) !== text(parsed.suggestion) &&
      text(parsed.strength) !== text(parsed.suggestion),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    id: row.id,
    actor: row.actor_id,
    target: row.target_id,
    pass: failed.length === 0,
    checks,
    failed,
    notes: [],
  };
}

// Harness + scaffold + turn logs are not product work. This mirrors the
// allowlists in src/github/repos.ts and the NON_PRODUCT_PATHS in
// src/events/build-turns.ts; keep it in sync when the scaffold grows.
const NON_PRODUCT = new Set([
  "README.md",
  "AGENTS.md",
  "BACKLOG.md",
  "arena.config.json",
  ".gitignore",
  ".env.example",
  "opencode-turn.log",
  "opencode-turn.err.log",
  "VERIFICATION_REPORT.md",
  "VERIFICATION_NOTE.log",
  "VERIFICATION_FAILURE.log",
]);
const NON_PRODUCT_PREFIXES = [".github/", "docker/"];
const isProductPath = (p) => !NON_PRODUCT.has(p) && !NON_PRODUCT_PREFIXES.some((pre) => p.startsWith(pre));
const TEST_DIR_RE = /(^|\/)(test|tests|__tests__|spec)\//i;
const TEST_NAME_RE = /\.(test|spec)\.[jt]sx?$/i;
const PY_TEST_RE = /(^|\/)(test_.*\.py|.*_test\.py)$/i;

async function auditBuild(team) {
  const checks = {
    repo_present: false,
    turns_ran: Number(team.with_run) >= 1 && Number(team.with_sha) >= 1,
    product_work: false,
    has_test: false,
    has_verification_report: false,
    report_has_verdict: false,
  };
  const notes = [];
  let productFiles = [];
  let testFiles = [];
  let verdict = null;
  const failList = () => Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);

  if (!team.repo_url) {
    notes.push("repo_url is NULL (team formation did not finish)");
    return {
      team: team.team_name,
      repo: null,
      pass: false,
      checks,
      failed: failList(),
      notes,
      product_files: [],
      test_files: [],
      verdict,
    };
  }

  const info = await gh(`/repos/${team.repo_url}`);
  if (info.status !== 200) {
    notes.push(`repo info HTTP ${info.status}`);
    return {
      team: team.team_name,
      repo: team.repo_url,
      pass: false,
      checks,
      failed: failList(),
      notes,
      product_files: [],
      test_files: [],
      verdict,
    };
  }
  checks.repo_present = true;
  const branch = info.json?.default_branch || "main";
  const tree = await gh(`/repos/${team.repo_url}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (tree.status !== 200 || !Array.isArray(tree.json?.tree)) {
    notes.push(`tree HTTP ${tree.status}`);
    return {
      team: team.team_name,
      repo: team.repo_url,
      pass: false,
      checks,
      failed: failList(),
      notes,
      product_files: [],
      test_files: [],
      verdict,
    };
  }
  if (tree.json.truncated) notes.push("repo tree truncated; audit covered the returned entries only");

  const blobs = tree.json.tree.filter((e) => e.type === "blob").map((e) => e.path);
  productFiles = blobs.filter(isProductPath);
  testFiles = blobs.filter((p) => TEST_DIR_RE.test(p) || TEST_NAME_RE.test(p) || PY_TEST_RE.test(p));
  checks.product_work = productFiles.length > 0;
  checks.has_test = testFiles.length > 0;

  if (blobs.includes("VERIFICATION_REPORT.md")) {
    checks.has_verification_report = true;
    const report = await gh(`/repos/${team.repo_url}/contents/VERIFICATION_REPORT.md`);
    if (report.status === 200 && report.json?.content) {
      const content = Buffer.from(report.json.content, "base64").toString("utf8");
      const m = content.match(
        /(?:^|\n)\s*(?:#+\s*)?\*{0,2}Verdict\*{0,2}\s*:?\s*\*{0,2}\s*(READY|NOT READY)/i,
      );
      checks.report_has_verdict = !!m;
      verdict = m ? m[1].toUpperCase() : null;
      if (!m) notes.push("VERIFICATION_REPORT.md has no parseable Verdict line");
      else if (verdict === "NOT READY") notes.push("report verdict is NOT READY (honest output; not a contract failure)");
    } else {
      notes.push(`report content HTTP ${report.status}`);
    }
  } else {
    notes.push("VERIFICATION_REPORT.md is missing");
  }

  const failed = failList();
  return {
    team: team.team_name,
    repo: team.repo_url,
    pass: failed.length === 0,
    checks,
    failed,
    notes,
    product_files: productFiles,
    test_files: testFiles,
    verdict,
  };
}

/**
 * Compact, durable form of the audit. Full idea/critique text belongs in D1's
 * own tables; this keeps only the contract result so the row stays small and
 * `/events/:id` can show what failed without a second audit run.
 */
function compactResult(result) {
  const failures = {
    ideas: result.ideas
      .filter((i) => !i.pass)
      .map((i) => ({ id: i.id, status: i.status, failed: i.failed, notes: i.notes })),
    critiques: result.critiques
      .filter((c) => !c.pass)
      .map((c) => ({ id: c.id, actor: c.actor, target: c.target, failed: c.failed })),
    builds: result.builds
      .filter((b) => !b.pass)
      .map((b) => ({ team: b.team, repo: b.repo, failed: b.failed, notes: b.notes })),
  };
  return {
    generated_at: result.generated_at,
    ideathon: result.ideathon.id,
    hackathon: result.hackathon ? { id: result.hackathon.id, fallback: result.hackathon.fallback } : null,
    summary: result.summary,
    failures,
  };
}

async function persistRow(eventId, payload, failures, warnings) {
  await d1(
    `INSERT INTO event_quality (event_id, audit_json, audit_failures, audit_warnings, audited_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(event_id) DO UPDATE SET
       audit_json = excluded.audit_json,
       audit_failures = excluded.audit_failures,
       audit_warnings = excluded.audit_warnings,
       audited_at = excluded.audited_at`,
    [eventId, JSON.stringify(payload), failures, warnings],
  );
}

async function persistAudit(result) {
  const compact = compactResult(result);
  await persistRow(result.ideathon.id, compact, result.summary.failures, result.summary.warnings);

  if (result.hackathon) {
    const buildFailures = result.builds.filter((b) => !b.pass).length;
    const buildWarnings = result.builds.filter((b) =>
      b.notes.some((n) => !n.includes("not a contract failure")),
    ).length;
    await persistRow(
      result.hackathon.id,
      {
        generated_at: result.generated_at,
        ideathon: result.ideathon.id,
        hackathon: { id: result.hackathon.id, fallback: result.hackathon.fallback },
        summary: { builds: result.summary.builds, failures: buildFailures, warnings: buildWarnings },
        failures: { builds: compact.failures.builds },
      },
      buildFailures,
      buildWarnings,
    );
  }
}

async function main() {
  let event;
  if (eventArg) {
    const rows = await d1(`SELECT id, status, start_date FROM archive_events WHERE id = ?`, [eventArg]);
    event = rows[0];
  } else {
    const rows = await d1(
      `SELECT id, status, start_date FROM archive_events
       WHERE type = 'ideathon' AND status = 'judged'
       ORDER BY start_date DESC LIMIT 1`,
    );
    event = rows[0];
  }
  if (!event) throw new Error("No event found (pass --event=event_... or judge an ideathon first).");

  let hackathon = null;
  let fallback = false;
  if (hackathonArg) {
    const rows = await d1(
      `SELECT id, parent_event_id, status, start_date FROM archive_events WHERE id = ? AND type = 'hackathon'`,
      [hackathonArg],
    );
    hackathon = rows[0] ?? null;
    if (!hackathon) throw new Error(`No hackathon ${hackathonArg}`);
  } else {
    const child = await d1(
      `SELECT e.id, e.parent_event_id, e.status, e.start_date FROM archive_events e
       WHERE e.type = 'hackathon' AND e.parent_event_id = ? AND e.status = 'complete'
         AND EXISTS (SELECT 1 FROM hackathon_teams t WHERE t.event_id = e.id AND t.repo_url IS NOT NULL)
       ORDER BY e.start_date DESC LIMIT 1`,
      [event.id],
    );
    if (child.length) {
      hackathon = child[0];
    } else {
      const latest = await d1(
        `SELECT e.id, e.parent_event_id, e.status, e.start_date FROM archive_events e
         WHERE e.type = 'hackathon' AND e.status = 'complete'
           AND EXISTS (SELECT 1 FROM hackathon_teams t WHERE t.event_id = e.id AND t.repo_url IS NOT NULL)
         ORDER BY e.start_date DESC LIMIT 1`,
      );
      if (latest.length) {
        hackathon = latest[0];
        fallback = true;
      }
    }
  }

  const ideaPopulation = Number(
    (await d1(`SELECT COUNT(*) AS n FROM archive_ideas WHERE event_id = ?`, [event.id]))[0]?.n ?? 0,
  );
  const critiquePopulation = Number(
    (await d1(`SELECT COUNT(*) AS n FROM archive_interactions WHERE event_id = ? AND type = 'critique'`, [event.id]))[0]
      ?.n ?? 0,
  );

  const ideaSql =
    `SELECT id, status, title, one_liner, problem, solution, build_scope FROM archive_ideas WHERE event_id = ? ` +
    (sampleN > 0 ? `ORDER BY RANDOM() LIMIT ?` : `ORDER BY id`);
  const rawIdeas = await d1(ideaSql, sampleN > 0 ? [event.id, sampleN] : [event.id]);
  const ideas = rawIdeas.map(auditIdea);

  const critiqueSql =
    `SELECT id, actor_id, target_id, content FROM archive_interactions WHERE event_id = ? AND type = 'critique' ` +
    (sampleN > 0 ? `ORDER BY RANDOM() LIMIT ?` : `ORDER BY id`);
  const rawCritiques = await d1(critiqueSql, sampleN > 0 ? [event.id, sampleN] : [event.id]);
  const critiques = rawCritiques.map(auditCritique);

  let builds = [];
  if (hackathon) {
    const teams = await d1(
      `SELECT t.id, t.team_name, t.repo_url, t.status,
         COUNT(b.turn_id) AS turns,
         SUM(CASE WHEN b.run_id IS NOT NULL THEN 1 ELSE 0 END) AS with_run,
         SUM(CASE WHEN b.head_sha IS NOT NULL THEN 1 ELSE 0 END) AS with_sha
       FROM hackathon_teams t LEFT JOIN build_turns b ON b.team_id = t.id
       WHERE t.event_id = ? GROUP BY t.id ORDER BY t.team_name`,
      [hackathon.id],
    );
    builds = await Promise.all(teams.map(auditBuild));
  }

  const summary = {
    ideas: {
      population: ideaPopulation,
      sampled: ideas.length,
      passed: ideas.filter((i) => i.pass).length,
      failed: ideas.filter((i) => !i.pass).length,
      notes: ideas.filter((i) => i.pass && i.notes.length > 0).length,
    },
    critiques: {
      population: critiquePopulation,
      sampled: critiques.length,
      passed: critiques.filter((c) => c.pass).length,
      failed: critiques.filter((c) => !c.pass).length,
    },
    builds: {
      hackathon: hackathon?.id ?? null,
      fallback,
      total: builds.length,
      passed: builds.filter((b) => b.pass).length,
      failed: builds.filter((b) => !b.pass).length,
    },
    failures: 0,
    warnings: 0,
  };
  summary.failures = summary.ideas.failed + summary.critiques.failed + summary.builds.failed;
  summary.warnings =
    summary.ideas.notes + builds.filter((b) => b.notes.some((n) => !n.includes("not a contract failure"))).length;

  const result = {
    generated_at: new Date().toISOString(),
    ideathon: event,
    hackathon: hackathon ? { ...hackathon, fallback } : null,
    summary,
    ideas,
    critiques,
    builds,
  };

  if (persist) {
    await persistAudit(result);
  }

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Artifact audit");
    console.log(`Ideathon: ${event.id} (${event.status}, ${event.start_date})`);
    if (hackathon) {
      console.log(
        `Build cycle: ${hackathon.id} (${hackathon.status}, parent ${hackathon.parent_event_id})` +
          (fallback ? " — fallback: the selected ideathon's child produced no repos" : ""),
      );
    } else {
      console.log("Build cycle: none (no complete hackathon with repos)");
    }
    console.log(
      `Audited: ${ideas.length}/${ideaPopulation} ideas, ${critiques.length}/${critiquePopulation} critiques, ${builds.length} builds\n`,
    );

    console.log(`Ideas: ${summary.ideas.passed} pass, ${summary.ideas.failed} fail, ${summary.ideas.notes} note(s)`);
    for (const idea of ideas) {
      if (idea.pass && idea.notes.length === 0) continue;
      console.log(
        `  ${idea.pass ? "NOTE" : "FAIL"} ${idea.id} (${idea.status})` +
          (idea.failed.length ? `: ${idea.failed.join(", ")}` : "") +
          (idea.notes.length ? ` — ${idea.notes.join("; ")}` : ""),
      );
    }

    console.log(`\nCritiques: ${summary.critiques.passed} pass, ${summary.critiques.failed} fail`);
    for (const critique of critiques.filter((c) => !c.pass)) {
      console.log(`  FAIL ${critique.id} (${critique.actor} -> ${critique.target}): ${critique.failed.join(", ")}`);
    }

    console.log(`\nBuilds: ${summary.builds.passed} pass, ${summary.builds.failed} fail`);
    for (const build of builds) {
      console.log(
        `  ${build.pass ? "PASS" : "FAIL"} ${build.team} (${build.repo ?? "no repo"}) — ` +
          `${build.product_files.length} product files, ${build.test_files.length} test files` +
          (build.verdict ? `, verdict ${build.verdict}` : "") +
          (build.failed.length ? `; failed: ${build.failed.join(", ")}` : "") +
          (build.notes.length ? `; ${build.notes.join("; ")}` : ""),
      );
    }

    console.log(
      `\nSummary: ${summary.failures} contract failure(s), ${summary.warnings} note(s)` +
        ` across ${ideas.length + critiques.length + builds.length} audited artifacts.`,
    );
    if (persist) {
      console.log(
        `Persisted audit to event_quality for ${result.ideathon.id}` +
          (result.hackathon ? ` and ${result.hackathon.id}` : "") +
          ".",
      );
    }
  }

  if (persist && jsonOut) {
    console.error(
      `Persisted audit to event_quality for ${result.ideathon.id}` +
        (result.hackathon ? ` and ${result.hackathon.id}` : "") +
        ".",
    );
  }

  if (strict && summary.failures > 0) process.exitCode = 1;
}

await main();
