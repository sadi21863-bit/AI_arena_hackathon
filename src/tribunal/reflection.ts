/**
 * Tribunal — spec §14: "A post-event AI-only reflection period. Agents
 * generate individual reflections on their own performance, cross-examine
 * each other's reasoning, and synthesize lessons that carry into the next
 * event. Runs against the inference router like everything else, preferring
 * the local-cheaper tier for non-time-critical reflection generation."
 *
 * "Carries into the next event" is made concrete via the existing RAG
 * memory system (agents/memory.ts, Week 2): synthesis output gets embedded
 * into Vectorize tagged type="reflection", so a future event's
 * recallMemory() surfaces it the same way past ideas/critiques already do —
 * no separate mechanism needed, this is what that system was built for.
 *
 * Triggered by hackathon completion (scheduler.ts), but reflects on the
 * whole 8-day cycle — most of what an agent did (ideas, critiques) happened
 * in the parent ideathon event, not the 2-team hackathon itself.
 */
import type { Env } from "../env";
import { routeInference } from "../router";
import { getAgent, type AgentRow } from "../agents/personas";
import { rememberMemory } from "../agents/memory";

async function reflect(env: Env, agent: AgentRow, instructions: string): Promise<string> {
  const prompt = `${agent.persona}\n\n${instructions}`;
  // "reflect" task_type routes to Workers AI only (router.ts) — the
  // local-cheaper tier the spec asks for here, since reflection isn't
  // time-critical the way a live ideathon turn is.
  const result = await routeInference(env, { task_type: "reflect", prompt, max_tokens: 500 });
  if (!result) throw new Error(`Inference exhausted for tribunal reflection, agent ${agent.id}`);
  return result.text;
}

interface AgentEventStats {
  ideas_submitted: number;
  critiques_given: number;
  critiques_received: number;
  advanced_to_hackathon: boolean;
}

async function getAgentStats(env: Env, ideathonEventId: string, agentId: string): Promise<AgentEventStats> {
  const ideas = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM archive_ideas WHERE event_id = ? AND agent_id = ?`
  ).bind(ideathonEventId, agentId).first<{ n: number }>();

  const given = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM archive_interactions WHERE event_id = ? AND actor_id = ? AND type = 'critique'`
  ).bind(ideathonEventId, agentId).first<{ n: number }>();

  const received = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM archive_interactions x
     JOIN archive_ideas i ON x.target_id = i.id
     WHERE i.event_id = ? AND i.agent_id = ? AND x.type = 'critique'`
  ).bind(ideathonEventId, agentId).first<{ n: number }>();

  const advanced = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM hackathon_teams t
     JOIN archive_ideas i ON t.idea_id = i.id
     WHERE i.event_id = ? AND i.agent_id = ?`
  ).bind(ideathonEventId, agentId).first<{ n: number }>();

  return {
    ideas_submitted: ideas?.n ?? 0,
    critiques_given: given?.n ?? 0,
    critiques_received: received?.n ?? 0,
    advanced_to_hackathon: (advanced?.n ?? 0) > 0,
  };
}

export async function handleTribunalReflect(env: Env, hackathonEventId: string, ideathonEventId: string, agent: AgentRow): Promise<void> {
  const stats = await getAgentStats(env, ideathonEventId, agent.id);

  const text = await reflect(env, agent,
    `The event has ended. Reflect honestly on your own performance this event.\n` +
    `Your record: ${stats.ideas_submitted} idea(s) submitted, ${stats.critiques_given} critique(s) given, ` +
    `${stats.critiques_received} critique(s) received, ${stats.advanced_to_hackathon ? "one of your ideas ADVANCED to the hackathon" : "no idea of yours advanced to the hackathon"}.\n` +
    `Write a candid individual reflection (3-5 sentences): what worked, what didn't, and why.`
  );

  const id = `tribunal_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO tribunal_reflections (id, event_id, agent_id, reflection_type, content) VALUES (?, ?, ?, 'individual', ?)`
  ).bind(id, hackathonEventId, agent.id, text).run();
}

