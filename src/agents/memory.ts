/**
 * RAG memory — spec vision: "Their memories persist across months," spec
 * §10 GET /agents/{id} returns "Agent profile + memory". Vectorize-backed:
 * every idea/comment/critique/reflection an agent produces gets embedded
 * and upserted, tagged with agent_id (metadata-indexed — see
 * db/README or the create-metadata-index call run during Week 2 setup) so
 * a later turn can pull "what has this agent said before" via semantic
 * search, scoped to that agent, across events.
 */

import type { Env } from "../env";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; // matches the Vectorize index's preset dimensions

export type MemoryType = "idea" | "comment" | "critique" | "reflection";

export interface MemoryRecord {
  id: string; // stable id, e.g. `${interactionId}` or `${ideaId}`
  agentId: string;
  eventId: string;
  type: MemoryType;
  text: string;
}

async function embed(env: Env, text: string): Promise<number[]> {
  const result: any = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  const vector = result?.data?.[0];
  if (!vector) throw new Error("Embedding call returned no vector");
  return vector;
}

export async function rememberMemory(env: Env, record: MemoryRecord): Promise<void> {
  const values = await embed(env, record.text);
  await env.ARCHIVE_VECTORS.upsert([
    {
      id: record.id,
      values,
      metadata: { agent_id: record.agentId, event_id: record.eventId, type: record.type, text: record.text },
    },
  ]);
}

export interface RecalledMemory {
  score: number;
  agentId: string;
  eventId: string;
  type: string;
  text: string;
}

/**
 * Semantic recall scoped to one agent — "what has this agent said before
 * that's relevant to X." Not cross-agent; use plain Vectorize query without
 * the filter for archive-wide search (spec §10 POST /archive/query).
 */
export async function recallMemory(
  env: Env,
  agentId: string,
  queryText: string,
  topK = 5
): Promise<RecalledMemory[]> {
  const values = await embed(env, queryText);
  const result = await env.ARCHIVE_VECTORS.query(values, {
    topK,
    filter: { agent_id: agentId },
    returnMetadata: "all",
  });
  return result.matches.map((m) => ({
    score: m.score,
    agentId: String(m.metadata?.agent_id ?? ""),
    eventId: String(m.metadata?.event_id ?? ""),
    type: String(m.metadata?.type ?? ""),
    text: String(m.metadata?.text ?? ""),
  }));
}
