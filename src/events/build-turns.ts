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
import { listBuildTurnRuns, dispatchBuildTurn } from "../github/dispatch";
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

/**
 * Records the intent to run a turn before dispatching it (INSERT OR IGNORE —
 * a crash-retry of the same queue item must not double-record).
 *
 * Returns whether a NEW row was inserted. False means this turn was already
 * recorded by an earlier attempt — the caller must then verify whether the
 * run actually exists before re-dispatching (dispatchTurnIfNeeded), or skip
 * the dispatch entirely if it does.
 */
export async function recordBuildTurn(
  env: Env,
  input: { turnId: string; eventId: string; teamId: string; turnNumber: number }
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO build_turns (turn_id, event_id, team_id, turn_number, status)
     VALUES (?, ?, ?, ?, 'dispatched')`
  ).bind(input.turnId, input.eventId, input.teamId, input.turnNumber).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Dispatch a build turn, but never twice.
 *
 * A queue-item retry (crash after a successful dispatch, or a dispatch that
 * timed out after GitHub accepted it) must not fire a second workflow run for
 * the same turn_id — that burned real inference spend and pushed conflicting
 * commits (found live, see the 2026-08-01 correction doc). Verifying against
 * the Actions API is reliable on retries: a run GitHub accepted appears in
 * the repo's run list within seconds, and a retry only ever happens >= 5-10
 * minutes later (markFailed/resetStuckItems timing).
 *
 * If the listing itself fails (rate limit, 5xx) the dispatch is attempted
 * anyway — a turn that never runs (which the 2-hour staleness sweep in
 * reconcileBuildTurns then marks failed, skipping the team) is worse than a
 * rare duplicate run.
 */
export async function dispatchTurnIfNeeded(
  env: Env,
  input: { repoFullName: string; team: "alpha" | "beta"; turnId: string; taskPrompt: string }
): Promise<boolean> {
  try {
    const runs = await listBuildTurnRuns(env, input.repoFullName, 20);
    if (runs.some((r) => r.name.includes(input.turnId))) return false; // run already exists — skip
  } catch {
    // fall through to dispatch below
  }
  await dispatchBuildTurn(env, input);
  return true;
}

/**
 * Pull CI outcomes for any turn that hasn't finished yet.
 *
 * Deliberately does nothing when there are no open turns, so the common case
 * (a settled or idle event) costs zero GitHub requests — this runs on every
 * cron tick and the token's rate limit is shared with team_formation.
 */
export async function reconcileBuildTurns(env: Env, eventId: string): Promise<number> {
  // 'failed' turns are excluded, not just 'completed': the staleness sweep
  // below marks a turn 'failed' when its run never materialized within 2
  // hours, and letting it keep claiming runs would let it positionally
  // steal a LATER turn's run (turns iterate oldest-first).
  const open = await env.DB.prepare(
    `SELECT t.turn_id, t.team_id, t.turn_number, ht.repo_url
     FROM build_turns t JOIN hackathon_teams ht ON ht.id = t.team_id
     WHERE t.event_id = ? AND t.status NOT IN ('completed', 'failed', 'cancelled')
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

  // Wedged-turn sweep: a turn stuck at 'dispatched' with no run ever
  // appearing — the dispatch 422'd silently, GitHub never created the run,
  // or listBuildTurnRuns failed on every tick (rate limit, repo breakage) —
  // keeps teamHasOpenTurn true forever, and since building gates new
  // dispatches on the previous turn completing, the team is wedged for the
  // rest of the event. 2 hours is generous: real turns ran in minutes.
  // 'queued'/'in_progress' runs are deliberately NOT swept — those have a
  // real run on GitHub's side and may still complete.
  const swept = await env.DB.prepare(
    `UPDATE build_turns SET status = 'failed', completed_at = datetime('now')
     WHERE event_id = ? AND status = 'dispatched' AND dispatched_at <= datetime('now', '-2 hours')`
  ).bind(eventId).run();
  updated += swept.meta.changes ?? 0;

  return updated;
}

/**
 * Has this team finished the turn it was last given?
 *
 * This is what lets building advance on real completion instead of waiting
 * for the next calendar day.
 *
 * 'failed'/'cancelled' turns are NOT open: a turn the staleness sweep marked
 * failed (run never materialized) or that GitHub cancelled before running
 * must not block the team's next dispatch — that was the wedge that froze a
 * team for the whole building phase (the 2-hour sweep only helps if this
 * check lets the team move on).
 */
export async function teamHasOpenTurn(env: Env, teamId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM build_turns WHERE team_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1`
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
