/**
 * A3 Step 2 — durable source identifiers for Tavily research results.
 *
 * Pure helpers with no runtime imports so they can be exercised directly by
 * Node's type-stripping test runner. The written table stores identifiers and
 * a snippet hash, never full page text. Failures are warnings: research must
 * keep working if the additive migration has not been applied yet.
 */
import type { Env } from "../env";

export interface SourceResult {
  title?: string;
  url?: string;
  snippet?: string;
}

const MAX_RECORDED_RESULTS = 5;

/** Insert the call row and return its id, which becomes research_results.call_id. */
export async function recordCallAndGetId(
  env: Env,
  eventId: string,
  agentId: string,
  phase: "ideathon" | "hackathon",
  query: string,
): Promise<string> {
  const result = await env.DB.prepare(
    `INSERT INTO research_calls (event_id, agent_id, phase, query) VALUES (?, ?, ?, ?)`,
  ).bind(eventId, agentId, phase, query.slice(0, 500)).run();
  return String(result.meta.last_row_id);
}

async function snippetHash(snippet: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snippet));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ONE batch per research call. Earlier incidents hit Cloudflare's per-
 * invocation subrequest cap, so this must not become one write per result.
 * UNIQUE(call_id, source_id) makes a queue retry safe.
 */
export async function recordResearchResults(
  env: Env,
  input: { eventId: string; agentId: string; callId: string; results: SourceResult[] },
): Promise<void> {
  const results = input.results.slice(0, MAX_RECORDED_RESULTS);
  if (results.length === 0) return;
  try {
    const hashes = await Promise.all(results.map((r) => snippetHash(String(r.snippet ?? ""))));
    const statements = results.map((r, i) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO research_results
           (event_id, agent_id, call_id, source_id, url, title, snippet_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.eventId,
        input.agentId,
        input.callId,
        `S${i + 1}`,
        String(r.url ?? "").slice(0, 2000),
        String(r.title ?? "").slice(0, 500),
        hashes[i],
      ),
    );
    await env.DB.batch(statements);
  } catch (err) {
    console.warn(`research_results write skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
