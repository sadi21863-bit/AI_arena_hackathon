/**
 * Event phase scheduler — spec §3.1 (ideathon), §3.2 (hackathon), §13
 * (judging), §14 (Tribunal). Decides what work is due and writes it to
 * event_queue; never calls an LLM (or GitHub API) itself, EXCEPT judge
 * calibration (see ensureIdeathonJudging below) which runs inline rather
 * than through the queue — a deliberate one-off exception, not a pattern
 * to repeat (ported split from ideaconnect's scheduler.ts / executor.ts).
 *
 * Ideathon phase boundaries are day-offsets from archive_events.start_date:
 *   Day 0-1 (elapsed): Deep Research
 *   Day 2:             Ideation + Critique
 *   Day 3-4:            Architecture (top 6 ideas by interaction signal)
 *   Day 5+:             ready_for_judging -> judged (Week 5, §13)
 *
 * Hackathon phase boundaries (spec §3.2, 3-day event):
 *   Day 0:   team_formation — create both team repos, dispatch each team's
 *            first build turn same day ("First build turns begin same day")
 *   Day 1-2: building — one additional build-turn dispatch per team per
 *            calendar day
 *   Day 3+:  ready_for_judging -> judged -> tribunal -> complete (Week 5)
 *
 * Past ready_for_judging, progression is STATUS-driven, not day-driven —
 * the day-offset formulas below have no further day boundaries and would
 * otherwise pin status at ready_for_judging forever (that was Week 3's
 * design, back when ready_for_judging really was terminal; Week 5 does
 * real work there now). See ensureIdeathonJudging / ensurePostBuildWork.
 */

import type { Env } from "../env";
import { AGENTS } from "../agents/personas";
import { runCalibration } from "../judges/calibration";
import { pickCrossExamineTarget } from "../tribunal/reflection";
import { queuedPayloadValues, payloadFieldCounts } from "./payload-utils";
import { enqueue } from "./queue";
import { pairwiseSimilarities } from "../agents/memory";
import { applyEventRatings } from "../agents/ratings";
import { reconcileBuildTurns, teamHasOpenTurn } from "./build-turns";
import { finalizeWithPartialScores } from "../judges/scoring";

/**
 * Ceiling on build turns per team per day. Turns are gated on the previous
 * one COMPLETING rather than on the calendar, so without a ceiling a turn
 * that fails in seconds would loop against the GitHub Actions quota. Spec
 * §3.2's shape (a few turns a day) is preserved; what changes is that a team
 * finishing early moves on instead of idling until midnight.
 */
const MAX_BUILD_TURNS_PER_DAY = 6;

/**
 * Attempt cap for stall prevention. Found live auditing production
 * (2026-07-30), two days before the autonomous cadence starts: every phase
 * below is self-healing per item, but the phase-COMPLETION checks
 * (ensureIdeathonJudging/ensureHackathonJudging waiting for every idea/team to
 * be judged; isStageComplete waiting for all 12 agents) all require every
 * item to eventually SUCCEED — there was no cap anywhere, just the existing
 * time-based backoff. A single permanently-malformed judge response or a
 * Workers-AI-only task type (Tribunal's `reflect`, no Groq fallback per
 * router.ts) hitting a real quota wall pins its event below judged/complete
 * forever, and since ensureArenaCadence's stillRunning guard checks exactly
 * that status, one stuck event silently stops every future Arena cycle too —
 * not just its own.
 *
 * 6, not something smaller: the existing 2-minute (judging) / 30-minute
 * (Tribunal) backoffs already absorb ordinary transient failures — this cap
 * only needs to catch a failure mode that repeats identically every retry,
 * so it can afford to be generous rather than fast.
 */
export const MAX_ITEM_ATTEMPTS = 6;

/**
 * All-time (not just recent, unlike the backoff checks above/below) failure
 * counts per payload key for one event+task_type, so the caller can tell a
 * genuinely permanent failure (count >= MAX_ITEM_ATTEMPTS) from an ordinary
 * one still within its backoff window.
 */
