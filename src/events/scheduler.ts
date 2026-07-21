/**
 * Event phase scheduler — spec §3.1 (ideathon), §3.2 (hackathon). Decides
 * what work is due and writes it to event_queue; never calls an LLM (or
 * GitHub API) itself (ported split from ideaconnect's scheduler.ts /
 * executor.ts).
 *
 * Ideathon phase boundaries are day-offsets from archive_events.start_date:
 *   Day 0-1 (elapsed): Deep Research
 *   Day 2:             Ideation + Critique
 *   Day 3-4:            Architecture (top 6 ideas by interaction signal)
 *   Day 5+:             ready_for_judging — Week 5 (Tribunal) scope from here
 *
 * Hackathon phase boundaries (spec §3.2, 3-day event):
 *   Day 0:   team_formation — create both team repos, dispatch each team's
 *            first build turn same day ("First build turns begin same day")
 *   Day 1-2: building — one additional build-turn dispatch per team per
 *            calendar day
 *   Day 3+:  ready_for_judging — demos/judging are Week 5 scope
 */

import type { Env } from "../env";
import { AGENTS } from "../agents/personas";
import { enqueue } from "./queue";

export type Phase = "deep_research" | "ideation_critique" | "architecture" | "ready_for_judging";
export type HackathonPhase = "team_formation" | "building" | "ready_for_judging";

export function phaseForDay(daysElapsed: number): Phase {
  if (daysElapsed < 2) return "deep_research";
  if (daysElapsed < 3) return "ideation_critique";
  if (daysElapsed < 5) return "architecture";
  return "ready_for_judging";
}

export function hackathonPhaseForDay(daysElapsed: number): HackathonPhase {
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

  const phase = phaseForDay(daysElapsed(event.start_date));

  if (phase !== event.status) {
    await env.DB.prepare(`UPDATE archive_events SET status = ? WHERE id = ?`).bind(phase, event.id).run();
  }

  const existing = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND task_type = ?`
  ).bind(event.id, phaseTaskType(phase)).first<{ n: number }>();

  if ((existing?.n ?? 0) > 0) return phase; // already queued (or completed) — don't duplicate

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
    case "ready_for_judging":
      break; // Week 5 scope picks up from here
  }
  return phase;
}

async function ensureHackathonWorkQueued(env: Env, event: EventRow): Promise<HackathonPhase> {
  const phase = hackathonPhaseForDay(daysElapsed(event.start_date));

  if (phase !== event.status) {
    await env.DB.prepare(`UPDATE archive_events SET status = ? WHERE id = ?`).bind(phase, event.id).run();
  }

  if (phase === "team_formation") {
    const existing = await env.DB.prepare(`SELECT COUNT(*) as n FROM event_queue WHERE event_id = ? AND task_type = 'team_formation'`)
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

    for (const team of teams.results) {
      const existing = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM event_queue
         WHERE event_id = ? AND task_type = 'dispatch_build_turn'
           AND payload LIKE ? AND date(created_at) = ?`
      ).bind(event.id, `%"teamId":"${team.id}"%`, today).first<{ n: number }>();

      if ((existing?.n ?? 0) === 0) {
        await enqueue(env, {
          eventId: event.id, taskType: "dispatch_build_turn",
          payload: { teamId: team.id, teamName: team.team_name },
          priority: 3,
        });
      }
    }
  }
  // ready_for_judging: Week 5 (Tribunal) scope picks up from here.

  return phase;
}

function phaseTaskType(phase: Phase): string {
  switch (phase) {
    case "deep_research": return "research";
    case "ideation_critique": return "submit_idea"; // proxy check; critiques are queued alongside
    case "architecture": return "architecture";
    default: return "";
  }
}

async function queueDeepResearch(env: Env, eventId: string): Promise<void> {
  for (const agent of AGENTS) {
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
  for (const agent of AGENTS) {
    for (let i = 0; i < 3; i++) {
      await enqueue(env, {
        eventId, agentId: agent.id, taskType: "submit_idea",
        priority: 6,
        scheduledFor: new Date(Date.now() + Math.random() * 5 * 60 * 1000),
      });
    }
  }
}

async function queueArchitecture(env: Env, eventId: string): Promise<void> {
  // "Top 6 ideas" (spec §3.1) — ranked by critique count as a proxy signal
  // until Week 5's judges provide real scores.
  const top = await env.DB.prepare(
    `SELECT i.id, i.agent_id, COUNT(x.id) as critique_count
     FROM archive_ideas i LEFT JOIN archive_interactions x
       ON x.target_id = i.id AND x.type = 'critique'
     WHERE i.event_id = ?
     GROUP BY i.id
     ORDER BY critique_count DESC
     LIMIT 6`
  ).bind(eventId).all<{ id: string; agent_id: string; critique_count: number }>();

  for (const idea of top.results) {
    await enqueue(env, {
      eventId, agentId: idea.agent_id, taskType: "architecture",
      payload: { ideaId: idea.id },
      priority: 5,
    });
  }
}
