/**
 * Deep Research — spec §3.1 names Exa + Tavily; this build runs on Tavily
 * alone. Exa's free tier is a one-time $10 credit with no recurring refill
 * unless a card is added, and after checking every realistic alternative
 * (Cloudflare AI Search, Brave, Google Custom Search, Serper, self-hosting
 * on a VM/VPS/Cloudflare Containers — see project memory, 2026-07-21) none
 * beat Tavily's genuinely free-forever, no-card, 1,000-credits/month tier.
 *
 * BUDGET MATH (updated 2026-07-21 — 3-events/month cadence, pooled across
 * 3 separate Tavily accounts to give agents real room to research deeply
 * rather than rationing them):
 *   - search_depth defaults to "basic" here (see searchTavily below) = 1
 *     credit/call. "advanced" would be 2 — don't switch to it without
 *     redoing this math.
 *   - handleResearch() in executor.ts runs 4 queries per agent during
 *     deep_research (opportunities, review-of-prior-failures, target-user
 *     validation, market/funding signals), and handleCritique() runs 1
 *     grounding query per critique. Real cost per ideathon: 12 agents x 4
 *     = 48, plus ~36 critiques x 1 = 36 -> ~84 credits. Hackathon costs 0
 *     until wired to a real call site (see PER_EVENT_BUDGETS.hackathon).
 *   - 3 accounts x 1,000 credits/month = 3,000 pooled. 3 cycles/month x 84
 *     credits = 252 — 8% of the pool, leaving very wide headroom even
 *     accounting for heavy development/testing on top of real events.
 *   - Round-robin across TAVILY_API_KEY_1/2/3 (see selectTavilyKey) so load
 *     spreads evenly; no per-key exhaustion tracking needed for that to
 *     work correctly, since roughly equal call counts land on each key.
 *
 * Two independent caps still guard the pool, same shape as the single-key
 * version, just rescaled:
 *   1. PER_EVENT_BUDGETS — per-agent/team ceiling per event (20/agent
 *      ideathon, 8/team hackathon). Real usage (4-5/agent) is well below
 *      it; this exists to catch a future code change that adds call sites
 *      without anyone updating this math, not to constrain today's usage.
 *   2. MONTHLY_CEILING — hard stop at 2,700 credits/calendar-month across
 *      ALL events combined (real + test) and all 3 keys, a 300-credit
 *      buffer below the pooled 3,000 total.
 *
 * Going over either budget degrades to research-free (the agent falls back
 * on whatever it already has in RAG memory) rather than failing the turn —
 * same "never fail on a bonus running dry" principle as the dropped Exa
 * tier.
 */

import type { Env } from "../env";
import { rememberMemory, queryArchive, type RecalledMemory } from "./memory";

const PER_EVENT_BUDGETS: Record<"ideathon" | "hackathon", number> = {
  ideathon: 20, // real usage today is ~4-5/agent; this is ceiling, not target
  hackathon: 8, // per team — not wired to a real call site yet
};

const MONTHLY_CEILING = 2700; // of the pooled 3,000/month (3 accounts), 300-credit buffer held back

export interface ResearchResult {
  source: "tavily";
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

function selectTavilyKey(env: Env, callIndex: number): string {
  const keys = [env.TAVILY_API_KEY_1, env.TAVILY_API_KEY_2, env.TAVILY_API_KEY_3].filter(Boolean);
  if (keys.length === 0) {
    if (!env.TAVILY_API_KEY) throw new Error("No Tavily API key configured (need TAVILY_API_KEY_1/2/3 or TAVILY_API_KEY)");
    return env.TAVILY_API_KEY;
  }
  return keys[callIndex % keys.length];
}

async function withinPerEventBudget(env: Env, eventId: string, agentId: string, phase: "ideathon" | "hackathon"): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM research_calls WHERE event_id = ? AND agent_id = ? AND phase = ?`
  ).bind(eventId, agentId, phase).first<{ n: number }>();
  return (row?.n ?? 0) < PER_EVENT_BUDGETS[phase];
}

async function monthlyCallCount(env: Env): Promise<number> {
  const monthStart = new Date().toISOString().slice(0, 7) + "-01"; // "YYYY-MM-01"
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM research_calls WHERE created_at >= ?`
  ).bind(monthStart).first<{ n: number }>();
  return row?.n ?? 0;
}