async function failedAttemptCounts(env: Env, eventId: string, taskType: string, field: string): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = ? AND status = 'failed'`
  ).bind(eventId, taskType).all<{ payload: string | null }>();
  return payloadFieldCounts(rows.results, field);
}

export type Phase = "deep_research" | "ideation_critique" | "collaboration" | "architecture" | "ready_for_judging" | "judged";
export type HackathonPhase = "team_formation" | "building" | "ready_for_judging" | "judged" | "tribunal" | "complete";

// N-1 (spec §4 collaboration, ARENA_BACKLOG.md): inserting a real day-bounded
// `collaboration` phase between ideation_critique and architecture extends
// the ideathon from 5 days to 6 (architecture shifts to day 4-5, judging to
// day 6+) rather than compressing architecture's existing 2-day window —
// a real, visible change to the event's actual timeline, not just an
// internal refactor. Flagged here since it's easy to miss reading the code
// alone.
export function phaseForDay(daysElapsed: number): Exclude<Phase, "judged"> {
  if (daysElapsed < 2) return "deep_research";
  if (daysElapsed < 3) return "ideation_critique";
  if (daysElapsed < 4) return "collaboration";
  if (daysElapsed < 6) return "architecture";
  return "ready_for_judging";
}

export function hackathonPhaseForDay(daysElapsed: number): Exclude<HackathonPhase, "judged" | "tribunal" | "complete"> {
  if (daysElapsed < 1) return "team_formation";
  if (daysElapsed < 3) return "building";
  return "ready_for_judging";
}

export interface EventRow {
  id: string;
  type: string;
  start_date: string;
  end_date: string | null;
  status: string;
  parent_event_id?: string | null;
}

function daysElapsed(startDate: string): number {
  const start = new Date(startDate.includes("T") ? startDate : startDate.replace(" ", "T") + "Z");
  return Math.floor((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Self-healing catchup — ported from ideaconnect's ensureDailyWorkQueued().
 * Idempotent: checks whether this phase's work for this event is already
 * queued or done before adding more, so a missed cron tick doesn't stall
 * the event and a double-fired tick doesn't duplicate work.
 */
/**
 * N-7: queue a narration of the phase that just ENDED.
 *
 * The outgoing phase is the one with a finished story; narrating the incoming
 * one would be describing something that has not happened yet.
 *
 * Queued rather than called inline so a slow or failing summarize call cannot
 * delay the transition it describes. Safe to call more than once: the handler
 * checks event_chronicle's UNIQUE(event_id, phase) before writing.
 */
async function chronicleTransition(env: Env, eventId: string, endedPhase: string): Promise<void> {
  if (!endedPhase) return;
  await enqueue(env, { eventId, taskType: "chronicle", payload: { phase: endedPhase }, priority: 8 });
}

export async function ensurePhaseWorkQueued(env: Env, event: EventRow): Promise<Phase | HackathonPhase> {
  if (event.type === "hackathon") return ensureHackathonWorkQueued(env, event);

  if (event.status === "judged") return "judged"; // terminal — day formula would otherwise re-pin ready_for_judging

  const phase = phaseForDay(daysElapsed(event.start_date));

  if (phase !== event.status) {
    await env.DB.prepare(`UPDATE archive_events SET status = ? WHERE id = ?`).bind(phase, event.id).run();
    await chronicleTransition(env, event.id, event.status);
  }

  if (phase === "ready_for_judging") {
    return ensureIdeathonJudging(env, event.id);
  }

  // Each queueX below is independently idempotent per-item (per-agent or
  // per-idea, filtering status != 'failed') rather than gated by one coarse
  // "does any item of this task_type exist for this event" check — found
  // live (2026-07-22 code review): that coarse check counted 'failed' rows
  // as "already covered," so a single permanently-failed item (one agent's
  // research, one idea's architecture, ...) silently and permanently
  // stalled that agent/idea with no visible error. This is the same fix
  // already applied to judge_idea/judge_team/Tribunal, backported here.
  switch (phase) {
    case "deep_research":
      await queueDeepResearch(env, event.id);
      break;
    case "ideation_critique":
      await queueIdeationAndCritique(env, event.id);
      break;
    case "collaboration":
      await queueCollaboration(env, event.id);
      break;
    case "architecture":
      await queueArchitecture(env, event.id);
      break;
  }
  return phase;
}

/**
 * Spec §13: judges evaluate all architecture_complete ideas; top 2 advance
 * (handleTeamFormation in executor.ts reads ideathon_score once this hits
 * 'judged'). Calibration (spec §13/§16: "before every event... if
 * inter-judge correlation falls below 0.6...") runs once per event, before
 * any real judging, inline rather than via the queue — it's a fixed,
 * bounded 21-call batch (7 judges x 3 anchors, parallelized in
 * calibration.ts) unlike the open-ended per-idea/per-agent work everything
 * else here queues.
 */
async function ensureIdeathonJudging(env: Env, eventId: string): Promise<"ready_for_judging" | "judged"> {
  const calibration = await env.DB.prepare(`SELECT passed FROM calibration_runs WHERE event_id = ?`).bind(eventId).first<{ passed: number }>();
  if (!calibration) {
    await runCalibration(env, eventId);
    return "ready_for_judging";
  }
  // calibration.passed is deliberately NOT a hard gate on judging — found
  // live (2026-07-22 code review) that it was computed and stored but never
  // actually read anywhere, silently defeating the spec §13/§16 intent.
  // Fixed to at least be VISIBLE (GET /events/:id surfaces it, index.ts) so
  // a human can act on spec's "adjust weights or provide clearer anchor
  // examples" — but not auto-blocking, since with no human reliably
  // watching a live event, a hard block risks permanently stalling a real
  // event over a single low-n (3 anchors) correlation dip, which is a worse
  // failure mode than proceeding with a flagged low-confidence judging pass.

  const architectureComplete = await env.DB.prepare(
    `SELECT id FROM archive_ideas WHERE event_id = ? AND status = 'architecture_complete'`
  ).bind(eventId).all<{ id: string }>();

  // Stall watchdog (MAX_ITEM_ATTEMPTS, see constant above): an idea whose
  // judging has failed this many times is treated as judged with whatever
  // judge_scores rows already exist, rather than blocking status='judged'
  // (and every future Arena cycle behind it) on a judge that will never
  // succeed. Checked before re-queuing below so an abandoned idea is neither
  // finalized-and-then-immediately-re-enqueued nor left stuck forever.
  const judgeFailureCounts = await failedAttemptCounts(env, eventId, "judge_idea", "ideaId");
  const unjudged: { id: string }[] = [];
  for (const idea of architectureComplete.results) {
    if ((judgeFailureCounts.get(idea.id) ?? 0) >= MAX_ITEM_ATTEMPTS) {
      const score = await finalizeWithPartialScores(env, { targetType: "idea", targetId: idea.id, phase: "ideathon" });
      await env.DB.prepare(`UPDATE archive_ideas SET ideathon_score = ?, status = 'judged' WHERE id = ?`).bind(score, idea.id).run();
    } else {
      unjudged.push(idea);
    }
  }

  if (unjudged.length === 0) {
    // Nothing left mid-judging (either all judged, or nothing ever reached
    // architecture_complete) — either way there's nothing more to queue.
    await env.DB.prepare(`UPDATE archive_events SET status = 'judged' WHERE id = ?`).bind(eventId).run();
    return "judged";
  }

  // Per-idea check (not a coarse "does judge_idea exist for this event"
  // count) so a FAILED judging attempt self-heals next tick instead of
  // silently stalling that idea forever — status != 'failed' means a
  // pending/in_progress/completed item for this idea already covers it.
  const existingJudgeItems = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'judge_idea' AND status != 'failed'`
  ).bind(eventId).all<{ payload: string | null }>();
  const alreadyQueued = queuedPayloadValues(existingJudgeItems.results, "ideaId");

  // Backoff — found live (2026-07-26, Week 7 closed beta): this had NO
  // backoff at all, unlike Tribunal's shouldEnqueueForAgent (2026-07-23
  // fix). Confirmed live: with Workers AI genuinely over its daily cap,
  // every tick re-queued and re-failed all 6 ideas x 7 judges, every 5
  // minutes, accumulating 1-8 failed attempts per idea/judge pair within
  // an hour with zero recovery — the exact same retry-storm pathology
  // already diagnosed for Tribunal, just never ported to ideathon judging
  // since this path hadn't been exercised at this intensity before.
  //
  // 2 minutes, not Tribunal's 30 — found live (2026-07-27): 30 min was
  // calibrated for genuine multi-hour daily-quota exhaustion (Tribunal's
  // actual failure mode), but judge_idea/judge_team failures are usually a
  // single transient blip (one judge's call, one bad response), not the
  // whole event being blocked for hours. The real cron only ticks every 5
  // minutes anyway, so anything shorter than that doesn't change
  // production retry cadence at all — this just needs to be longer than
  // aggressive manual test-tick cadence (the actual retry-storm trigger),
  // not longer than the real failure's recovery time.
  const recentJudgeFailures = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'judge_idea' AND status = 'failed' AND completed_at >= datetime('now', '-2 minutes')`
  ).bind(eventId).all<{ payload: string | null }>();
  const inBackoff = queuedPayloadValues(recentJudgeFailures.results, "ideaId");

  for (const idea of unjudged) {
    if (!alreadyQueued.has(idea.id) && !inBackoff.has(idea.id)) {
      await enqueue(env, { eventId, taskType: "judge_idea", payload: { ideaId: idea.id }, priority: 2 });
    }
  }
  return "ready_for_judging";
}

async function ensureHackathonWorkQueued(env: Env, event: EventRow): Promise<HackathonPhase> {
  if (event.status === "judged" || event.status === "tribunal" || event.status === "complete") {
    return ensurePostBuildWork(env, event);
  }

  const phase = hackathonPhaseForDay(daysElapsed(event.start_date));

  if (phase !== event.status) {
    await env.DB.prepare(`UPDATE archive_events SET status = ? WHERE id = ?`).bind(phase, event.id).run();
    // N-7 reached ideathons only: ensurePhaseWorkQueued returns to
    // ensureHackathonWorkQueued on its first line, so every chronicle enqueue
    // downstream of that was unreachable for a hackathon. The half of the
    // cycle with teams, a build and a winner was the half never narrated.
    await chronicleTransition(env, event.id, event.status);
  }

  if (phase === "team_formation") {
    // status != 'failed' — found live (2026-07-22 code review): without this
    // filter, a single failed team_formation attempt (e.g. a transient
    // GitHub 5xx during createTeamRepo) permanently stalls the whole
    // hackathon, since this coarse count would forever see the failed row
    // and never re-queue. handleTeamFormation itself is already idempotent
    // per-team (see its own header comment) — it just needs to actually
    // get re-invoked to use that.
    const existing = await env.DB.prepare(`SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND task_type = 'team_formation' AND status != 'failed'`)
      .bind(event.id).first<{ n: number }>();
    if ((existing?.n ?? 0) === 0) {
      // team_formation's executor handler also dispatches each team's
      // first build turn — "First build turns begin same day" (spec §3.2)
      // — so nothing else needs queuing here on formation day.
      await enqueue(env, { eventId: event.id, taskType: "team_formation", priority: 1 });
    }
  } else if (phase === "building") {
    // Pull CI outcomes first — everything below depends on knowing whether
    // the previous turn actually finished.
    await reconcileBuildTurns(env, event.id);

    const teams = await env.DB.prepare(`SELECT id, team_name FROM hackathon_teams WHERE event_id = ?`)
      .bind(event.id).all<{ id: string; team_name: string }>();

    // A team's next turn is gated on its previous turn COMPLETING, not on the
    // calendar rolling over. The old rule was one dispatch per team per UTC
    // day, which meant a turn finishing in ten minutes left the team idle for
    // the rest of the day — the agents were waiting on a date, not on work.
    // A per-day ceiling still applies so a fast-failing turn can't spin the
    // GitHub Actions quota, and the queue-level guard below keeps a dispatch
    // from being enqueued twice while one is still pending.
    const today = new Date().toISOString().slice(0, 10);
    const todaysDispatches = await env.DB.prepare(
      `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'dispatch_build_turn'
         AND date(created_at) = ? AND status != 'failed'`
    ).bind(event.id, today).all<{ payload: string | null }>();
    // payloadFieldCounts, NOT queuedPayloadValues. Found live 2026-08-01 in
    // production: queuedPayloadValues returns a SET, so iterating it yielded
    // each teamId exactly once and every team's "dispatches today" was
    // permanently 1. The ceiling could never be reached and the cap above has
    // never once fired.
    //
    // What that cost: the real hackathon dispatched 101+ turns per team in a
    // single day — one every 5 minutes, for ~14 hours — against a ceiling of
    // 6. Everything past turn ~22 came back `cancelled`, because
    // team-build-turn.yml's concurrency group only lets one run per team
    // proceed and GitHub cancels the superseded ones. So the guard whose
    // stated purpose was "a fast-failing turn can't spin the GitHub Actions
    // quota" was inert while precisely that happened.
    //
    // payload-utils.ts's own comment on countPayloadFieldMatches spells the
    // trap out — "a Set would collapse repeats, losing the count" — which is
    // exactly the mistake made here.
    const dispatchedTodayCount = payloadFieldCounts(todaysDispatches.results, "teamId");

    // Anything already queued but not yet executed — don't stack a second.
    const pending = await env.DB.prepare(
      `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'dispatch_build_turn'
         AND status IN ('pending', 'in_progress')`
    ).bind(event.id).all<{ payload: string | null }>();
    const alreadyQueued = queuedPayloadValues(pending.results, "teamId");

    // Generic stall cap (MAX_ITEM_ATTEMPTS): a dispatch that keeps failing
    // (persistent GitHub 5xx / rate limit) would otherwise re-enqueue every
    // tick forever. At the cap the team's turns stop being dispatched; its
    // next turn can still come from reconcile/evidence once the failure
    // clears, but the queue stops accumulating identical failures.
    const dispatchFailures = await failedAttemptCounts(env, event.id, "dispatch_build_turn", "teamId");

    for (const team of teams.results) {
      if (alreadyQueued.has(team.id)) continue;
      if ((dispatchedTodayCount.get(team.id) ?? 0) >= MAX_BUILD_TURNS_PER_DAY) continue;
      if ((dispatchFailures.get(team.id) ?? 0) >= MAX_ITEM_ATTEMPTS) continue;
      // Still working — let it finish rather than dispatching over the top.
      if (await teamHasOpenTurn(env, team.id)) continue;

      await enqueue(env, {
        eventId: event.id, taskType: "dispatch_build_turn",
        payload: { teamId: team.id, teamName: team.team_name },
        priority: 3,
      });
    }
  } else if (phase === "ready_for_judging") {
    return ensurePostBuildWork(env, { ...event, status: phase });
  }

  return phase;
}

/**
 * Everything past building: hackathon judging (spec §13, weighted 70% vs.
 * the ideathon's 30% per spec §3.2) -> Tribunal (spec §14, three stages,
 * each gated on the previous fully completing) -> complete. One function
 * driven entirely by event.status rather than day-offset, since none of
 * this has a fixed day boundary the way team_formation/building do.
 */
async function ensurePostBuildWork(env: Env, event: EventRow): Promise<HackathonPhase> {
  if (event.status === "complete") return "complete";

  if (event.status !== "judged" && event.status !== "tribunal") {
    await inheritJudgingPin(env, event);
    return ensureHackathonJudging(env, event.id);
  }

  if (event.status === "judged") {
    return ensureTribunalReflections(env, event);
  }

  return ensureTribunalCrossExamAndSynthesis(env, event);
}

/**
 * Carry the parent ideathon's pinned judging model onto the hackathon.
 *
 * P0-2 pins a judging model so a mid-event provider swap cannot mix model
 * families into one weighted ranking. That pin is written by runCalibration —
 * and runCalibration is only ever called from ensureIdeathonJudging, so a
 * hackathon has never had one. Found live 2026-08-01 on the first real
 * autonomous judging run: `judging_provider` was null on the hackathon, so
 * scoreTarget passed `pinned_provider: undefined` and every judge was free to
 * land on whatever tier the router picked. That run happened to stay on one
 * Groq model throughout, so nothing was corrupted — the guard was simply
 * absent for the phase that decides the winner.
 *
 * Inheriting rather than re-calibrating is deliberate. The parent ideathon
 * calibrated days earlier and pinned a model; the hackathon is the second half
 * of that same cycle, and P0-2's intent is one judge contract per cycle. A
 * fresh calibration would cost 21 LLM calls to re-derive an answer that
 * already exists, and could legitimately land on a DIFFERENT model — which is
 * the exact inconsistency the pin exists to prevent.
 *
 * No-ops when the hackathon already has a pin, or when the parent has none.
 */
async function inheritJudgingPin(env: Env, event: EventRow): Promise<void> {
  if (!event.parent_event_id) return;
  const self = await env.DB.prepare(`SELECT judging_provider FROM archive_events WHERE id = ?`)
    .bind(event.id).first<{ judging_provider: string | null }>();
  if (self?.judging_provider) return;

  const parent = await env.DB.prepare(`SELECT judging_provider, judging_model FROM archive_events WHERE id = ?`)
    .bind(event.parent_event_id).first<{ judging_provider: string | null; judging_model: string | null }>();
  if (!parent?.judging_provider) return;

  await env.DB.prepare(`UPDATE archive_events SET judging_provider = ?, judging_model = ? WHERE id = ?`)
    .bind(parent.judging_provider, parent.judging_model, event.id).run();
}

async function ensureHackathonJudging(env: Env, eventId: string): Promise<"ready_for_judging" | "judged"> {
  // Eligibility gate: a team whose turns never actually RAN cannot win,
  // however well its idea scored. executed_turns counts turns whose CI run
  // reached a real conclusion ('success' OR 'failure' — 'cancelled' runs
  // never executed, and a turn stuck at 'dispatched' with no run is a
  // dispatch fault, not team work). Zero executed turns means the team
  // produced nothing verifiable: every turn cancelled before running (the
  // 344-cancelled-turns shape), or wedged by a dispatch failure. Such a team
  // is finalized as judged with NULL scores — never scored, never in the
  // winner query (final_score IS NOT NULL below). A run that concludes
  // AFTER this finalization can't retroactively change eligibility; the
  // reconcile sweep (build-turns.ts) still records the truth for evidence.
  const teamsToJudge = await env.DB.prepare(
    `SELECT ht.id, ht.idea_id,
       (SELECT COUNT(*) FROM build_turns bt
         WHERE bt.team_id = ht.id AND bt.conclusion IN ('success','failure')) AS executed_turns
     FROM hackathon_teams ht WHERE ht.event_id = ? AND ht.status != 'judged'`
  ).bind(eventId).all<{ id: string; idea_id: string; executed_turns: number }>();

  // Stall watchdog (MAX_ITEM_ATTEMPTS) — same reasoning as
  // ensureIdeathonJudging above: a team whose judging has failed this many
  // times is finalized from whatever judge_scores rows already exist rather
  // than blocking status='judged' (and Tribunal, and every future Arena
  // cycle) on a judge that will never succeed. finalScore uses the same
  // ideathon 30% / hackathon 70% weights as handleJudgeTeam's success path
  // (executor.ts) — this only changes how the hackathon-side number was
  // obtained, not the blend.
  const judgeFailureCounts = await failedAttemptCounts(env, eventId, "judge_team", "teamId");
  const unjudged: { id: string; idea_id: string }[] = [];
  for (const team of teamsToJudge.results) {
    if (team.executed_turns === 0) {
      // Ineligible: never scored, never judged, cannot win (final_score
      // stays NULL, and the winner query below requires a non-null score).
      await env.DB.prepare(`UPDATE hackathon_teams SET status = 'judged' WHERE id = ?`).bind(team.id).run();
      continue;
    }
    if ((judgeFailureCounts.get(team.id) ?? 0) >= MAX_ITEM_ATTEMPTS) {
      const hackathonScore = await finalizeWithPartialScores(env, { targetType: "team", targetId: team.id, phase: "hackathon" });
      const idea = await env.DB.prepare(`SELECT ideathon_score FROM archive_ideas WHERE id = ?`).bind(team.idea_id).first<{ ideathon_score: number | null }>();
      const finalScore = (idea?.ideathon_score ?? 0) * 0.3 + hackathonScore * 0.7;
      await env.DB.prepare(`UPDATE hackathon_teams SET hackathon_score = ?, final_score = ?, status = 'judged' WHERE id = ?`)
        .bind(hackathonScore, finalScore, team.id).run();
    } else {
      unjudged.push(team);
    }
  }

  if (unjudged.length === 0) {
    // final_score IS NOT NULL: an ineligible team (finalized above with null
    // scores) must never be picked as winner. If NO team was eligible at
    // all, the winner stays null — an honest "this cycle produced no
    // buildable outcome" rather than crowning a team that never built.
    const winner = await env.DB.prepare(
      `SELECT id, idea_id FROM hackathon_teams WHERE event_id = ? AND final_score IS NOT NULL ORDER BY final_score DESC LIMIT 1`
    ).bind(eventId).first<{ id: string; idea_id: string }>();
    await env.DB.prepare(
      `UPDATE archive_events SET status = 'judged', winner_team_id = ?, winning_idea_id = ? WHERE id = ?`
    ).bind(winner?.id ?? null, winner?.idea_id ?? null, eventId).run();

    // N-5: rate the agents now that both sides have final scores. Guarded
    // against replay by its own marker (agents/ratings.ts), which matters
    // because this branch is reachable on any later tick — everything else
    // here is safely idempotent, Elo is not.
    // Also skipped when there's no winner at all: rating two zero-score
    // sides against each other would manufacture a draw from a non-event.
    if (winner?.id) {
      await applyEventRatings(env, eventId);
    }
    // The winner being decided is the single most narratable moment in a
    // cycle, and it was going unrecorded.
    await chronicleTransition(env, eventId, "ready_for_judging");
    return "judged";
  }

  const existingJudgeItems = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'judge_team' AND status != 'failed'`
  ).bind(eventId).all<{ payload: string | null }>();
  const alreadyQueued = queuedPayloadValues(existingJudgeItems.results, "teamId");

  // Same backoff fix as ensureIdeathonJudging above (found live 2026-07-26,
  // Week 7 closed beta) — judge_team had the identical no-backoff gap.
  // 2 minutes, not 30 — same reasoning as ensureIdeathonJudging's comment.
  const recentJudgeFailures = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'judge_team' AND status = 'failed' AND completed_at >= datetime('now', '-2 minutes')`
  ).bind(eventId).all<{ payload: string | null }>();
  const inBackoff = queuedPayloadValues(recentJudgeFailures.results, "teamId");

  for (const team of unjudged) {
    if (!alreadyQueued.has(team.id) && !inBackoff.has(team.id)) {
      await enqueue(env, { eventId, taskType: "judge_team", payload: { teamId: team.id }, priority: 2 });
    }
  }
  return "ready_for_judging";
}

async function ensureTribunalReflections(env: Env, event: EventRow): Promise<"judged" | "tribunal"> {
  for (const agent of AGENTS) {
    if (await shouldEnqueueForAgent(env, event.id, agent.id, "tribunal_reflect")) {
      await enqueue(env, { eventId: event.id, agentId: agent.id, taskType: "tribunal_reflect", priority: 4 });
    }
  }

  // isStageComplete, not a hand-rolled count — matches the pattern the
  // other two Tribunal stages already use below (2026-07-23 code-quality
  // pass: this stage was the odd one out).
  const reflectDone = await isStageComplete(env, event.id, "tribunal_reflect");
  if (!reflectDone) return "judged";

  await env.DB.prepare(`UPDATE archive_events SET status = 'tribunal' WHERE id = ?`).bind(event.id).run();
  return "tribunal";
}

/**
 * Restructured (2026-07-23, live bug found alongside isStageComplete's
 * fix above): the previous `if (!allQueued) { ...retry loop...; return }`
 * shape meant the per-agent retry loop stopped running entirely once every
 * agent had been queued AT LEAST ONCE — so a failed cross-examine or
 * synthesize item would never be retried at all once the initial batch of
 * 12 existed, a permanent stall via a different path than tribunal_
 * reflect's retry-storm (which at least kept retrying, just wastefully).
 * Now the self-healing per-agent loop always runs every tick (same
 * unconditional pattern as ensureIdeathonJudging/ensureHackathonJudging
 * above), and allCompleted alone decides whether to advance.
 */
async function ensureTribunalCrossExamAndSynthesis(env: Env, event: EventRow): Promise<"tribunal" | "complete"> {
  if (!event.parent_event_id) throw new Error(`Hackathon event ${event.id} missing parent_event_id for cross-examination target selection`);

  for (const agent of AGENTS) {
    if (await shouldEnqueueForAgent(env, event.id, agent.id, "tribunal_cross_examine")) {
      const target = await pickCrossExamineTarget(env, event.parent_event_id, agent.id);
      if (target) {
        await enqueue(env, { eventId: event.id, agentId: agent.id, taskType: "tribunal_cross_examine", payload: { targetAgentId: target }, priority: 4 });
      }
    }
  }

  const crossDone = await isStageComplete(env, event.id, "tribunal_cross_examine");
  if (!crossDone) return "tribunal";

  for (const agent of AGENTS) {
    if (await shouldEnqueueForAgent(env, event.id, agent.id, "tribunal_synthesize")) {
      await enqueue(env, { eventId: event.id, agentId: agent.id, taskType: "tribunal_synthesize", priority: 4 });
    }
  }
  const synthDone = await isStageComplete(env, event.id, "tribunal_synthesize");
  if (!synthDone) return "tribunal";

  await env.DB.prepare(`UPDATE archive_events SET status = 'complete' WHERE id = ?`).bind(event.id).run();
  await chronicleTransition(env, event.id, "tribunal");
  return "complete";
}

/**
 * Per-agent retry gate with backoff — enqueue only if there's no non-failed
 * item AND the most recent failure (if any) is older than the backoff
 * window. Found live (2026-07-23): tribunal_reflect routes to Workers AI
 * only (no Groq fallback, router.ts's "reflect" task type), so when Workers
 * AI's daily quota is exhausted every attempt fails instantly — retrying
 * every single 5-minute cron tick with no backoff produced 676 wasted
 * attempts (all the identical "used up your daily free allocation" error)
 * before quota finally reset. A 30-minute backoff cuts that ~6x without
 * meaningfully delaying real recovery once quota resets.
 */
async function shouldEnqueueForAgent(env: Env, eventId: string, agentId: string, taskType: string, backoffMinutes = 30): Promise<boolean> {
  const nonFailed = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND agent_id = ? AND task_type = ? AND status != 'failed'`
  ).bind(eventId, agentId, taskType).first<{ n: number }>();
  if ((nonFailed?.n ?? 0) > 0) return false; // already covered by a pending/in_progress/completed item

  // Stall watchdog (MAX_ITEM_ATTEMPTS) — an agent whose Tribunal item has
  // failed this many times (all-time, unlike the recency check below) is
  // permanently abandoned rather than retried forever. isStageComplete
  // (below) treats this same threshold as satisfying the stage for this
  // agent, so this doesn't reintroduce the stall it's meant to prevent —
  // it just stops the otherwise-endless 30-minute retry loop for an item
  // that isStageComplete has already decided not to keep waiting on.
  const totalFailures = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND agent_id = ? AND task_type = ? AND status = 'failed'`
  ).bind(eventId, agentId, taskType).first<{ n: number }>();
  if ((totalFailures?.n ?? 0) >= MAX_ITEM_ATTEMPTS) return false;

  const recentFailure = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND agent_id = ? AND task_type = ? AND status = 'failed' AND completed_at >= datetime('now', ?)`
  ).bind(eventId, agentId, taskType, `-${backoffMinutes} minutes`).first<{ n: number }>();
  return (recentFailure?.n ?? 0) === 0;
}

