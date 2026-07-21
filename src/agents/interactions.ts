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
}

export async function postIdea(env: Env, input: PostIdeaInput): Promise<string> {
  const id = newId("idea");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO archive_ideas
         (id, event_id, agent_id, title, one_liner, problem, solution, target_user, build_scope, research_anchor, estimated_build_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))`
    ).bind(
      id, input.eventId, input.agentId, input.title, input.oneLiner, input.problem,
      input.solution, input.targetUser, input.buildScope, input.researchAnchor ?? null,
      input.estimatedBuildTime ?? null
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

export async function commentOnIdea(
  env: Env,
  params: { agentId: string; eventId: string; ideaId: string; text: string; sentiment?: number }
): Promise<string> {
  const id = await recordInteraction(env, {
    eventId: params.eventId, actorId: params.agentId, targetId: params.ideaId,
    type: "comment", content: params.text, sentiment: params.sentiment,
  });
  await rememberMemory(env, { id, agentId: params.agentId, eventId: params.eventId, type: "comment", text: params.text });
  return id;
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

export async function proposeCollaboration(
  env: Env,
  params: { agentId: string; eventId: string; ideaId: string; pitch: string }
): Promise<string> {
  return recordInteraction(env, {
    eventId: params.eventId, actorId: params.agentId, targetId: params.ideaId,
    type: "propose_collaboration", content: params.pitch,
  });
}

export async function formAlliance(
  env: Env,
  params: { agentId: string; eventId: string; withAgentId: string; reason: string }
): Promise<string> {
  return recordInteraction(env, {
    eventId: params.eventId, actorId: params.agentId, targetId: params.withAgentId,
    type: "form_alliance", content: params.reason,
  });
}

/**
 * Merging two ideas: co_agent_id set, +0.5 collaboration bonus applied at
 * scoring time (Tribunal, Week 5) — this just records the merge itself and
 * bumps both agents' collaboration count, per spec §4.
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

export async function reviseIdea(
  env: Env,
  params: { ideaId: string; agentId: string; eventId: string; problem?: string; solution?: string; buildScope?: string }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [col, val] of Object.entries({ problem: params.problem, solution: params.solution, build_scope: params.buildScope })) {
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
