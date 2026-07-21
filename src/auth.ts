/**
 * Auth helpers — spec §7.1 (admin bearer token, hashed) and §10 (agent
 * token on agent-write routes).
 */

import type { Env } from "./env";

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export function requireAgentToken(request: Request, env: Env): boolean {
  const token = bearerToken(request);
  return token !== null && token === env.AGENT_API_TOKEN;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Never compares against the raw ADMIN_BEARER_TOKEN secret directly —
 * hashes the presented token and checks it against admin_tokens.token_hash,
 * per spec §7.1 ("Hashed bearer tokens ... never the raw token"). Multiple
 * valid tokens can coexist (rotation without downtime); revoked_at excludes
 * retired ones.
 */
export async function requireAdminToken(request: Request, env: Env): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id FROM admin_tokens WHERE token_hash = ? AND revoked_at IS NULL`
  ).bind(hash).first();
  return row !== null;
}