/**
 * Per-DISTINCT-AGENT completion, not a raw row count. Found live
 * (2026-07-23): `reflect` (Tribunal's task_type, router.ts) routes to
 * Workers AI only, no Groq fallback — when Workers AI's daily quota is
 * exhausted, every attempt fails instantly, and the per-agent retry-safety
 * fix (scheduler.ts, 2026-07-22) re-queues a fresh one every single 5-
 * minute cron tick. Over enough hours that piles up hundreds of failed
 * rows for the SAME already-eventually-successful agents. The original
 * `allCompleted = COUNT(status != 'completed') === 0` check counted that
 * entire failure history forever, permanently blocking the stage from
 * ever completing even once every agent genuinely had a completed item —
 * confirmed live: 676 accumulated failures blocked event_cd9644ef... at
 * status='judged' indefinitely despite all 12 tribunal_reflect agents
 * having succeeded. Counting DISTINCT agent_id with status='completed'
 * is immune to however much failed-retry history exists.
 *
 * Stall watchdog addition (2026-07-30, MAX_ITEM_ATTEMPTS): an agent whose
 * item has failed >= MAX_ITEM_ATTEMPTS times counts toward the threshold too,
 * same as a completed one, because shouldEnqueueForAgent stops retrying that
 * exact agent at that exact threshold — without this, such an agent would be
 * neither retried nor ever counted, permanently pinning the stage one agent
 * short of AGENTS.length. Tribunal reflections/cross-exams/syntheses have no
 * partial-credit concept the way judge scoring does (there's no separate
 * "whatever succeeded" table to fall back to) — advancing without that
 * agent's contribution, rather than never advancing, is the point.
 */
