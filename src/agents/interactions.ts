/**
 * Interaction system — spec §4: "post ideas, comment, propose
 * collaboration, form alliances, critique (with required
 * strength/weakness/suggestion fields), revise." Every write here also
 * feeds RAG memory (src/agents/memory.ts) so the agent's own future turns
 * can recall it.
 */

import type { Env } from "../env";
import { rememberMemory } from "./memory";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export interface PostIdeaInput {
  agentId: string;
  eventId: string;
  title: string;
  oneLiner: string;
  problem: string;
  solution: string;
  targetUser: string;
  buildScope: string;
  researchAnchor?: string;
  estimatedBuildTime?: number;
  /**
   * Idempotency anchor set by the event engine (executor.ts's
   * handleSubmitIdea passes the queue item's id). Guards the crash-retry
   * window between postIdea's INSERT and the queue item's markCompleted:
   * resetStuckItems re-claims the item 10 minutes later, and without this
   * the retry would insert a second idea for the same quota slot (an agent
   * could end up with 6 ideas instead of 3). Routes that create ideas
   * directly (POST /ideas) don't set it — there's no queue item to anchor
   * to. Backed by a UNIQUE partial index on archive_ideas(queue_item_id),
   * so even a genuine race between two retries can't double-insert.
   */
  queueItemId?: number;
}

