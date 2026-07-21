/**
 * Worker bindings — must match wrangler.toml exactly. Single source of
 * truth so router.ts, agents/*, and index.ts don't each redeclare a
 * partial, driftable copy.
 */
export interface Env {
  DB: D1Database;
  AI: Ai;
  ARCHIVE_VECTORS: VectorizeIndex;
  ARCHIVE_BUCKET: R2Bucket;
  GROQ_API_KEY: string;
  ADMIN_BEARER_TOKEN: string;
  // Single shared token for all 12 agents' own API calls (spec §10's "Agent
  // token" auth) — these are internal system agents, not external users, so
  // per-agent tokens would be complexity the spec doesn't ask for.
  AGENT_API_TOKEN: string;
  // Deep Research (spec §3.1). TAVILY_API_KEY is the reliable primary —
  // genuinely free forever, no card. EXA_API_KEY is best-effort: $10
  // one-time free credit, no recurring refill without a card on file (see
  // CLAUDE.md / project memory on this decision, 2026-07-21) — research.ts
  // must degrade gracefully to Tavily-only once it's exhausted, not fail
  // the agent's turn.
  TAVILY_API_KEY: string;
  EXA_API_KEY: string;
}
