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

/**
 * Deterministic semantic-lite checks (R-3, 2026-10-31). These are not an LLM
 * quality score and they do not fail `--strict`; they surface the failure shapes
 * the structural checks cannot see: duplicate ideas, thin/empty code, tests with
 * no assertions, and critiques pointing at nothing.
 *
 * Deliberately free: an LLM judge would spend the same inference budget the
 * event needs, and a single event's sample is too small to calibrate a new
 * quality score. These checks are a tripwire, not a verdict.
 */
const SEMANTIC_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "about",
  "your", "their", "they", "them", "will", "can", "could", "should", "would", "have",
  "has", "are", "was", "were", "its", "it's", "our", "you", "not", "but", "all", "any",
  "new", "using", "use", "via", "per", "one", "two", "more", "most", "less", "than",
  "then", "when", "where", "which", "who", "what", "how", "why", "while", "also",
]);

function semanticTokens(value) {
  return new Set(
    text(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !SEMANTIC_STOPWORDS.has(w)),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function semanticAudit(rawIdeas, rawCritiques, builds, allIdeaIds) {
  const nearDuplicates = [];
  for (let i = 0; i < rawIdeas.length; i += 1) {
    const a = rawIdeas[i];
    const aTokens = semanticTokens(`${text(a.title)} ${text(a.one_liner)}`);
    for (let j = i + 1; j < rawIdeas.length; j += 1) {
      const b = rawIdeas[j];
      const similarity = jaccard(aTokens, semanticTokens(`${text(b.title)} ${text(b.one_liner)}`));
      if (similarity >= 0.82) {
        nearDuplicates.push({
          a: a.id,
          b: b.id,
          titles: [text(a.title), text(b.title)],
          similarity: Math.round(similarity * 1000) / 1000,
        });
      }
    }
  }

  const ideaIds = allIdeaIds ?? new Set(rawIdeas.map((idea) => idea.id));
  const orphanCritiques = rawCritiques
    .filter((critique) => !ideaIds.has(critique.target_id))
    .map((critique) => ({ id: critique.id, target: critique.target_id }));

  const genericRe = /\b(revolutionary|seamless|game-changing|all-in-one|everything app|one app|world-class|cutting-edge)\b/i;
  const genericIdeas = rawIdeas
    .filter((idea) => genericRe.test(`${text(idea.title)} ${text(idea.one_liner)}`))
    .map((idea) => ({ id: idea.id, title: text(idea.title) }));

  // Deep Research is meant to feed ideation. A judged idea with no anchor means
  // the link is not visible in the stored artifact, even if the agent used
  // context internally. Historical events are all NULL (the prompt never asked
  // for the field until 2026-10-31), so this is a warning, not a failure.
  const unanchoredIdeas = rawIdeas
    .filter((idea) => idea.status === "judged" && !text(idea.research_anchor))
    .map((idea) => ({ id: idea.id, title: text(idea.title) }));

  const thinBuilds = builds
    .filter((build) => build.code?.thin)
    .map((build) => ({
      team: build.team,
      repo: build.repo,
      nonblank_lines: build.code.nonblank_lines,
      files_sampled: build.code.sampled,
    }));

  const unassertedTests = builds
    .filter((build) => build.test_files.length > 0 && (build.code?.assertion_hits ?? 0) === 0)
    .map((build) => ({ team: build.team, repo: build.repo, test_files: build.test_files.slice(0, 3) }));

  return {
    near_duplicate_pairs: nearDuplicates,
    orphan_critiques: orphanCritiques,
    generic_ideas: genericIdeas,
    unanchored_ideas: unanchoredIdeas,
    thin_builds: thinBuilds,
    unasserted_tests: unassertedTests,
    warnings:
      nearDuplicates.length +
      orphanCritiques.length +
      genericIdeas.length +
      unanchoredIdeas.length +
      thinBuilds.length +
      unassertedTests.length,
  };
}

async function fetchTextFile(repo, filePath) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await gh(`/repos/${repo}/contents/${encoded}`);
  if (res.status !== 200 || !res.json?.content) return null;
  return Buffer.from(res.json.content, "base64").toString("utf8");
}

async function fetchCodeStats(repo, productFiles, testFiles) {
  const code = {
    sampled: 0,
    nonblank_lines: 0,
    max_file_lines: 0,
    assertion_hits: 0,
    thin: false,
  };
  for (const filePath of productFiles.slice(0, 6)) {
    const content = await fetchTextFile(repo, filePath);
    if (!content) continue;
    const lines = content.split(/\r?\n/).filter((line) => line.trim()).length;
    code.sampled += 1;
    code.nonblank_lines += lines;
    code.max_file_lines = Math.max(code.max_file_lines, lines);
  }
  for (const filePath of testFiles.slice(0, 3)) {
    const content = await fetchTextFile(repo, filePath);
    if (!content) continue;
    code.assertion_hits += (content.match(/\b(assert|expect|should|test\s*\(|it\s*\(|describe\s*\()/g) ?? []).length;
  }
  code.thin = code.sampled > 0 && code.nonblank_lines < 30;
  return code;
}

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
  const emptyCode = () => ({ sampled: 0, nonblank_lines: 0, max_file_lines: 0, assertion_hits: 0, thin: false });
  let code = emptyCode();
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
      code,
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
      code,
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
      code,
      verdict,
    };
  }
  if (tree.json.truncated) notes.push("repo tree truncated; audit covered the returned entries only");

  const blobs = tree.json.tree.filter((e) => e.type === "blob").map((e) => e.path);
  productFiles = blobs.filter(isProductPath);
  testFiles = blobs.filter((p) => TEST_DIR_RE.test(p) || TEST_NAME_RE.test(p) || PY_TEST_RE.test(p));
  checks.product_work = productFiles.length > 0;
  checks.has_test = testFiles.length > 0;

  code = await fetchCodeStats(team.repo_url, productFiles, testFiles);
  if (code.thin) {
    notes.push(
      `product code is thin: ${code.nonblank_lines} nonblank lines across ${code.sampled} sampled file(s)`,
    );
  }
  if (testFiles.length > 0 && code.assertion_hits === 0) {
    notes.push("test files contain no assertion-like calls");
  }

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
    code,
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
    semantic: {
      near_duplicate_pairs: result.semantic.near_duplicate_pairs.slice(0, 10),
      orphan_critiques: result.semantic.orphan_critiques.slice(0, 10),
      generic_ideas: result.semantic.generic_ideas.slice(0, 10),
      unanchored_ideas: result.semantic.unanchored_ideas.slice(0, 10),
      thin_builds: result.semantic.thin_builds,
      unasserted_tests: result.semantic.unasserted_tests,
    },
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
        semantic: {
          thin_builds: result.semantic.thin_builds,
          unasserted_tests: result.semantic.unasserted_tests,
        },
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
  // Full id set for orphan-critique checks even when `--n` samples ideas.
  const allIdeaIds = new Set(
    (await d1(`SELECT id FROM archive_ideas WHERE event_id = ?`, [event.id])).map((row) => row.id),
  );
  const critiquePopulation = Number(
    (await d1(`SELECT COUNT(*) AS n FROM archive_interactions WHERE event_id = ? AND type = 'critique'`, [event.id]))[0]
      ?.n ?? 0,
  );

  const ideaSql =
    `SELECT id, status, title, one_liner, problem, solution, build_scope, research_anchor FROM archive_ideas WHERE event_id = ? ` +
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

  const semantic = semanticAudit(rawIdeas, rawCritiques, builds, allIdeaIds);

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
    semantic: {
      near_duplicate_pairs: semantic.near_duplicate_pairs.length,
      orphan_critiques: semantic.orphan_critiques.length,
      generic_ideas: semantic.generic_ideas.length,
      unanchored_ideas: semantic.unanchored_ideas.length,
      thin_builds: semantic.thin_builds.length,
      unasserted_tests: semantic.unasserted_tests.length,
      warnings: semantic.warnings,
    },
    failures: 0,
    warnings: 0,
  };
  summary.failures = summary.ideas.failed + summary.critiques.failed + summary.builds.failed;
  summary.warnings =
    summary.ideas.notes +
    builds.filter((b) => b.notes.some((n) => !n.includes("not a contract failure"))).length +
    semantic.warnings;

  const result = {
    generated_at: new Date().toISOString(),
    ideathon: event,
    hackathon: hackathon ? { ...hackathon, fallback } : null,
    summary,
    ideas,
    critiques,
    builds,
    semantic,
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
          `${build.product_files.length} product files, ${build.test_files.length} test files, ` +
          `${build.code?.nonblank_lines ?? 0} nonblank lines` +
          (build.verdict ? `, verdict ${build.verdict}` : "") +
          (build.failed.length ? `; failed: ${build.failed.join(", ")}` : "") +
          (build.notes.length ? `; ${build.notes.join("; ")}` : ""),
      );
    }

    console.log(
      `\nSemantic (warnings only): ${semantic.near_duplicate_pairs.length} near-duplicate idea pair(s), ` +
        `${semantic.orphan_critiques.length} orphan critique(s), ` +
        `${semantic.generic_ideas.length} generic-phrase idea(s), ` +
        `${semantic.unanchored_ideas.length} unanchored finalist(s), ` +
        `${semantic.thin_builds.length} thin build(s), ` +
        `${semantic.unasserted_tests.length} test set(s) without assertions`,
    );
    for (const pair of semantic.near_duplicate_pairs.slice(0, 5)) {
      console.log(
        `  NEAR-DUPLICATE ${pair.a} ~ ${pair.b} (${(pair.similarity * 100).toFixed(0)}%) ` +
          `"${pair.titles[0]}" / "${pair.titles[1]}"`,
      );
    }
    for (const critique of semantic.orphan_critiques.slice(0, 5)) {
      console.log(`  ORPHAN CRITIQUE ${critique.id} -> ${critique.target} (no matching idea in this event)`);
    }
    for (const idea of semantic.generic_ideas.slice(0, 5)) {
      console.log(`  GENERIC ${idea.id} "${idea.title}"`);
    }
    for (const idea of semantic.unanchored_ideas.slice(0, 5)) {
      console.log(`  UNANCHORED ${idea.id} "${idea.title}" (no research_anchor)`);
    }
    for (const build of semantic.thin_builds.slice(0, 5)) {
      console.log(
        `  THIN BUILD ${build.team} (${build.repo}): ${build.nonblank_lines} nonblank lines ` +
          `across ${build.files_sampled} sampled file(s)`,
      );
    }
    for (const build of semantic.unasserted_tests.slice(0, 5)) {
      console.log(`  NO ASSERTIONS ${build.team} (${build.repo}): ${build.test_files.join(", ")}`);
    }

    console.log(
      `\nSummary: ${summary.failures} contract failure(s), ${summary.warnings} note(s)/semantic warning(s)` +
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
