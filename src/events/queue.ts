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
  | "research" | "submit_idea" | "critique" | "architecture"
  | "team_formation" | "dispatch_build_turn"
  | "judge_idea" | "judge_team"
  | "tribunal_reflect" | "tribunal_cross_examine" | "tribunal_synthesize";
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
  await env.DB.prepare(
    `INSERT INTO event_queue (event_id, agent_id, task_type, payload, priority, scheduled_for)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    item.eventId,
    item.agentId ?? null,
    item.taskType,
    item.payload !== undefined ? JSON.stringify(item.payload) : null,
    item.priority ?? 5,
    (item.scheduledFor ?? new Date()).toISOString().replace("T", " ").slice(0, 19)
  ).run();
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
  return result ?? null;
}

export async function markCompleted(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE event_queue SET status = 'completed', completed_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
}

export async function markFailed(env: Env, id: number, errorMessage: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE event_queue SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`
  ).bind(errorMessage.slice(0, 2000), id).run();
}

/**
 * Resets orphaned 'in_progress' rows back to 'pending' after a timeout —
 * a Worker invocation can die mid-task (timeout, exception before the
 * markCompleted/markFailed call) and leave a row wedged forever otherwise.
 * Ported from ideaconnect's resetStuckQueueItems().
 */
export async function resetStuckItems(env: Env, staleAfterMinutes = 10): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE event_queue
     SET status = 'pending', claimed_at = NULL
     WHERE status = 'in_progress'
       AND claimed_at <= datetime('now', ?)`
  ).bind(`-${staleAfterMinutes} minutes`).run();
  return result.meta.changes ?? 0;
}