async function isStageComplete(env: Env, eventId: string, taskType: string): Promise<boolean> {
  const rows = await env.DB.prepare(
    `SELECT agent_id, status FROM event_queue WHERE event_id = ? AND task_type = ? AND agent_id IS NOT NULL`
  ).bind(eventId, taskType).all<{ agent_id: string; status: string }>();

  const completedAgents = new Set<string>();
  const failedCounts = new Map<string, number>();
  for (const row of rows.results) {
    if (row.status === "completed") completedAgents.add(row.agent_id);
    else if (row.status === "failed") failedCounts.set(row.agent_id, (failedCounts.get(row.agent_id) ?? 0) + 1);
  }

  let doneCount = 0;
  for (const agent of AGENTS) {
    if (completedAgents.has(agent.id) || (failedCounts.get(agent.id) ?? 0) >= MAX_ITEM_ATTEMPTS) doneCount++;
  }
  return doneCount >= AGENTS.length;
}

/** Non-failed count of a task_type queued for one agent in this event — the per-agent idempotency primitive used below. */
async function nonFailedCountForAgent(env: Env, eventId: string, agentId: string, taskType: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND agent_id = ? AND task_type = ? AND status != 'failed'`
  ).bind(eventId, agentId, taskType).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * All-time failed count of a task_type for one agent in this event.
 *
 * The generic stall cap: judging and Tribunal already have their own
 * MAX_ITEM_ATTEMPTS handling (failedAttemptCounts / shouldEnqueueForAgent),
 * but research/submit_idea/architecture re-queue a fresh item on every tick
 * after a failure (the queueX functions below only look at non-failed
 * counts), so a persistently-failing item — one agent's research hitting a
 * hard Tavily outage, an LLM that keeps returning malformed idea JSON —
 * retried forever, once per 5-minute tick, with no cap. Same pathology the
 * backlog diagnosed for judging, unguarded on every other phase. At
 * MAX_ITEM_ATTEMPTS the agent's slot is treated as abandoned for the
 * phase; the phase itself still completes when its day-boundary rolls over.
 */
async function failedCountForAgent(env: Env, eventId: string, agentId: string, taskType: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND agent_id = ? AND task_type = ? AND status = 'failed'`
  ).bind(eventId, agentId, taskType).first<{ n: number }>();
  return row?.n ?? 0;
}

