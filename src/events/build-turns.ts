/**
 * Build-turn bookkeeping — the record of what a hackathon turn actually did.
 *
 * Before this, dispatching a build turn left no trace: the queue item
 * completed the moment GitHub accepted the workflow_dispatch, so "the
 * hackathon is progressing" meant nothing more than "we asked CI to run
 * something". Whether the agent wrote a single line was never recorded, and
 * the CI outcome was read exactly once at judging time and thrown away.
 *
 * Correlation note: the Actions API cannot be queried by workflow_dispatch
 * input, so a dispatched turn can only be matched to its run by finding the
 * turn_id in the run title — which is why team-build-turn.yml sets
 * `run-name`. Team repos created before that change have no id in their run
 * titles; those turns reconcile positionally (oldest open turn to oldest
 * unclaimed run) and are marked so the difference stays visible.
 */

import type { Env } from "../env";
import { listBuildTurnRuns } from "../github/dispatch";
import { githubRequest } from "../github/client";

export interface BuildTurnRow {
  turn_id: string;
  event_id: string;
  team_id: string;
  turn_number: number;
  status: string;
  conclusion: string | null;
  run_url: string | null;
  head_sha: string | null;
  dispatched_at: string;
  completed_at: string | null;
}

export async function recordBuildTurn(
  env: Env,
  input: { turnId: string; eventId: string; teamId: string; turnNumber: number }
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO build_turns (turn_id, event_id, team_id, turn_number, status)
     VALUES (?, ?, ?, ?, 'dispatched')`
  ).bind(input.turnId, input.eventId, input.teamId, input.turnNumber).run();
}

/**
 * Pull CI outcomes for any turn that hasn't finished yet.
 *
 * Deliberately does nothing when there are no open turns, so the common case
 * (a settled or idle event) costs zero GitHub requests — this runs on every
 * cron tick and the token's rate limit is shared with team_formation.
 */
export async function reconcileBuildTurns(env: Env, eventId: string): Promise<number> {
  const open = await env.DB.prepare(
    `SELECT t.turn_id, t.team_id, t.turn_number, ht.repo_url
     FROM build_turns t JOIN hackathon_teams ht ON ht.id = t.team_id
     WHERE t.event_id = ? AND t.status != 'completed'
     ORDER BY t.turn_number ASC`
  ).bind(eventId).all<{ turn_id: string; team_id: string; turn_number: number; repo_url: string }>();

  if (open.results.length === 0) return 0;

  // One listing per repo, not per turn.
  const byRepo = new Map<string, typeof open.results>();
  for (const row of open.results) {
    if (!row.repo_url) continue;
    const list = byRepo.get(row.repo_url) ?? [];
    list.push(row);
    byRepo.set(row.repo_url, list);
  }

  let updated = 0;

  for (const [repo, turns] of byRepo) {
    let runs;
    try {
      runs = await listBuildTurnRuns(env, repo, 20);
    } catch {
      // A transient GitHub failure must not fail the tick — these turns stay
      // open and get picked up next time.
      continue;
    }

    const claimed = new Set<number>();

    for (const turn of turns) {
      let run = runs.find((r) => !claimed.has(r.runId) && r.name.includes(turn.turn_id));

      // Legacy repos: no turn_id in the title. Fall back to oldest-first
      // positional matching, which is right as long as turns are dispatched
      // in order (they are — one per team at a time).
      const matchedById = !!run;
      if (!run) {
        run = [...runs]
          .filter((r) => !claimed.has(r.runId))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      }
      if (!run) continue;

      claimed.add(run.runId);
      const done = run.status === "completed";

      await env.DB.prepare(
        `UPDATE build_turns
         SET run_id = ?, run_url = ?, status = ?, conclusion = ?, head_sha = ?,
             completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
             reconciled_at = datetime('now')
         WHERE turn_id = ?`
      ).bind(
        run.runId, run.htmlUrl,
        done ? "completed" : (matchedById ? run.status : "unmatched"),
        run.conclusion, run.headSha, done ? 1 : 0, turn.turn_id
      ).run();
      updated++;
    }
  }

  return updated;
}

/**
 * Has this team finished the turn it was last given?
 *
 * This is what lets building advance on real completion instead of waiting
 * for the next calendar day.
 */
export async function teamHasOpenTurn(env: Env, teamId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM build_turns WHERE team_id = ? AND status != 'completed' LIMIT 1`
  ).bind(teamId).first();
  return row !== null;
}

