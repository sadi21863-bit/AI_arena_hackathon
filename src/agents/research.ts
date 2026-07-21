/**
 * Deep Research — spec §3.1: "12 agents research from 12 lenses via Exa +
 * Tavily" during Days 1-2 of the ideathon.
 *
 * Tavily is the reliable primary (genuinely free forever, no card, 1,000
 * credits/month). Exa is best-effort supplementary semantic discovery — a
 * $10 one-time free credit with no recurring refill unless a card is added
 * (see the note on Env.EXA_API_KEY). If Exa fails for ANY reason (balance
 * exhausted, rate limited, down), this degrades to Tavily-only silently —
 * a research call must never fail an agent's turn because the bonus tier
 * ran dry.
 */

import type { Env } from "../env";
import { rememberMemory } from "./memory";

export interface ResearchResult {
  source: "tavily" | "exa";
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

async function searchExa(env: Env, query: string, maxResults: number): Promise<ResearchResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": env.EXA_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, numResults: maxResults, contents: { text: true } }),
  });
  if (!res.ok) return []; // exhausted balance, rate limited, etc. — never throw, just contribute nothing
  const data: any = await res.json();
  return (data.results ?? []).map((r: any) => ({
    source: "exa" as const, title: r.title ?? r.url, url: r.url, snippet: (r.text ?? "").slice(0, 500),
  }));
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
  const maxResults = input.maxResults ?? 5;

  const [tavily, exaResults] = await Promise.all([
    searchTavily(env, input.query, maxResults),
    searchExa(env, input.query, maxResults).catch(() => [] as ResearchResult[]),
  ]);

  const results = [...tavily.results, ...exaResults];

  const summaryText = [
    `Lens: ${input.lens}`,
    `Query: ${input.query}`,
    tavily.answer ? `Summary: ${tavily.answer}` : null,
    ...results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`),
  ].filter(Boolean).join("\n");

  await rememberMemory(env, {
    id: `research_${crypto.randomUUID()}`,
    agentId: input.agentId,
    eventId: input.eventId,
    type: "research",
    text: summaryText.slice(0, 4000), // stay well under embedding model's input limits
  });

  return { results, answer: tavily.answer };
}