async function queueDeepResearch(env: Env, eventId: string): Promise<void> {
  for (const agent of AGENTS) {
    if ((await nonFailedCountForAgent(env, eventId, agent.id, "research")) > 0) continue;
    // Generic stall cap (MAX_ITEM_ATTEMPTS): a research item that keeps
    // failing — a hard Tavily outage, a persisted 5xx — must not re-enqueue
    // every tick forever. At the cap the agent goes without research this
    // phase rather than the queue accumulating failures without bound.
    if ((await failedCountForAgent(env, eventId, agent.id, "research")) >= MAX_ITEM_ATTEMPTS) continue;
    await enqueue(env, {
      eventId, agentId: agent.id, taskType: "research",
      payload: { lens: agent.lens },
      priority: 7,
      scheduledFor: new Date(Date.now() + Math.random() * 9 * 60 * 1000), // spec §3.1 "stagger" precedent (ideaconnect) — spread across ~9 min
    });
  }
}

async function queueIdeationAndCritique(env: Env, eventId: string): Promise<void> {
  // Ideas first (max 3 each per spec §4) — critiques get queued once ideas
  // exist, by the executor after each idea completes (see executor.ts),
  // since critique targets need real idea IDs that don't exist yet here.
  // Per-agent top-up to 3, not a single "does one exist" check — an agent
  // whose 2nd submit_idea attempt failed should get a replacement queued
  // for just that slot, not be silently capped at whatever succeeded.
  for (const agent of AGENTS) {
    // Same generic stall cap as queueDeepResearch: a submit_idea item whose
    // LLM call keeps failing (persistent quota, malformed JSON) retried
    // once per tick forever otherwise — at the cap the agent simply ends
    // the phase with the ideas it has.
    if ((await failedCountForAgent(env, eventId, agent.id, "submit_idea")) >= MAX_ITEM_ATTEMPTS) continue;
    const existing = await nonFailedCountForAgent(env, eventId, agent.id, "submit_idea");
    for (let i = existing; i < 3; i++) {
      await enqueue(env, {
        eventId, agentId: agent.id, taskType: "submit_idea",
        priority: 6,
        scheduledFor: new Date(Date.now() + Math.random() * 5 * 60 * 1000),
      });
    }
  }
}

