/**
 * Hackathon team repo creation — spec §12 ("one repo per hackathon team"),
 * §3.2 Day 1 ("Team formation, repo init"). Runs entirely via GitHub's REST
 * API (no git binary available inside a Worker):
 *   1. Create the repo (public, for GitHub Actions' free unlimited minutes)
 *   2. Push the same 3 files every team needs via the Contents API — the
 *      generic build-turn workflow, the container Dockerfile, and the
 *      OpenCode/Workers AI provider config, read live from this management
 *      repo's own master branch so team repos never drift out of sync with
 *      it — plus a README naming the idea being built, so the coding
 *      agent's first turn has real context.
 *   3. Set CF_ACCOUNT_ID/CF_API_TOKEN as repo secrets (GROQ_API_KEY isn't
 *      needed — the build-turn's coding agent runs on Workers AI, see
 *      docker/opencode.json's rationale).
 *
 * Secret encryption (2026-07-21, two false starts worth recording):
 *   - GitHub requires libsodium's crypto_box_seal. Web Crypto can't do
 *     X25519-XSalsa20-Poly1305 natively.
 *   - First attempt hand-rolled it on tweetnacl, deriving the nonce via
 *     SHA-512 — WRONG. Real crypto_box_seal derives the nonce via BLAKE2b
 *     (verified against libsodium's own C source), and tweetnacl only
 *     exposes SHA-512. Would have made every sealed secret undecryptable
 *     on GitHub's side.
 *   - Second attempt used libsodium-wrappers (the real, correct
 *     implementation) — but its WASM-glue file doesn't resolve under
 *     wrangler's esbuild bundler ("Could not resolve './libsodium.mjs'").
 *   - This version: tweetnacl's box() already implements the correct
 *     cipher (X25519 + XSalsa20-Poly1305, confirmed against libsodium's
 *     source) — the only piece it was missing was BLAKE2b for the nonce,
 *     supplied here by @noble/hashes (pure JS, no WASM, no bundler issues).
 */

import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2.js";
import type { Env } from "../env";
import { githubRequest, GitHubApiError } from "./client";

// The Arena's own management repo — where team repos' scaffold files (the
// generic build-turn workflow, Dockerfile, OpenCode config) are read from.
// Deliberately separate from GITHUB_ORG: the org holds TEAM repos (spec
// §12), the management repo stays under the personal account that created
// it unless explicitly migrated.
const MAIN_REPO = "sadi21863-bit/AI_arena_hackathon";

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * GitHub's documented secret-encryption algorithm = crypto_box_seal: an
 * ephemeral X25519 keypair, nonce = BLAKE2b(ephemeral_pk || recipient_pk,
 * 24 bytes), then a standard NaCl box using (message, nonce, recipient_pk,
 * ephemeral_sk). Output = ephemeral_pk || ciphertext.
 */
function sealSecret(publicKeyBase64: string, value: string): string {
  const recipientPublicKey = base64ToBytes(publicKeyBase64);
  const message = new TextEncoder().encode(value);
  const ephemeral = nacl.box.keyPair();

  const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipientPublicKey.length);
  nonceInput.set(ephemeral.publicKey, 0);
  nonceInput.set(recipientPublicKey, ephemeral.publicKey.length);
  const nonce = blake2b(nonceInput, { dkLen: nacl.box.nonceLength }); // 24 bytes

  const ciphertext = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);

  const sealed = new Uint8Array(ephemeral.publicKey.length + ciphertext.length);
  sealed.set(ephemeral.publicKey, 0);
  sealed.set(ciphertext, ephemeral.publicKey.length);
  return bytesToBase64(sealed);
}

async function setRepoSecret(env: Env, owner: string, repo: string, secretName: string, value: string): Promise<void> {
  const { key, key_id } = await githubRequest(env, "GET", `/repos/${owner}/${repo}/actions/secrets/public-key`);
  const encrypted_value = sealSecret(key, value);
  await githubRequest(env, "PUT", `/repos/${owner}/${repo}/actions/secrets/${secretName}`, { encrypted_value, key_id });
}

/**
 * Idempotent: a retried team_formation attempt (spec §17 hardening,
 * 2026-07-22 — see the retry-safety gap noted at Week 4 gate-pass) may
 * re-run this against a repo a prior attempt partially scaffolded. Content
 * per path is fully deterministic (same idea, same template files), so if
 * the file already exists there's nothing to reconcile — skip it rather
 * than fetch its sha to update, which GitHub's Contents API would
 * otherwise require.
 */
async function putFile(env: Env, owner: string, repo: string, path: string, content: string, message: string): Promise<void> {
  try {
    await githubRequest(env, "GET", `/repos/${owner}/${repo}/contents/${path}`);
    return; // already scaffolded by a prior attempt
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
  }
  await githubRequest(env, "PUT", `/repos/${owner}/${repo}/contents/${path}`, {
    message,
    content: utf8ToBase64(content),
  });
}

