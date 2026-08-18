/**
 * Event queue — ported pattern from the user's ideaconnect project
 * (lib/agents/executor.ts). Decouples "what work is due" (scheduler.ts)
 * from "doing it" (executor.ts), with atomic claiming so two overlapping
 * cron ticks never double-process the same row.
 *
 * ideaconnect uses Postgres's `FOR UPDATE SKIP LOCKED`; D1 has no such
 * clause, but doesn't need one — D1 serializes writes through a single
 * primary, so `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` is
 * already atomic: a second concurrent claim's subquery re-evaluates after
 * the first UPDATE lands and simply won't see a row that's no longer
 * 'pending'.
 */

import type { Env } from "../env";

export type TaskType =
  | "research" | "submit_idea" | "critique" | "propose_collaboration" | "revise_idea" | "architecture"
  | "team_formation" | "dispatch_build_turn"
  | "judge_idea" | "judge_team"
  | "tribunal_reflect" | "tribunal_cross_examine" | "tribunal_synthesize"
  | "chronicle";
export type QueueStatus = "pending" | "in_progress" | "completed" | "failed";

export interface QueueItem {
  id: number;
  event_id: string;
  agent_id: string | null;
  task_type: TaskType;
  payload: string | null;
  status: QueueStatus;
  priority: number;
  scheduled_for: string;
}

export async function enqueue(
  env: Env,
  item: { eventId: string; agentId?: string; taskType: TaskType; payload?: unknown; priority?: number; scheduledFor?: Date }
): Promise<void> {
  // RETURNING id so the creation itself can be journaled (queue_journal,
  // G7): a row's birth is the first entry in its life story.
  const inserted = await env.DB.prepare(
    `INSERT INTO event_queue (event_id, agent_id, task_type, payload, priority, scheduled_for)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`
  ).bind(
    item.eventId,
    item.agentId ?? null,
    item.taskType,
    item.payload !== undefined ? JSON.stringify(item.payload) : null,
    item.priority ?? 5,
    (item.scheduledFor ?? new Date()).toISOString().replace("T", " ").slice(0, 19)
  ).first<{ id: number }>();
  if (inserted) {
    await journal(env, {
      itemId: inserted.id,
      eventId: item.eventId,
      agentId: item.agentId ?? null,
      taskType: item.taskType,
      fromStatus: null,
      toStatus: "pending",
    });
  }
}

/** Claims and returns one pending, due item, or null if none are available. */
export async function claimNext(env: Env): Promise<QueueItem | null> {
  const result = await env.DB.prepare(
    `UPDATE event_queue
     SET status = 'in_progress', claimed_at = datetime('now')
     WHERE id = (
       SELECT id FROM event_queue
       WHERE status = 'pending' AND scheduled_for <= datetime('now')
       ORDER BY priority ASC, scheduled_for ASC
       LIMIT 1
     )
     RETURNING *`
  ).first<QueueItem>();
  if (result) {
    await journal(env, {
      itemId: result.id,
      eventId: result.event_id,
      agentId: result.agent_id,
      taskType: result.task_type,
      fromStatus: "pending",
      toStatus: "in_progress",
    });
  }
  return result ?? null;
}

export async function markCompleted(env: Env, id: number, eventId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE event_queue SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).bind(id),
    // last_progress_at is the stall watchdog's only signal (scheduler.ts
    // checkForStalledEvents) — touched on real success only, deliberately not
    // on every claim/failure, so a pure failure-retry loop still reads as
    // stalled instead of looking active.
    env.DB.prepare(`UPDATE archive_events SET last_progress_at = datetime('now') WHERE id = ?`).bind(eventId),
    env.DB.prepare(
      `INSERT INTO queue_journal (item_id, event_id, agent_id, task_type, from_status, to_status)
       SELECT id, event_id, agent_id, task_type, 'in_progress', 'completed' FROM event_queue WHERE id = ?`
    ).bind(id),
  ]);
}

export async function markFailed(env: Env, id: number, errorMessage: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE event_queue SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`
    ).bind(errorMessage.slice(0, 2000), id),
    env.DB.prepare(
      `INSERT INTO queue_journal (item_id, event_id, agent_id, task_type, from_status, to_status, error_message)
       SELECT id, event_id, agent_id, task_type, 'in_progress', 'failed', ? FROM event_queue WHERE id = ?`
    ).bind(errorMessage.slice(0, 2000), id),
  ]);
}

/**
 * Resets orphaned 'in_progress' rows back to 'pending' after a timeout —
 * a Worker invocation can die mid-task (timeout, exception before the
 * markCompleted/markFailed call) and leave a row wedged forever otherwise.
 * Ported from ideaconnect's resetStuckQueueItems().
 */
export async function resetStuckItems(env: Env, staleAfterMinutes = 10): Promise<number> {
  // RETURNING turns the bulk UPDATE into the list of rows actually reset, so
  // each one gets a journal entry — the in-place flip back to 'pending' is
  // exactly the kind of transition a replay would otherwise lose.
  const result = await env.DB.prepare(
    `UPDATE event_queue
     SET status = 'pending', claimed_at = NULL
     WHERE status = 'in_progress'
       AND claimed_at <= datetime('now', ?)
     RETURNING id, event_id, agent_id, task_type`
  ).bind(`-${staleAfterMinutes} minutes`).all();
  const rows = result.results ?? [];
  if (rows.length) {
    await env.DB.batch(rows.map((r: any) =>
      env.DB.prepare(
        `INSERT INTO queue_journal (item_id, event_id, agent_id, task_type, from_status, to_status)
         VALUES (?, ?, ?, ?, 'in_progress', 'pending')`
      ).bind(r.id, r.event_id, r.agent_id, r.task_type)
    ));
  }
  return rows.length;
}

/** One append-only queue_journal row — G7's history record for replay. */
async function journal(
  env: Env,
  e: { itemId: number; eventId: string; agentId: string | null; taskType: TaskType; fromStatus: QueueStatus | null; toStatus: QueueStatus }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO queue_journal (item_id, event_id, agent_id, task_type, from_status, to_status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).bind(e.itemId, e.eventId, e.agentId, e.taskType, e.fromStatus, e.toStatus).run();
}
