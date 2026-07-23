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
  // Single shared token for all 12 agents' own API calls (spec §10's "Agent
  // token" auth) — these are internal system agents, not external users, so
  // per-agent tokens would be complexity the spec doesn't ask for.
  AGENT_API_TOKEN: string;
  // Deep Research (spec §3.1) — Tavily only. Genuinely free forever, no
  // card. Exa was tried and dropped (see project memory, 2026-07-21):
  // one-time $10 credit, no sustainable free refill, and no alternative
  // provider beat Tavily's terms after checking.
  //
  // Three separate Tavily accounts (2026-07-21), round-robin'd in
  // research.ts, to pool 3x the monthly credits (~2,700 effective) instead
  // of relying on a single 1,000/month tier. TAVILY_API_KEY (singular)
  // stays as a fallback alias for local/dev use if only one key is set.
  TAVILY_API_KEY_1: string;
  TAVILY_API_KEY_2: string;
  TAVILY_API_KEY_3: string;
  TAVILY_API_KEY?: string;
  // Build Pipeline (spec §8) — dispatches team-build-turn.yml runs and
  // creates per-team repos. Classic PAT, scopes: repo + workflow. Same
  // token already used for git operations on this repo (see project
  // memory, 2026-07-21, on the cross-project-reuse tradeoff that was
  // already accepted for the main repo).
  GITHUB_TOKEN: string;
  // Org that owns hackathon team repos (spec §12: "one org, one repo per
  // hackathon team"). Falls back to a personal-account username if unset —
  // github/repos.ts treats the two the same way via the Repository
  // Creation API's owner param.
  GITHUB_ORG: string;
  // The Worker itself never calls the Cloudflare API — these exist purely
  // so github/repos.ts can inject them as repo secrets into newly created
  // team repos, which need them for their own build-turn workflow's
  // Workers AI calls (same values already in the local .env / this repo's
  // own secrets, just also readable here for that one purpose).
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}