async function fetchMainRepoFile(path: string): Promise<string> {
  const res = await fetch(`https://raw.githubusercontent.com/${MAIN_REPO}/master/${path}`);
  if (!res.ok) throw new Error(`Failed to fetch scaffold file ${path} from ${MAIN_REPO}: ${res.status}`);
  return res.text();
}

export interface TeamRepoIdea {
  title: string;
  oneLiner: string;
  problem: string;
  solution: string;
  buildScope: string;
}

export interface CreateTeamRepoResult {
  fullName: string; // "org/repo"
  htmlUrl: string;
}

/**
 * Creates the team's repo, scaffolds it, and sets its secrets. Idempotent —
 * safe to call again for the same (teamName, eventId) if a prior attempt
 * got partway through: repo creation tolerates "already exists" by fetching
 * the existing repo instead, and every step below (scaffold files, secrets)
 * is independently idempotent too. handleTeamFormation (executor.ts) is
 * what actually drives retries — this function just needs to not blow up
 * when called on top of earlier partial progress.
 */
export async function createTeamRepo(env: Env, teamName: string, eventId: string, idea: TeamRepoIdea): Promise<CreateTeamRepoResult> {
  const repoName = `arena-team-${teamName}-${eventId.slice(-8)}`;
  const owner = env.GITHUB_ORG;

  // auto_init deliberately omitted: GitHub's Contents API can create the
  // first commit itself on a fully empty repo (no branches yet). Using
  // auto_init:true instead creates a default README.md immediately, and
  // the putFile() PUTs below don't fetch/pass its sha — GitHub's Contents
  // API requires sha to update an existing file, so every scaffold PUT
  // targeting a path auto_init already created 422s with "sha wasn't
  // supplied" (found live, 2026-07-21, team_formation's first real run:
  // README.md collided, workflow/Dockerfile/opencode.json didn't since
  // those paths don't exist in a bare auto_init README-only repo).
  let created: { html_url: string };
  try {
    created = await githubRequest(env, "POST", `/orgs/${owner}/repos`, {
      name: repoName,
      private: false, // public repo required for free unlimited Actions minutes, spec §8
      description: `The Arena — Team ${teamName} building "${idea.title}" (event ${eventId})`,
    });
  } catch (err) {
    // A retried team_formation attempt after this repo already got created
    // (e.g. the OTHER team's step is what failed last time) — reuse it
    // instead of erroring, rather than force every retry back to a fresh
    // eventId (which is what forced 3 stray test repos during Week 4
    // live testing, 2026-07-21, before this fix existed).
    if (err instanceof GitHubApiError && err.status === 422 && /already exists/i.test(err.body)) {
      created = await githubRequest(env, "GET", `/repos/${owner}/${repoName}`);
    } else {
      throw err;
    }
  }

  const [workflow, dockerfile, opencodeConfig] = await Promise.all([
    fetchMainRepoFile(".github/workflows/team-build-turn.yml"),
    fetchMainRepoFile("docker/Dockerfile.arena-team-base"),
    fetchMainRepoFile("docker/opencode.json"),
  ]);

  const readme = `# ${idea.title}\n\nTeam ${teamName} — spec §3.2 hackathon build.\n\n**One-liner:** ${idea.oneLiner}\n\n**Problem:** ${idea.problem}\n\n**Solution:** ${idea.solution}\n\n**Build scope:** ${idea.buildScope}\n\nBuilt entirely by an AI coding agent across discrete GitHub Actions build turns (spec §8) — no human-written code.\n`;

  // Sequential, not Promise.all: the repo has zero commits at this point,
  // so the first successful PUT is what creates the initial commit/default
  // branch ref. Firing all 4 in parallel races them against that same
  // ref-creation and GitHub 409s ("reference already exists") on whichever
  // loses (found live, 2026-07-21, second team_formation run after the
  // auto_init fix above). Once the first PUT lands the branch exists, so
  // the rest are ordinary sequential commits — no race left to have.
  await putFile(env, owner, repoName, "README.md", readme, "Scaffold: idea brief");
  await putFile(env, owner, repoName, ".github/workflows/team-build-turn.yml", workflow, "Scaffold: build-turn workflow");
  await putFile(env, owner, repoName, "docker/Dockerfile.arena-team-base", dockerfile, "Scaffold: container image");
  await putFile(env, owner, repoName, "docker/opencode.json", opencodeConfig, "Scaffold: OpenCode provider config");

  await Promise.all([
    setRepoSecret(env, owner, repoName, "CF_ACCOUNT_ID", env.CF_ACCOUNT_ID),
    setRepoSecret(env, owner, repoName, "CF_API_TOKEN", env.CF_API_TOKEN),
  ]);

  return { fullName: `${owner}/${repoName}`, htmlUrl: created.html_url };
}
