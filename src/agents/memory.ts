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
import { recordUsage } from "../router";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; // matches the Vectorize index's preset dimensions

// Neurons per input token for this specific model — Cloudflare's published
// rate (developers.cloudflare.com/workers-ai/platform/pricing/: "6058
// neurons per M input tokens" for @cf/baai/bge-base-en-v1.5), not a guess.
// Confirmed live (2026-07-28, docs/INVESTIGATION_2026-07-28.md P1-4) that
// this model's own usage response has NO usage.neurons field at all (only
// prompt_tokens/completion_tokens/total_tokens) — unlike the chat models
// router.ts calls, which do return usage.neurons directly. That's the actual
// reason embed() never recorded real cost: there was no field to read.
const NEURONS_PER_INPUT_TOKEN = 6058 / 1_000_000;

export type MemoryType = "idea" | "comment" | "critique" | "reflection" | "research";

export interface MemoryRecord {
  id: string; // stable id, e.g. `${interactionId}` or `${ideaId}`
  agentId: string;
  eventId: string;
  type: MemoryType;
  text: string;
}

export async function embed(env: Env, text: string): Promise<number[]> {
  try {
    const result: any = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
    const vector = result?.data?.[0];
    if (!vector) throw new Error("Embedding call returned no vector");

    // No result.usage.neurons on this model (see NEURONS_PER_INPUT_TOKEN
    // above) — derive real cost from the real prompt_tokens this specific
    // call reports, times Cloudflare's published per-token rate, rather than
    // a flat guess that wouldn't scale with actual text length. Math.ceil,
    // same as tryWorkersAI in router.ts and for the same reason: units_used
    // is INTEGER, and summing many calls should never under-count against
    // DAILY_CAPS just because a single short embed() call's real cost rounds
    // to a fraction of a Neuron.
    const promptTokens = result?.usage?.prompt_tokens ?? 0;
    const neurons = Math.ceil(promptTokens * NEURONS_PER_INPUT_TOKEN);
    await recordUsage(env, "workers_ai", EMBEDDING_MODEL, "embed", neurons);
    return vector;
  } catch (err) {
    // 4006 daily free allocation exhausted — don't bubble as hard failure.
    // Found live 2026-08-20 02:00 UTC on architecture-phase event_a0cbe:
    // every submit_idea failed at the first recallMemory (embed) before even
    // reaching callAgent, so the Zen fallback in router.ts never got a chance.
    // Embed is best-effort context; the idea can still be generated from the
    // prompt alone. Re-throw as a retryable signal that callers can catch
    // and degrade to empty context, rather than marking the whole queue item
    // as permanently failed.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("4006") || msg.includes("daily free allocation")) {
      throw new Error(`Embedding quota exhausted (4006) — caller should degrade to empty context`);
    }
    throw err;
  }
}