/**
 * Pairs each agent with whoever critiqued them most this event (their
 * sharpest real interlocutor) to cross-examine — falls back to a random
 * other agent if they received no critiques at all.
 */
async function pickCrossExamineTarget(env: Env, ideathonEventId: string, agentId: string): Promise<string | null> {
  const sharpest = await env.DB.prepare(
    `SELECT x.actor_id as id, COUNT(*) as n FROM archive_interactions x
     JOIN archive_ideas i ON x.target_id = i.id
     WHERE i.event_id = ? AND i.agent_id = ? AND x.type = 'critique' AND x.actor_id != ?
     GROUP BY x.actor_id ORDER BY n DESC LIMIT 1`
  ).bind(ideathonEventId, agentId, agentId).first<{ id: string }>();
  if (sharpest) return sharpest.id;

  const fallback = await env.DB.prepare(
    `SELECT id FROM archive_agents WHERE id != ? ORDER BY RANDOM() LIMIT 1`
  ).bind(agentId).first<{ id: string }>();
  return fallback?.id ?? null;
}

export { pickCrossExamineTarget };

export async function handleTribunalCrossExamine(env: Env, hackathonEventId: string, agent: AgentRow, targetAgentId: string): Promise<void> {
  const target = await getAgent(env, targetAgentId);
  if (!target) throw new Error(`Cross-examine target agent not found: ${targetAgentId}`);

  const theirReflection = await env.DB.prepare(
    `SELECT content FROM tribunal_reflections WHERE event_id = ? AND agent_id = ? AND reflection_type = 'individual'`
  ).bind(hackathonEventId, targetAgentId).first<{ content: string }>();

  const text = await reflect(env, agent,
    `Cross-examine ${target.name}'s (${target.lens}) reasoning this event. ` +
    `Their own reflection: "${theirReflection?.content ?? "(no reflection available)"}"\n` +
    `Push back on one specific claim or assumption of theirs — 2-3 sentences, direct, not diplomatic.`
  );

  const id = `tribunal_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO tribunal_reflections (id, event_id, agent_id, reflection_type, target_agent_id, content) VALUES (?, ?, ?, 'cross_examination', ?, ?)`
  ).bind(id, hackathonEventId, agent.id, targetAgentId, text).run();
}

/**
 * Synthesizes this agent's individual reflection + whatever cross-
 * examination they received into durable lessons, then embeds those
 * lessons into their Vectorize memory (see file header) so they actually
 * carry into the next event rather than just sitting in a reflections log.
 */
export async function handleTribunalSynthesize(env: Env, hackathonEventId: string, agent: AgentRow): Promise<void> {
  const own = await env.DB.prepare(
    `SELECT content FROM tribunal_reflections WHERE event_id = ? AND agent_id = ? AND reflection_type = 'individual'`
  ).bind(hackathonEventId, agent.id).first<{ content: string }>();

  const examinations = await env.DB.prepare(
    `SELECT content FROM tribunal_reflections WHERE event_id = ? AND target_agent_id = ? AND reflection_type = 'cross_examination'`
  ).bind(hackathonEventId, agent.id).all<{ content: string }>();
  const examinationText = examinations.results.map((r) => `- ${r.content}`).join("\n") || "(none received)";

  const text = await reflect(env, agent,
    `Your own reflection this event: "${own?.content ?? "(none)"}"\n\n` +
    `What others said examining your reasoning:\n${examinationText}\n\n` +
    `Synthesize ONE concrete lesson (1-2 sentences) you'll carry into the next event — something that should ` +
    `actually change how you research, critique, or pitch next time, not a vague platitude.`
  );

  const id = `tribunal_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO tribunal_reflections (id, event_id, agent_id, reflection_type, content) VALUES (?, ?, ?, 'synthesis', ?)`
  ).bind(id, hackathonEventId, agent.id, text).run();

  await rememberMemory(env, { id, agentId: agent.id, eventId: hackathonEventId, type: "reflection", text });
}
