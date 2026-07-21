/**
 * Deep Research — spec §3.1 names Exa + Tavily; this build runs on Tavily
 * alone. Exa's free tier is a one-time $10 credit with no recurring refill
 * unless a card is added, and after checking every realistic alternative
 * (Cloudflare AI Search, Brave, Google Custom Search, Serper, self-hosting
 * on a VM/VPS/Cloudflare Containers — see project memory, 2026-07-21) none
 * beat Tavily's genuinely free-forever, no-card, 1,000-credits/month tier.
 * Simpler to run one reliable provider than one reliable + one that quietly
 * degrades.
 */

import type { Env } from "../env";
import { rememberMemory } from "./memory";

export interface ResearchResult {
  source: "tavily";
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

async function searchTavily(env: Env, query: string, maxResults: number): Promise<{ results: ResearchResult[]; answer?: string }> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: maxResults, include_answer: "basic" }),
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
}

export interface DeepResearchOutput {
  results: ResearchResult[];
  answer?: string;
}

export async function deepResearch(env: Env, input: DeepResearchInput): Promise<DeepResearchOutput> {
  const { results, answer } = await searchTavily(env, input.query, input.maxResults ?? 5);

  const summaryText = [
    `Lens: ${input.lens}`,
    `Query: ${input.query}`,
    answer ? `Summary: ${answer}` : null,
    ...results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`),
  ].filter(Boolean).join("\n");

  await rememberMemory(env, {
    id: `research_${crypto.randomUUID()}`,
    agentId: input.agentId,
    eventId: input.eventId,
    type: "research",
    text: summaryText.slice(0, 4000), // stay well under embedding model's input limits
  });

  return { results, answer };
}