async function recordCall(env: Env, eventId: string, agentId: string, phase: "ideathon" | "hackathon", query: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO research_calls (event_id, agent_id, phase, query) VALUES (?, ?, ?, ?)`
  ).bind(eventId, agentId, phase, query.slice(0, 500)).run();
}

async function searchTavily(apiKey: string, query: string, maxResults: number): Promise<{ results: ResearchResult[]; answer?: string }> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: maxResults, include_answer: "basic" }), // search_depth omitted = "basic" = 1 credit
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const results: ResearchResult[] = (data.results ?? []).map((r: any) => ({
    source: "tavily" as const, title: r.title, url: r.url, snippet: r.content, score: r.score,
  }));
  return { results, answer: data.answer };
}

export interface DeepResearchInput {
  agentId: string;
  eventId: string;
  lens: string;
  query: string;
  maxResults?: number;
  phase?: "ideathon" | "hackathon"; // defaults to "ideathon"
}

export interface DeepResearchOutput {
  results: ResearchResult[];
  answer?: string;
  /** Prior-event Arena history relevant to this query — see archivePriors. */
  priors?: RecalledMemory[];
  budgetExceeded?: "per_event" | "monthly";
}

/** How many past-Arena items to surface alongside the live web results. */
const ARCHIVE_PRIOR_LIMIT = 3;

/**
 * N-2 (docs/ARENA_BACKLOG.md): the Vectorize archive holds every past idea,
 * critique, judge rationale and tribunal synthesis, and Deep Research never
 * looked at any of it — agents researched the open web and their own memories
 * while the Arena's own accumulated history sat unread. For Gale ("Failure
 * Forensic — analyzes dead startups") the archive is a graveyard of ~30 dead
 * ideas per event with judge rationales explaining exactly why each lost.
 *
 * Two filters make this a feedback loop rather than an echo chamber:
 *
 *   - The current event is excluded. The point is history; pulling in ideas
 *     being written right now would just amplify whatever this event already
 *     converged on, which is the duplicate-idea failure (NEW-2) wearing a
 *     different hat.
 *   - `type: "research"` is excluded. Research summaries are themselves
 *     written back into the same index by deepResearch below, so recycling
 *     them would compound each event's digest into the next one's. Only
 *     genuine agent output (ideas, critiques, reflections) feeds back.
 *
 * Vectorize's filter syntax is equality-only, so both exclusions are applied
 * in JS over a wider fetch rather than pushed into the query.
 */
async function archivePriors(env: Env, query: string, currentEventId: string): Promise<RecalledMemory[]> {
  try {
    const matches = await queryArchive(env, query, undefined, ARCHIVE_PRIOR_LIMIT * 4);
    return matches
      .filter((m) => m.eventId !== currentEventId)
      .filter((m) => m.type !== "research")
      .slice(0, ARCHIVE_PRIOR_LIMIT);
  } catch {
    // Never fail a research call because the history lookup broke — same
    // "a bonus running dry degrades, it doesn't fail the turn" principle the
    // budget ceilings above already follow.
    return [];
  }
}

export async function deepResearch(env: Env, input: DeepResearchInput): Promise<DeepResearchOutput> {
  const phase = input.phase ?? "ideathon";

  // Monthly ceiling checked first — it protects every future event, so it
  // takes priority over a single event's own (much larger) allowance.
  const callsSoFar = await monthlyCallCount(env);
  if (callsSoFar >= MONTHLY_CEILING) {
    return { results: [], budgetExceeded: "monthly" };
  }
  if (!(await withinPerEventBudget(env, input.eventId, input.agentId, phase))) {
    return { results: [], budgetExceeded: "per_event" };
  }

  const apiKey = selectTavilyKey(env, callsSoFar); // round-robin by position in this month's call sequence
  const { results, answer } = await searchTavily(apiKey, input.query, input.maxResults ?? 5);
  await recordCall(env, input.eventId, input.agentId, phase, input.query);

  // N-2: past Arena history on the same question, alongside the live web.
  // Not counted against the Tavily budgets above — it costs one embedding,
  // not a search credit.
  const priors = await archivePriors(env, input.query, input.eventId);
  const priorsText = priors.length
    ? [
        "",
        "What the Arena already learned about this (previous events):",
        ...priors.map((p) => `- [${p.type}] ${p.text.slice(0, 300)}`),
      ].join("\n")
    : "";

  const summaryText = [
    `Lens: ${input.lens}`,
    `Query: ${input.query}`,
    answer ? `Summary: ${answer}` : null,
    ...results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`),
  ].filter(Boolean).join("\n") + priorsText;

  await rememberMemory(env, {
    id: `research_${crypto.randomUUID()}`,
    agentId: input.agentId,
    eventId: input.eventId,
    type: "research",
    text: summaryText.slice(0, 4000), // stay well under embedding model's input limits
  });

  return { results, answer, priors };
}