// Threshold calibrated live 2026-07-28 against the same real Vectorize
// embeddings used for P0-0b's duplicate filter (see
// docs/INVESTIGATION_2026-07-28.md NEW-2): genuinely different ideas scored
// 0.586-0.742 cosine similarity; the same idea reworded scored 0.946-0.974;
// identical resubmission scored 0.990. executor.ts's DUPLICATE_SIMILARITY_
// THRESHOLD (0.90) rejects the reworded/identical band as "same idea, not
// a collaboration." COLLABORATION_SIMILARITY_FLOOR sits just above the
// highest measured "different" pair (0.742) — real ideas above this floor
// are more related than anything confirmed unrelated so far, even though
// the upper part of this band (0.75-0.90) hasn't had a real example pair
// fall into it yet and should be re-calibrated from real accept/refuse
// outcomes once this phase has run against a few live events.
const COLLABORATION_SIMILARITY_FLOOR = 0.75;
const COLLABORATION_SIMILARITY_CEILING = 0.90; // matches executor.ts's duplicate cutoff — same-idea pairs go through P0-0b's filter, not this one

/**
 * N-1 (spec §4 collaboration): proposes merging idea pairs that are related
 * enough to be worth combining without being the same idea (that's P0-0b's
 * job, at team-selection time). Self-healing per-pair, same pattern as
 * ensureIdeathonJudging above — runs every tick during the `collaboration`
 * phase, but a pair with a non-failed `propose_collaboration` item already
 * queued is skipped, so re-running doesn't duplicate proposals. Bounded to
 * the top 5 (or fewer, for small events) qualifying pairs per event rather
 * than proposing on every qualifying pair, so a tightly-clustered event
 * doesn't spam every agent with simultaneous proposals.
 */