/** Turns that actually produced a successful run, per team. */
export async function successfulTurnCount(env: Env, teamId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM build_turns WHERE team_id = ? AND conclusion = 'success'`
  ).bind(teamId).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface BuildEvidence {
  turnsDispatched: number;
  turnsSucceeded: number;
  turnsFailed: number;
  turnsCancelled: number;
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  sourceFiles: number;
  hasTestSuite: boolean;
  /** True when the only thing the agent ever committed was its own turn log. */
  logOnly: boolean;
}

/** Files that exist because the scaffold or the workflow put them there, not because an agent built anything. */
const NON_PRODUCT_PATHS = [
  "opencode-turn.log",
  "opencode-turn.err.log",
  "README.md",
  ".github/workflows/team-build-turn.yml",
  "docker/Dockerfile.arena-team-base",
  "docker/opencode.json",
  "scripts/workers_ai_shim.js",
];

const TEST_FILE_PATTERN = /(^|\/)(test|tests|__tests__|spec)\//i;
const TEST_NAME_PATTERN = /\.(test|spec)\.[jt]sx?$/i;

/**
 * N-4 (docs/ARENA_BACKLOG.md): real, measured signal about what a team's
 * build actually produced, for the code-quality judge.
 *
 * handleJudgeTeam already passed CI success/fail counts — better grounding
 * than most systems bother with — but Reed scores "Code Quality" on
 * impression beyond that. Diff size, file counts and whether a test suite
 * exists are free, already available, and turn a fully subjective dimension
 * into a partly-measured one.
 *
 * Bounded to two GitHub calls regardless of how many turns a team took: list
 * the commits, then diff the first against the last in a single `compare`.
 * This runs inside judging, which is already the most subrequest-heavy task
 * in the queue (executor.ts's batch-limit comment), so it cannot be
 * per-commit.
 *
 * `logOnly` exists because of P0-0a: a turn that writes nothing but
 * `opencode-turn.log` still produces a commit and a green CI run, which is
 * exactly the false-success shape that made the closed beta look healthy
 * while both repos held zero product code. A judge told "3 successful build
 * turns" and nothing else would repeat that mistake.
 */
export async function collectBuildEvidence(env: Env, teamId: string, repoFullName: string): Promise<BuildEvidence> {
  // `cancelled` is counted explicitly, not folded into `failed` and not left
  // out. GitHub cancels a queued run when the concurrency group is already
  // occupied, which is a different fact from a turn that ran and failed — but
  // omitting it is worse than either: this event has 344 cancelled turns, and
  // reporting "347 dispatched, 3 succeeded, 0 failed" would leave the judge to
  // assume 344 are still pending. Found by pre-flighting the evidence before
  // the first live judging run.
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS dispatched,
            SUM(CASE WHEN conclusion = 'success' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN conclusion = 'failure' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN conclusion = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM build_turns WHERE team_id = ?`
  ).bind(teamId).first<{ dispatched: number; succeeded: number | null; failed: number | null; cancelled: number | null }>();

  const evidence: BuildEvidence = {
    turnsDispatched: counts?.dispatched ?? 0,
    turnsSucceeded: counts?.succeeded ?? 0,
    turnsFailed: counts?.failed ?? 0,
    turnsCancelled: counts?.cancelled ?? 0,
    commits: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    sourceFiles: 0,
    hasTestSuite: false,
    logOnly: false,
  };

  try {
    const commits = await githubRequest(env, "GET", `/repos/${repoFullName}/commits?per_page=100`);
    if (!Array.isArray(commits) || commits.length === 0) return evidence;
    evidence.commits = commits.length;

    // commits[0] is newest; the scaffold commit is oldest. Comparing oldest
    // against newest yields everything the agents added on top of the
    // scaffold in one request.
    const base = commits[commits.length - 1]?.sha;
    const head = commits[0]?.sha;
    if (!base || !head || base === head) return evidence;

    const diff = await githubRequest(env, "GET", `/repos/${repoFullName}/compare/${base}...${head}`);
    const files: Array<{ filename: string; additions?: number; deletions?: number }> = diff?.files ?? [];

    evidence.filesChanged = files.length;
    evidence.additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
    evidence.deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);

    const productFiles = files.filter((f) => !NON_PRODUCT_PATHS.includes(f.filename));
    evidence.sourceFiles = productFiles.length;
    evidence.hasTestSuite = productFiles.some(
      (f) => TEST_FILE_PATTERN.test(f.filename) || TEST_NAME_PATTERN.test(f.filename)
    );
    evidence.logOnly = files.length > 0 && productFiles.length === 0;
  } catch {
    // Judging must not fail because the repo is unreachable or the token is
    // rate-limited — the caller falls back to the CI-counts-only summary it
    // used before this existed.
    return evidence;
  }

  return evidence;
}

/** One line a judge prompt can consume, from the evidence above. */
export function describeBuildEvidence(e: BuildEvidence): string {
  const lines = [
    `Build turns: ${e.turnsDispatched} dispatched, ${e.turnsSucceeded} succeeded, ${e.turnsFailed} failed` +
      (e.turnsCancelled ? `, ${e.turnsCancelled} cancelled before running` : "") + ".",
    // Said plainly, because the raw counts invite the wrong inference: a team
    // with 3 successes out of 347 looks catastrophic, when in fact only a
    // handful of turns ever got to run and the rest were cancelled by a
    // scheduling fault on our side, not by anything the team did.
    ...(e.turnsCancelled > e.turnsSucceeded
      ? ["NOTE: most turns were cancelled before executing (a dispatch fault, not the team's doing) — judge the work that exists, not the turn count."]
      : []),
    `Commits: ${e.commits}. Files changed vs. scaffold: ${e.filesChanged} (+${e.additions}/-${e.deletions}).`,
    `Product source files (excluding scaffold and turn logs): ${e.sourceFiles}.`,
    `Automated test suite present: ${e.hasTestSuite ? "yes" : "no"}.`,
  ];
  if (e.logOnly) {
    lines.push(
      "WARNING: every committed file is scaffold or the agent's own turn log — no product code was written despite the runs above."
    );
  }
  return lines.join("\n");
}