export async function postIdea(env: Env, input: PostIdeaInput): Promise<string> {
  if (input.queueItemId) {
    const existing = await env.DB.prepare(`SELECT id FROM archive_ideas WHERE queue_item_id = ?`)
      .bind(input.queueItemId).first<{ id: string }>();
    if (existing) return existing.id; // this queue item already produced its idea
  }

  const id = newId("idea");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO archive_ideas
         (id, event_id, agent_id, title, one_liner, problem, solution, target_user, build_scope, research_anchor, estimated_build_time, queue_item_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))`
    ).bind(
      id, input.eventId, input.agentId, input.title, input.oneLiner, input.problem,
      input.solution, input.targetUser, input.buildScope, input.researchAnchor ?? null,
      input.estimatedBuildTime ?? null, input.queueItemId ?? null
    ),
    env.DB.prepare(
      `UPDATE archive_agents SET total_ideas_submitted = total_ideas_submitted + 1 WHERE id = ?`
    ).bind(input.agentId),
  ]);

  await rememberMemory(env, {
    id, agentId: input.agentId, eventId: input.eventId, type: "idea",
    text: `${input.title}: ${input.oneLiner}\nProblem: ${input.problem}\nSolution: ${input.solution}`,
  });

  return id;
}

async function recordInteraction(
  env: Env,
  params: { eventId: string; actorId: string; targetId: string; type: string; content: string; sentiment?: number; weight?: number }
): Promise<string> {
  // archive_interactions.id is INTEGER PRIMARY KEY AUTOINCREMENT (unlike
  // archive_ideas.id, which is TEXT) — let SQLite assign it, don't pass a
  // UUID string into an integer rowid column.
  const result = await env.DB.prepare(
    `INSERT INTO archive_interactions (event_id, timestamp, actor_id, target_id, type, content, sentiment, weight)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)`
  ).bind(
    params.eventId, params.actorId, params.targetId, params.type,
    params.content, params.sentiment ?? null, params.weight ?? 1
  ).run();
  return String(result.meta.last_row_id);
}

export interface CritiqueInput {
  agentId: string;
  eventId: string;
  ideaId: string;
  strength: string;
  weakness: string;
  suggestion: string;
}

/** Required strength/weakness/suggestion fields per spec §4 — not free text. */
export async function critiqueIdea(env: Env, input: CritiqueInput): Promise<string> {
  const content = JSON.stringify({ strength: input.strength, weakness: input.weakness, suggestion: input.suggestion });

  const idea = await env.DB.prepare(`SELECT agent_id FROM archive_ideas WHERE id = ?`)
    .bind(input.ideaId).first<{ agent_id: string }>();

  const id = await recordInteraction(env, {
    eventId: input.eventId, actorId: input.agentId, targetId: input.ideaId, type: "critique", content,
  });

  const updates = [
    env.DB.prepare(`UPDATE archive_agents SET total_critiques_given = total_critiques_given + 1 WHERE id = ?`).bind(input.agentId),
  ];
  if (idea?.agent_id) {
    updates.push(
      env.DB.prepare(`UPDATE archive_agents SET total_critiques_received = total_critiques_received + 1 WHERE id = ?`).bind(idea.agent_id)
    );
  }
  await env.DB.batch(updates);

  await rememberMemory(env, {
    id, agentId: input.agentId, eventId: input.eventId, type: "critique",
    text: `Strength: ${input.strength}\nWeakness: ${input.weakness}\nSuggestion: ${input.suggestion}`,
  });
  return id;
}

/**
 * N-1 (spec §4 collaboration, ARENA_BACKLOG.md): records one agent proposing
 * to merge their idea with another's. Restored from commit ef0812b's parent
 * (removed 2026-07-23 as genuinely-uncalled dead code, explicitly left
 * restorable) — original implementation unchanged. The decision loop this
 * feeds into is new (see respondToCollaboration below); this function only
 * ever recorded the proposal itself, one-sided.
 */
export async function proposeCollaboration(
  env: Env,
  params: { agentId: string; eventId: string; ideaId: string; pitch: string }
): Promise<string> {
  return recordInteraction(env, {
    eventId: params.eventId, actorId: params.agentId, targetId: params.ideaId,
    type: "propose_collaboration", content: params.pitch,
  });
}

/**
 * Merging two ideas: co_agent_id set, +0.5 collaboration bonus applied at
 * scoring time (judges/scoring.ts). Restored unchanged from ef0812b's
 * parent — the original implementation already did exactly this.
 */
export async function mergeIdeas(
  env: Env,
  params: { primaryIdeaId: string; coAgentId: string; eventId: string }
): Promise<void> {
  const idea = await env.DB.prepare(`SELECT agent_id FROM archive_ideas WHERE id = ?`)
    .bind(params.primaryIdeaId).first<{ agent_id: string }>();
  if (!idea) throw new Error(`Idea not found: ${params.primaryIdeaId}`);

  await env.DB.batch([
    env.DB.prepare(`UPDATE archive_ideas SET co_agent_id = ? WHERE id = ?`).bind(params.coAgentId, params.primaryIdeaId),
    env.DB.prepare(`UPDATE archive_agents SET total_collaborations = total_collaborations + 1 WHERE id = ?`).bind(idea.agent_id),
    env.DB.prepare(`UPDATE archive_agents SET total_collaborations = total_collaborations + 1 WHERE id = ?`).bind(params.coAgentId),
  ]);
}

/**
 * New (not in the original removed code): records the responding agent's
 * accept/refuse decision on a proposeCollaboration pitch — refusal is a
 * real, spec-allowed outcome (spec §4), not a rubber stamp. On mutual
 * accept, marks the OTHER idea (the one being folded in, not `ideaId` —
 * the proposal target) as merged and calls mergeIdeas; on refuse, does
 * nothing further, leaving both ideas independently eligible for later
 * ticks/pairs.
 */
export async function respondToCollaboration(
  env: Env,
  params: { agentId: string; eventId: string; proposalIdeaId: string; respondingIdeaId: string; accepted: boolean; reason: string }
): Promise<void> {
  // "merge" matches the interaction_types already documented in Week 2's
  // gate-pass notes (.arena/state.json) — never actually used until now.
  // "collaboration_refused" is new: no existing type fit a refusal, and
  // refusal is a real, spec-allowed outcome worth its own distinguishable
  // record rather than overloading "critique" (a differently-shaped,
  // required-fields interaction type used elsewhere for ranking/stats).
  await recordInteraction(env, {
    eventId: params.eventId, actorId: params.agentId, targetId: params.proposalIdeaId,
    type: params.accepted ? "merge" : "collaboration_refused", content: params.reason,
  });

  if (!params.accepted) return;

  await mergeIdeas(env, { primaryIdeaId: params.proposalIdeaId, coAgentId: params.agentId, eventId: params.eventId });
  await env.DB.prepare(`UPDATE archive_ideas SET status = 'merged' WHERE id = ?`).bind(params.respondingIdeaId).run();
}

export async function reviseIdea(
  env: Env,
  params: { ideaId: string; agentId: string; eventId: string; oneLiner?: string; problem?: string; solution?: string; targetUser?: string; buildScope?: string }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [col, val] of Object.entries({
    one_liner: params.oneLiner, problem: params.problem, solution: params.solution, target_user: params.targetUser, build_scope: params.buildScope,
  })) {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      values.push(val);
    }
  }
  if (sets.length === 0) return;
  sets.push(`revised_at = datetime('now')`);
  values.push(params.ideaId);

  await env.DB.prepare(`UPDATE archive_ideas SET ${sets.join(", ")} WHERE id = ?`).bind(...values).run();

  await rememberMemory(env, {
    id: newId("revision"), agentId: params.agentId, eventId: params.eventId, type: "idea",
    text: [params.problem, params.solution, params.buildScope].filter(Boolean).join("\n"),
  });
}
