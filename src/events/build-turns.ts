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
