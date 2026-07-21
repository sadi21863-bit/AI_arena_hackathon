/**
 * GitHub REST API client — spec §8: "the Cloudflare Worker calls GitHub's
 * REST API to start a workflow run, authenticated with a GitHub App
 * installation token or fine-grained PAT stored as a Worker secret."
 * This build uses a classic PAT (scopes: repo, workflow — same one already
 * used for git operations, see project memory on the cross-project reuse
 * tradeoff).
 */

import type { Env } from "../env";

const API_BASE = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
  }
}

export async function githubRequest(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "the-arena-worker",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new GitHubApiError(res.status, text, `GitHub API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }

  if (res.status === 204) return null; // No Content (e.g. workflow_dispatch)
  return res.json();
}