export async function rememberMemory(env: Env, record: MemoryRecord, vector?: number[]): Promise<void> {
  let values: number[];
  if (vector) {
    values = vector;
  } else {
    try {
      values = await embed(env, record.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("4006") || msg.includes("Embedding quota") || msg.includes("daily free allocation")) {
        // Quota exhausted — skip vector upsert, don't fail the task that produced the memory.
        // The idea/interaction is already persisted in D1; the vector is best-effort.
        return;
      }
      throw err;
    }
  }
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

export interface ArchiveQueryFilter {
  agentId?: string;
  eventId?: string;
  type?: MemoryType;
}

function toRecalledMemories(matches: VectorizeMatches["matches"]): RecalledMemory[] {
  return matches.map((m) => ({
    score: m.score,
    agentId: String(m.metadata?.agent_id ?? ""),
    eventId: String(m.metadata?.event_id ?? ""),
    type: String(m.metadata?.type ?? ""),
    text: String(m.metadata?.text ?? ""),
  }));
}

/**
 * Archive-wide semantic search — spec §10 POST /archive/query, spec §15
 * "Semantic: full-text + vector search on ideas, rationales, memories."
 * Same Vectorize index as agent memory (every idea/critique/reflection
 * already gets embedded there — Week 2/5). recallMemory below is just this
 * with a mandatory agentId filter — kept as its own function since that's
 * the far more common call shape, but it's a thin wrapper, not a
 * parallel implementation (2026-07-23 code-quality pass: it used to be one).
 */
export async function queryArchive(
  env: Env,
  queryText: string,
  filter?: ArchiveQueryFilter,
  topK = 10
): Promise<RecalledMemory[]> {
  let values: number[];
  try {
    values = await embed(env, queryText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("4006") || msg.includes("Embedding quota") || msg.includes("daily free allocation")) {
      // Quota exhausted — degrade to empty context, don't fail the whole task.
      // The idea can still be generated from the prompt alone (see handleSubmitIdea).
      return [];
    }
    throw err;
  }
  const vectorizeFilter: Record<string, string> = {};
  if (filter?.agentId) vectorizeFilter.agent_id = filter.agentId;
  if (filter?.eventId) vectorizeFilter.event_id = filter.eventId;
  if (filter?.type) vectorizeFilter.type = filter.type;

  const result = await env.ARCHIVE_VECTORS.query(values, {
    topK,
    filter: Object.keys(vectorizeFilter).length ? vectorizeFilter : undefined,
    returnMetadata: "all",
  });
  return toRecalledMemories(result.matches);
}

/**
 * Semantic recall scoped to one agent — "what has this agent said before
 * that's relevant to X." Not cross-agent; use queryArchive above (no
 * agentId filter) for archive-wide search.
 */
export async function recallMemory(
  env: Env,
  agentId: string,
  queryText: string,
  topK = 5
): Promise<RecalledMemory[]> {
  return queryArchive(env, queryText, { agentId }, topK);
}

/**
 * Recall of ONE agent's tribunal lessons only — spec §14's "synthesis
 * carries into the next event" made guaranteed instead of probabilistic.
 *
 * Before this existed, executor.ts surfaced past agent output with
 * recallMemory(), which has no type filter — so a synthesis reflection
 * (embedded by handleTribunalSynthesize with type="reflection") only
 * reached the next event's prompt if it happened to out-similarity the
 * agent's own ideas/critiques/research on the same query. Usually it
 * didn't, so the lessons sat in the archive unread. Filtering on
 * type="reflection" (Vectorize equality filter, agents/memory.ts
 * queryArchive) makes "what did I learn last time" a first-class, always-
 * present context line instead of a lottery. Same Hermes/GenericAgent
 * self-improving-agent pattern: past performance feeds the next prompt.
 */
export async function recallLessons(
  env: Env,
  agentId: string,
  queryText: string,
  topK = 3
): Promise<RecalledMemory[]> {
  return queryArchive(env, queryText, { agentId, type: "reflection" }, topK);
}

/**
 * Cosine similarity between two already-embedded vectors — for comparing
 * specific records against each other (e.g. idea deduplication), not
 * semantic search against the whole index.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Fetches the stored vectors for records already embedded via
 * rememberMemory (postIdea embeds every idea under its own id) — reuses the
 * existing embedding instead of re-embedding, and returns a Map so callers
 * can skip ids Vectorize doesn't have (shouldn't happen for ideas, but
 * getByIds silently omits unknown ids rather than erroring).
 *
 * Chunks at 20 ids per call: Vectorize rejects getByIds payloads above that
 * (VECTOR_GET_ERROR 40007 "too many ids in payload; max id count is 20").
 * Found live 2026-08-13: the autonomous ideathon c35a0401 was the first
 * event judged in score-all mode (Groq-pinned -> 36 ideas instead of the
 * 6 finalists Workers-AI-pinned events produced), and handleTeamFormation's
 * all-candidates fetch blew the cap every cron tick for ~23h.
 */
export async function getVectorsByIds(env: Env, ids: string[]): Promise<Map<string, number[]>> {
  if (ids.length === 0) return new Map();
  const vectors = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i += 20) {
    const batch = await env.ARCHIVE_VECTORS.getByIds(ids.slice(i, i + 20));
    for (const v of batch) vectors.set(v.id, Array.from(v.values));
  }
  return vectors;
}

export interface PairwiseSimilarity {
  a: string;
  b: string;
  score: number;
}

/**
 * Full pairwise cosine-similarity matrix over a set of ideas (N-1 spec §4
 * collaboration — events/scheduler.ts's queueCollaboration). Reuses
 * getVectorsByIds (one batch fetch, no re-embedding) and cosineSimilarity
 * above — same infrastructure as executor.ts's selectDistinctTop2 (P0-0b),
 * just computing every pair instead of a greedy top-2 walk. O(n^2) pairs is
 * fine at ideathon scale (36 ideas = 630 pairs, pure arithmetic on already-
 * fetched vectors, no network calls in the loop).
 */
export async function pairwiseSimilarities(env: Env, ideaIds: string[]): Promise<PairwiseSimilarity[]> {
  const vectors = await getVectorsByIds(env, ideaIds);
  const pairs: PairwiseSimilarity[] = [];
  for (let i = 0; i < ideaIds.length; i++) {
    const vecA = vectors.get(ideaIds[i]);
    if (!vecA) continue;
    for (let j = i + 1; j < ideaIds.length; j++) {
      const vecB = vectors.get(ideaIds[j]);
      if (!vecB) continue;
      pairs.push({ a: ideaIds[i], b: ideaIds[j], score: cosineSimilarity(vecA, vecB) });
    }
  }
  return pairs;
}