async function queueCollaboration(env: Env, eventId: string): Promise<void> {
  // Only ideas still independently eligible — already-merged ideas (either
  // side of a prior merge) are excluded from further pairing. ORDER BY
  // created_at: pairwiseSimilarities preserves input order into {a, b}, and
  // executor.ts's handleProposeCollaboration treats `a` as the earlier
  // (proposing/primary-if-merged) idea — this ordering is what makes that
  // assumption hold, not an arbitrary convenience.
  const ideas = await env.DB.prepare(
    `SELECT id, agent_id FROM archive_ideas WHERE event_id = ? AND status != 'merged' AND co_agent_id IS NULL ORDER BY created_at ASC`
  ).bind(eventId).all<{ id: string; agent_id: string }>();
  if (ideas.results.length < 2) return;

  const existingProposals = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'propose_collaboration' AND status != 'failed'`
  ).bind(eventId).all<{ payload: string | null }>();
  const alreadyCovered = new Set([
    ...queuedPayloadValues(existingProposals.results, "ideaA"),
    ...queuedPayloadValues(existingProposals.results, "ideaB"),
  ]);

  // Generic stall cap (MAX_ITEM_ATTEMPTS): a pair whose proposal keeps
  // failing (one side's LLM call persistently down, malformed decision
  // JSON) would otherwise be re-proposed on every tick of the 1-day
  // collaboration phase — ~288 identical failed rows. Failed counts are
  // merged across both fields since a pair is re-proposed when EITHER side
  // is eligible again.
  const [proposalFailA, proposalFailB] = await Promise.all([
    failedAttemptCounts(env, eventId, "propose_collaboration", "ideaA"),
    failedAttemptCounts(env, eventId, "propose_collaboration", "ideaB"),
  ]);
  const proposalFailures = new Map<string, number>();
  for (const [id, n] of proposalFailA) proposalFailures.set(id, n);
  for (const [id, n] of proposalFailB) proposalFailures.set(id, (proposalFailures.get(id) ?? 0) + n);

  const eligible = ideas.results
    .filter((i) => !alreadyCovered.has(i.id))
    .filter((i) => (proposalFailures.get(i.id) ?? 0) < MAX_ITEM_ATTEMPTS);
  if (eligible.length < 2) return;
  const agentOf = new Map(eligible.map((i) => [i.id, i.agent_id]));

  const ideaIds = eligible.map((i) => i.id);
  const pairs = await pairwiseSimilarities(env, ideaIds);
  // Same-agent pairs excluded — found live checking this against event
  // e5415c58's real embeddings (docs/INVESTIGATION_2026-07-28.md): the
  // highest-scoring pairs in this exact band were an agent's OWN
  // near-duplicate ideas (e.g. gale's ForensicLens/ForensicForge, 0.895),
  // not a genuine cross-agent overlap — "collaboration" between an agent
  // and itself isn't a coherent proposal. Real duplicate-batch problem is
  // NEW-2's upstream ideation-diversity gap, not this phase's job to fix.
  const qualifying = pairs
    .filter((p) => agentOf.get(p.a) !== agentOf.get(p.b))
    .filter((p) => p.score >= COLLABORATION_SIMILARITY_FLOOR && p.score < COLLABORATION_SIMILARITY_CEILING)
    .sort((a, b) => b.score - a.score);

  const maxProposals = Math.min(5, Math.floor(ideaIds.length / 6));
  const usedThisPass = new Set<string>(); // each idea in at most one NEW proposal this pass
  let queued = 0;

  for (const pair of qualifying) {
    if (queued >= maxProposals) break;
    if (usedThisPass.has(pair.a) || usedThisPass.has(pair.b)) continue;

    await enqueue(env, {
      eventId, taskType: "propose_collaboration",
      payload: { ideaA: pair.a, ideaB: pair.b, score: pair.score },
      priority: 6,
    });
    usedThisPass.add(pair.a);
    usedThisPass.add(pair.b);
    queued++;
  }
}

async function queueArchitecture(env: Env, eventId: string): Promise<void> {
  // "Top 6 ideas" (spec §3.1) — ranked by critique count as a proxy signal.
  // This one stays a proxy even after Week 5: architecture happens Day 3-4,
  // BEFORE judging (Day 5+) even exists, so there's no real judge score
  // available yet at this point in the event to rank by.
  // status != 'merged' — N-1 (spec §4 collaboration): a merged-away idea
  // (the non-primary side of an accepted collaboration, collaboration
  // phase above) shouldn't compete for an architecture slot as a separate
  // idea; the primary idea it merged into already carries both agent_ids
  // forward via co_agent_id.
  const top = await env.DB.prepare(
    `SELECT i.id, i.agent_id, COUNT(x.id) as critique_count
     FROM archive_ideas i LEFT JOIN archive_interactions x
       ON x.target_id = i.id AND x.type = 'critique'
     WHERE i.event_id = ? AND i.status != 'merged'
     GROUP BY i.id
     ORDER BY critique_count DESC
     LIMIT 6`
  ).bind(eventId).all<{ id: string; agent_id: string; critique_count: number }>();

  const existingArchItems = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'architecture' AND status != 'failed'`
  ).bind(eventId).all<{ payload: string | null }>();
  const alreadyQueued = queuedPayloadValues(existingArchItems.results, "ideaId");

  // Generic stall cap (MAX_ITEM_ATTEMPTS): an architecture call that keeps
  // failing must not be re-enqueued every tick for the whole phase. At the
  // cap the idea stays at 'submitted' — it simply doesn't advance to
  // architecture_complete, so it also doesn't get judged (judging only
  // looks at architecture_complete ideas). That's the honest outcome for
  // an idea the system couldn't build a plan for, rather than an endless
  // failure queue.
  const archFailures = await failedAttemptCounts(env, eventId, "architecture", "ideaId");

  for (const idea of top.results) {
    if (alreadyQueued.has(idea.id)) continue;
    if ((archFailures.get(idea.id) ?? 0) >= MAX_ITEM_ATTEMPTS) continue;
    await enqueue(env, {
      eventId, agentId: idea.agent_id, taskType: "architecture",
      payload: { ideaId: idea.id },
      priority: 5,
    });
  }
}

/**
 * Shared with POST /admin/events (index.ts) so there's one place that knows
 * how to insert an archive_events row -- extracted here rather than left
 * duplicated once ensureArenaCadence below needed to create events itself.
 */
export async function createEvent(env: Env, type: "ideathon" | "hackathon", parentEventId: string | null): Promise<string> {
  const id = `event_${crypto.randomUUID()}`;
  const initialStatus = type === "hackathon" ? "team_formation" : "deep_research";
  await env.DB.prepare(
    `INSERT INTO archive_events (id, type, start_date, status, parent_event_id, created_at) VALUES (?, ?, datetime('now'), ?, ?, datetime('now'))`
  ).bind(id, type, initialStatus, parentEventId).run();
  return id;
}

// Designated cadence (2026-07-29, user instruction): 3 Arenas per month --
// 30 days / 3 = fixed 10-day rolling slots from this anchor, not "1st/11th/
// 21st of calendar month" labels, which drift on 28/29/31-day months. Rolling
// fixed-interval slots from a single anchor stay exactly 10 days apart
// forever with no month-boundary edge cases. Each cycle's own day-gated
// phases (6-day ideathon + 3-day hackathon = 9 days) plus judging/Tribunal
// processing time eat nearly all of that 10-day slot -- there's very little
// real slack, so expect occasional compression toward zero break rather
// than a guaranteed rest period, if a cycle retries or backs off.
// ARENA_CADENCE_FIRST_START is deliberately in the past relative to any
// ideathon that starts before it -- computeNextArenaStart clamps up to it,
// it's a floor, not a delay.
const ARENA_CADENCE_FIRST_START = Date.UTC(2026, 7, 1); // month is 0-indexed: 7 = August
const ARENA_CADENCE_SLOT_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

