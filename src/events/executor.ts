/**
 * Event queue executor — claims items (queue.ts), dispatches by task_type,
 * calls the LLM via the inference router with the agent's own persona,
 * parses structured output (json-helpers.ts, ported from ideaconnect), and
 * writes results through Week 2's interaction/research functions.
 */

import type { Env } from "../env";
import { routeInference } from "../router";
import { extractJson } from "../agents/json-helpers";
import { getAgent, type AgentRow } from "../agents/personas";
import { deepResearch } from "../agents/research";
import { postIdea, critiqueIdea, reviseIdea } from "../agents/interactions";
import { recallMemory } from "../agents/memory";
import { claimNext, markCompleted, markFailed, resetStuckItems, enqueue, type QueueItem } from "./queue";

async function callAgent(env: Env, agent: AgentRow, taskType: Parameters<typeof routeInference>[1]["task_type"], instructions: string): Promise<string> {
  const prompt = `${agent.persona}\n\n${instructions}`;
  const result = await routeInference(env, { task_type: taskType, prompt, max_tokens: 700 });
  if (!result) throw new Error(`Inference exhausted for agent ${agent.id}`);
  return result.text;
}

async function handleResearch(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const payload = item.payload ? JSON.parse(item.payload) : {};
  const lens = payload.lens ?? agent.lens;
  // Deterministic query from role/lens rather than an extra LLM round-trip
  // to generate one — keeps this task cheap; the agent's actual reasoning
  // happens when it later uses this research to write an idea.
  const query = `${agent.name}'s ${lens} lens: emerging opportunities, pain points, or gaps worth building a product around in 2026`;
  await deepResearch(env, { agentId: agent.id, eventId: item.event_id, lens, query });
}

interface IdeaJson {
  title: string; one_liner: string; problem: string; solution: string; target_user: string; build_scope: string;
}

async function handleSubmitIdea(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const memories = await recallMemory(env, agent.id, `${agent.lens} opportunities and research findings`, 3);
  const context = memories.map((m) => `- ${m.text}`).join("\n") || "(no prior research recalled)";

  const text = await callAgent(env, agent, "design",
    `Recent research from your own lens:\n${context}\n\n` +
    `Submit ONE product idea grounded in that research. Respond with ONLY a JSON object: ` +
    `{"title": string, "one_liner": string, "problem": string, "solution": string, "target_user": string, "build_scope": string}. ` +
    `build_scope should be a short buildable-in-days scope, not a vague vision.`
  );

  const idea = extractJson<IdeaJson>(text);
  if (!idea?.title || !idea.problem || !idea.solution) throw new Error(`Malformed idea JSON from ${agent.id}: ${text.slice(0, 200)}`);

  const ideaId = await postIdea(env, {
    agentId: agent.id, eventId: item.event_id, title: idea.title, oneLiner: idea.one_liner,
    problem: idea.problem, solution: idea.solution, targetUser: idea.target_user, buildScope: idea.build_scope,
  });

  // Spec §4: "critique 3 ideas not their own" — queued per-idea rather than
  // as one big batch step, so critique flow starts as soon as ideas exist
  // instead of waiting for every agent to finish submitting first.
  const critic = await env.DB.prepare(
    `SELECT id FROM archive_agents WHERE id != ? ORDER BY RANDOM() LIMIT 1`
  ).bind(agent.id).first<{ id: string }>();
  if (critic) {
    await enqueue(env, { eventId: item.event_id, agentId: critic.id, taskType: "critique", payload: { ideaId }, priority: 6 });
  }
}

interface CritiqueJson { strength: string; weakness: string; suggestion: string }

async function handleCritique(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const payload = item.payload ? JSON.parse(item.payload) : {};
  const ideaId = payload.ideaId as string | undefined;
  if (!ideaId) throw new Error("critique task missing payload.ideaId");

  const idea = await env.DB.prepare(`SELECT * FROM archive_ideas WHERE id = ?`).bind(ideaId).first<Record<string, unknown>>();
  if (!idea) throw new Error(`Idea not found: ${ideaId}`);

  const text = await callAgent(env, agent, "validate",
    `Critique this idea from your lens:\nTitle: ${idea.title}\nProblem: ${idea.problem}\nSolution: ${idea.solution}\n\n` +
    `Respond with ONLY a JSON object: {"strength": string, "weakness": string, "suggestion": string}. All three fields are required, spec §4.`
  );

  const critique = extractJson<CritiqueJson>(text);
  if (!critique?.strength || !critique.weakness || !critique.suggestion) {
    throw new Error(`Malformed critique JSON from ${agent.id}: ${text.slice(0, 200)}`);
  }

  await critiqueIdea(env, { agentId: agent.id, eventId: item.event_id, ideaId, ...critique });
}

async function handleArchitecture(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const payload = item.payload ? JSON.parse(item.payload) : {};
  const ideaId = payload.ideaId as string | undefined;
  if (!ideaId) throw new Error("architecture task missing payload.ideaId");

  const idea = await env.DB.prepare(`SELECT * FROM archive_ideas WHERE id = ?`).bind(ideaId).first<Record<string, unknown>>();
  if (!idea) throw new Error(`Idea not found: ${ideaId}`);

  const text = await callAgent(env, agent, "architecture",
    `Produce a build plan for this idea (spec §3.1 — Day 4-5 Architecture: tech stack, 3 components, top 2 risks, fallback scope), under 200 words:\n` +
    `Title: ${idea.title}\nProblem: ${idea.problem}\nSolution: ${idea.solution}\nBuild scope so far: ${idea.build_scope}`
  );

  await reviseIdea(env, { ideaId, agentId: agent.id, eventId: item.event_id, buildScope: text.slice(0, 4000) });
  await env.DB.prepare(`UPDATE archive_ideas SET status = 'architecture_complete' WHERE id = ?`).bind(ideaId).run();
}

export async function processQueue(env: Env, limit = 5): Promise<{ processed: number; failed: number }> {
  await resetStuckItems(env);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < limit; i++) {
    const item = await claimNext(env);
    if (!item) break;

    try {
      const agent = item.agent_id ? await getAgent(env, item.agent_id) : null;
      if (item.agent_id && !agent) throw new Error(`Unknown agent_id: ${item.agent_id}`);

      switch (item.task_type) {
        case "research": await handleResearch(env, item, agent!); break;
        case "submit_idea": await handleSubmitIdea(env, item, agent!); break;
        case "critique": await handleCritique(env, item, agent!); break;
        case "architecture": await handleArchitecture(env, item, agent!); break;
        case "propose_collaboration": break; // not scheduled automatically yet, see scheduler.ts
      }
      await markCompleted(env, item.id);
      processed++;
    } catch (err) {
      await markFailed(env, item.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return { processed, failed };
}
