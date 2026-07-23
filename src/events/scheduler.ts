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
import { queuedPayloadValues } from "./payload-utils";
import { enqueue } from "./queue";

export type Phase = "deep_research" | "ideation_critique" | "architecture" | "ready_for_judging" | "judged";
export type HackathonPhase = "team_formation" | "building" | "ready_for_judging" | "judged" | "tribunal" | "complete";

export function phaseForDay(daysElapsed: number): Exclude<Phase, "judged"> {
  if (daysElapsed < 2) return "deep_research";
  if (daysElapsed < 3) return "ideation_critique";
  if (daysElapsed < 5) return "architecture";
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
export async function ensurePhaseWorkQueued(env: Env, event: EventRow): Promise<Phase | HackathonPhase> {
  if (event.type === "hackathon") return ensureHackathonWorkQueued(env, event);

  if (event.status === "judged") return "judged"; // terminal — day formula would otherwise re-pin ready_for_judging

  const phase = phaseForDay(daysElapsed(event.start_date));

  if (phase !== event.status) {
    await env.DB.prepare(`UPDATE archive_events SET status = ? WHERE id = ?`).bind(phase, event.id).run();
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

  const unjudged = await env.DB.prepare(
    `SELECT id FROM archive_ideas WHERE event_id = ? AND status = 'architecture_complete'`
  ).bind(eventId).all<{ id: string }>();

  if (unjudged.results.length === 0) {
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

  for (const idea of unjudged.results) {
    if (!alreadyQueued.has(idea.id)) {
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
    // One additional build-turn dispatch per team per calendar day —
    // idempotent per (team, day), not per-event-ever like the ideathon
    // phases, since building legitimately recurs daily.
    const today = new Date().toISOString().slice(0, 10);
    const teams = await env.DB.prepare(`SELECT id, team_name FROM hackathon_teams WHERE event_id = ?`)
      .bind(event.id).all<{ id: string; team_name: string }>();

    // status != 'failed' — found live (2026-07-22 code review): without
    // this, one failed dispatch attempt for a team today permanently skips
    // that team's build turn for the rest of the day instead of retrying.
    const todaysDispatches = await env.DB.prepare(
      `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'dispatch_build_turn' AND date(created_at) = ? AND status != 'failed'`
    ).bind(event.id, today).all<{ payload: string | null }>();
    const dispatchedToday = queuedPayloadValues(todaysDispatches.results, "teamId");

    for (const team of teams.results) {
      if (!dispatchedToday.has(team.id)) {
        await enqueue(env, {
          eventId: event.id, taskType: "dispatch_build_turn",
          payload: { teamId: team.id, teamName: team.team_name },
          priority: 3,
        });
      }
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
    return ensureHackathonJudging(env, event.id);
  }

  if (event.status === "judged") {
    return ensureTribunalReflections(env, event);
  }

  return ensureTribunalCrossExamAndSynthesis(env, event);
}

async function ensureHackathonJudging(env: Env, eventId: string): Promise<"ready_for_judging" | "judged"> {
  const unjudged = await env.DB.prepare(
    `SELECT id FROM hackathon_teams WHERE event_id = ? AND status != 'judged'`
  ).bind(eventId).all<{ id: string }>();

  if (unjudged.results.length === 0) {
    const winner = await env.DB.prepare(
      `SELECT id, idea_id FROM hackathon_teams WHERE event_id = ? ORDER BY final_score DESC LIMIT 1`
    ).bind(eventId).first<{ id: string; idea_id: string }>();
    await env.DB.prepare(
      `UPDATE archive_events SET status = 'judged', winner_team_id = ?, winning_idea_id = ? WHERE id = ?`
    ).bind(winner?.id ?? null, winner?.idea_id ?? null, eventId).run();
    return "judged";
  }

  const existingJudgeItems = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'judge_team' AND status != 'failed'`
  ).bind(eventId).all<{ payload: string | null }>();
  const alreadyQueued = queuedPayloadValues(existingJudgeItems.results, "teamId");

  for (const team of unjudged.results) {
    if (!alreadyQueued.has(team.id)) {
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
 */
async function isStageComplete(env: Env, eventId: string, taskType: string): Promise<boolean> {
  const completedAgents = await env.DB.prepare(
    `SELECT COUNT(DISTINCT agent_id) as n FROM event_queue WHERE event_id = ? AND task_type = ? AND status = 'completed'`
  ).bind(eventId, taskType).first<{ n: number }>();
  return (completedAgents?.n ?? 0) >= AGENTS.length;
}

/** Non-failed count of a task_type queued for one agent in this event — the per-agent idempotency primitive used below. */
async function nonFailedCountForAgent(env: Env, eventId: string, agentId: string, taskType: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND agent_id = ? AND task_type = ? AND status != 'failed'`
  ).bind(eventId, agentId, taskType).first<{ n: number }>();
  return row?.n ?? 0;
}

async function queueDeepResearch(env: Env, eventId: string): Promise<void> {
  for (const agent of AGENTS) {
    if ((await nonFailedCountForAgent(env, eventId, agent.id, "research")) > 0) continue;
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

async function queueArchitecture(env: Env, eventId: string): Promise<void> {
  // "Top 6 ideas" (spec §3.1) — ranked by critique count as a proxy signal.
  // This one stays a proxy even after Week 5: architecture happens Day 3-4,
  // BEFORE judging (Day 5+) even exists, so there's no real judge score
  // available yet at this point in the event to rank by.
  const top = await env.DB.prepare(
    `SELECT i.id, i.agent_id, COUNT(x.id) as critique_count
     FROM archive_ideas i LEFT JOIN archive_interactions x
       ON x.target_id = i.id AND x.type = 'critique'
     WHERE i.event_id = ?
     GROUP BY i.id
     ORDER BY critique_count DESC
     LIMIT 6`
  ).bind(eventId).all<{ id: string; agent_id: string; critique_count: number }>();

  const existingArchItems = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE event_id = ? AND task_type = 'architecture' AND status != 'failed'`
  ).bind(eventId).all<{ payload: string | null }>();
  const alreadyQueued = queuedPayloadValues(existingArchItems.results, "ideaId");

  for (const idea of top.results) {
    if (alreadyQueued.has(idea.id)) continue;
    await enqueue(env, {
      eventId, agentId: idea.agent_id, taskType: "architecture",
      payload: { ideaId: idea.id },
      priority: 5,
    });
  }
}