/**
 * Next 10-day slot on/after `latestIdeathonStartDate`, floored at
 * ARENA_CADENCE_FIRST_START -- so the very first autonomous cycle lands
 * exactly on 2026-08-01 regardless of what day the last (possibly
 * pre-autonomy) ideathon started on, and every cycle after that falls on
 * a slot exactly 10 days after the previous one's own slot (Aug 1, 11, 21,
 * 31, Sep 10, 20, 30, Oct 10, ...).
 */
export function computeNextArenaStart(latestIdeathonStartDate: string): Date {
  const latest = new Date(latestIdeathonStartDate.replace(" ", "T") + "Z");
  if (latest.getTime() < ARENA_CADENCE_FIRST_START) return new Date(ARENA_CADENCE_FIRST_START);
  const slotsSinceAnchor = Math.floor((latest.getTime() - ARENA_CADENCE_FIRST_START) / ARENA_CADENCE_SLOT_MS) + 1;
  return new Date(ARENA_CADENCE_FIRST_START + slotsSinceAnchor * ARENA_CADENCE_SLOT_MS);
}

/**
 * Spec §1: "The Arena is a monthly autonomous AI competition." Everything
 * above this point drives an event that already exists -- nothing actually
 * created the NEXT one automatically. Found live (2026-07-29) checking
 * production: both real judged ideathons only got a hackathon because one
 * was POSTed manually each time; nothing ever auto-starts the next ideathon
 * either. This closes both gaps:
 *
 *   1. A judged ideathon with no hackathon yet gets one auto-created. From
 *      there, ensureHackathonWorkQueued (above) already drives team
 *      formation -> building -> judging -> Tribunal -> complete on its own,
 *      so this is the only missing link on that side.
 *   2. Once the latest cycle's ideathon AND its hackathon are both done,
 *      the next ideathon auto-starts -- but not the instant the hackathon
 *      completes. It's gated on the calendar reaching computeNextArenaStart
 *      (see above), so cadence stays anchored to fixed 10-day slots (3
 *      Arenas/month) instead of chaining cycles back-to-back whenever one
 *      happens to finish early. If a cycle overruns past its own next slot,
 *      the next one starts on the very next tick once it's done, rather
 *      than waiting out an entire extra slot.
 *
 * Called once per cron tick from index.ts's scheduled(), alongside (not
 * instead of) the per-event ensurePhaseWorkQueued/processQueue loop that
 * drives whatever's already running -- this function only ever decides
 * whether a NEW event needs to exist yet.
 */
export async function ensureArenaCadence(env: Env): Promise<void> {
  const judgedNoHackathon = await env.DB.prepare(
    `SELECT id FROM archive_events e WHERE e.type = 'ideathon' AND e.status = 'judged'
       AND NOT EXISTS (SELECT 1 FROM archive_events h WHERE h.parent_event_id = e.id)`
  ).all<{ id: string }>();
  for (const ideathon of judgedNoHackathon.results) {
    await createEvent(env, "hackathon", ideathon.id);
  }

  const latest = await env.DB.prepare(
    `SELECT id, start_date FROM archive_events WHERE type = 'ideathon' ORDER BY start_date DESC LIMIT 1`
  ).first<{ id: string; start_date: string }>();

  if (!latest) {
    await createEvent(env, "ideathon", null); // bootstrap: no Arena has ever run
    return;
  }

  // abandoned_at IS NULL on both clauses: checkForStalledEvents (below) is
  // the last-resort backstop for a stall MAX_ITEM_ATTEMPTS didn't anticipate
  // — without excluding it here, an abandoned event whose status never
  // reaches judged/complete would keep this returning early forever, which
  // is exactly the failure mode both mechanisms exist to prevent.
  const stillRunning = await env.DB.prepare(
    `SELECT 1 FROM archive_events WHERE (id = ? AND status != 'judged' AND abandoned_at IS NULL)
        OR (parent_event_id = ? AND status != 'complete' AND abandoned_at IS NULL)`
  ).bind(latest.id, latest.id).first();
  if (stillRunning) return;

  if (Date.now() >= computeNextArenaStart(latest.start_date).getTime()) {
    await createEvent(env, "ideathon", null);
  }
}

// Generous on purpose: MAX_ITEM_ATTEMPTS above already closes the two known
// infinite-stall causes (judging, Tribunal). This is the backstop for a stall
// shaped some OTHER way — team_formation wedged, a phase handler throwing on
// every tick before it reaches the queue, anything not anticipated here — so
// it needs to outlast legitimate slow recovery (a Workers AI daily quota
// exhaustion can take most of a day to clear) rather than fire fast. Getting
// this wrong in the aggressive direction — abandoning an event that would
// have recovered on its own — is worse than a slow safety net, since
// abandonment has no undo.
const STALL_ABANDON_HOURS = 25;

/**
 * Marks an event abandoned once it's gone STALL_ABANDON_HOURS with zero real
 * progress (last_progress_at, touched only by queue.ts's markCompleted on an
 * actual success — see its comment). Deliberately does not try to route
 * around whatever's actually stuck; it just stops that ONE event from
 * blocking every future Arena cycle behind it (ensureArenaCadence's
 * stillRunning check above), which is the actual harm a silent stall causes.
 * Called once per cron tick from index.ts's scheduled(), same as
 * ensureArenaCadence.
 */
export async function checkForStalledEvents(env: Env): Promise<void> {
  const active = await env.DB.prepare(
    `SELECT id, status, created_at, last_progress_at FROM archive_events
     WHERE abandoned_at IS NULL
       AND ((type = 'ideathon' AND status != 'judged') OR (type = 'hackathon' AND status != 'complete'))`
  ).all<{ id: string; status: string; created_at: string; last_progress_at: string | null }>();

  for (const event of active.results) {
    const reference = event.last_progress_at ?? event.created_at;
    const staleSince = new Date(reference.includes("T") ? reference : reference.replace(" ", "T") + "Z");
    const hoursStale = (Date.now() - staleSince.getTime()) / (60 * 60 * 1000);
    if (hoursStale < STALL_ABANDON_HOURS) continue;

    await env.DB.prepare(
      `UPDATE archive_events SET abandoned_at = datetime('now'), abandoned_reason = ? WHERE id = ?`
    ).bind(`No progress for over ${STALL_ABANDON_HOURS}h — stuck at status '${event.status}'`, event.id).run();
  }
}
