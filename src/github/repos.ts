/**
 * Hackathon team repo creation — spec §12 ("one repo per hackathon team"),
 * §3.2 Day 1 ("Team formation, repo init"). Runs entirely via GitHub's REST
 * API (no git binary available inside a Worker):
 *   1. Create the repo (public, for GitHub Actions' free unlimited minutes)
 *   2. Push the harness every team needs via the Contents API — the generic
 *      build-turn workflow, the container Dockerfile, the OpenCode/Workers
 *      AI provider config, and the Workers AI shim, read live from this
 *      management repo's own master branch so team repos never drift out of
 *      sync with it — plus a README naming the idea being built and a
 *      one-time product scaffold (AGENTS.md, BACKLOG.md, .gitignore,
 *      .env.example, product CI, also read live from this repo), so the
 *      coding agent's first turn starts from a real structure instead of
 *      building an empty repo breadth-first.
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
import { countMainRepoFetch } from "../observability/subrequests";

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

/** Mirror of utf8ToBase64, for comparing a team's copy against the canonical text. */
function base64ToUtf8(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
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

async function setRepoSecret(env: Env, owner: string, repo: string, secretName: string, value: string, publicKey?: { key: string; key_id: string }): Promise<void> {
  // The repo's public key is stable for the life of the invocation, so a
  // caller setting several secrets fetches it once and passes it in. Each
  // unshared fetch is a subrequest, and team_formation is already close to the
  // Worker subrequest cap (see createTeamRepo).
  const pk = publicKey ?? await githubRequest(env, "GET", `/repos/${owner}/${repo}/actions/secrets/public-key`);
  const { key, key_id } = pk as { key: string; key_id: string };
  const encrypted_value = sealSecret(key, value);
  await githubRequest(env, "PUT", `/repos/${owner}/${repo}/actions/secrets/${secretName}`, { encrypted_value, key_id });
}

/**
 * Canonical list of every secret a team repo needs: the name, whether a build
 * turn can run without it, and which Worker env value it is sealed from.
 *
 * Single source of truth since 2026-10-15. Provisioning (ensureTeamRepoSecrets)
 * and reporting (REQUIRED/OPTIONAL_BUILD_SECRETS, read by checkTeamCredentials
 * and checkHarnessDrift) are both derived from this list, so they cannot
 * disagree — they did once: the three `_2` failover keys were provisioned but
 * unreported, and beta would have shown "runnable, nothing missing" while
 * holding no key to fail over to.
 */
const BUILD_SECRET_SPEC: ReadonlyArray<{ name: string; required: boolean; value: (env: Env) => string | undefined }> = [
  { name: "CF_ACCOUNT_ID", required: true, value: (env) => env.CF_ACCOUNT_ID },
  { name: "CF_API_TOKEN", required: true, value: (env) => env.CF_API_TOKEN },
  // Build-provider key — OpenRouter since 2026-10-13. Zen free is gated to
  // the first-party client (403 FreeTierError to any headless client,
  // verified 2026-10-12) and Groq's free tier refuses a real build-turn
  // opening request on ITPM/TPM. A new team repo needs this or every build
  // turn refuses to run — the same 27-hour outage shape as §9. The Worker env
  // value stays optional, so a Worker without it still forms teams; the
  // workflow then fails loudly rather than running a credential-less turn.
  // Groq and Zen are kept so reverting the provider is a model change, not a
  // re-scaffold.
  { name: "OPEN_ROUTER_API_KEY", required: true, value: (env) => env.OPEN_ROUTER_API_KEY },
  // The failover half of the pool pin. Without this the workflow's
  // TEAM_KEY_PIN=KEY_2 branch silently resolves to an empty key and beta
  // turns start on the "pinned pool is empty — starting on the failover
  // pool" warning path with nothing to fail over TO.
  { name: "OPEN_ROUTER_API_KEY_2", required: false, value: (env) => env.OPEN_ROUTER_API_KEY_2 },
  { name: "GROQ_API_KEY", required: false, value: (env) => env.GROQ_API_KEY },
  { name: "GROQ_API_KEY_2", required: false, value: (env) => env.GROQ_API_KEY_2 },
  { name: "OPENCODE_API_KEY", required: false, value: (env) => env.OPENCODE_API_KEY },
  { name: "OPENCODE_API_KEY_2", required: false, value: (env) => env.OPENCODE_API_KEY_2 },
];

/**
 * Pre-dispatch repair: seals and sets only the secrets a team repo is
 * MISSING, leaving every present value untouched.
 *
 * Why this exists: provisioning used to run only at createTeamRepo, so a repo
 * created before a provider switch never gained the new key — the live shape
 * on 2026-10-13, when every existing team repo lacked OPEN_ROUTER_API_KEY
 * until a human set it by hand. Drift became self-detecting on 2026-09-28
 * (checkHarnessDrift reports missingCredentials on /headroom) but nothing
 * repaired it; this runs on the dispatch path, where the cost of the bug
 * landing is a whole burned turn.
 *
 * Name-only, deliberately: GitHub's secrets API never returns values, so a
 * ROTATED value under an unchanged name is invisible here and stays a manual
 * operation (scripts/set_repo_secret.mjs). A missing NAME is the drift shape
 * a provider switch produces, and that is what this catches.
 *
 * Cost: one listing call in the steady state (dispatch already sits near the
 * free-plan subrequest cap of 50 — see createTeamRepo). A public-key GET
 * plus one PUT per missing name, only when repairing. Uses the same env
 * filter as provisioning, so a name whose Worker value is unset is never
 * "missing" — nothing could be set for it, and every dispatch would retry.
 *
 * Throws on API errors; the dispatch caller catches and proceeds, because a
 * repo we could not repair is no worse dispatched than not.
 *
 * @returns the names that were missing and got provisioned ([] = in sync)
 */
export async function ensureTeamRepoSecrets(env: Env, repoFullName: string): Promise<string[]> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return [];
  const expected = BUILD_SECRET_SPEC.filter((s) => !!s.value(env));
  if (expected.length === 0) return [];

  const res = await githubRequest(env, "GET", `/repos/${owner}/${repo}/actions/secrets`);
  const present = new Set(
    ((res as { secrets?: Array<{ name?: string }> }).secrets ?? [])
      .map((s) => s?.name)
      .filter((n): n is string => typeof n === "string"),
  );
  const missing = expected.filter((s) => !present.has(s.name));
  if (missing.length === 0) return [];

  const publicKey = await githubRequest(env, "GET", `/repos/${owner}/${repo}/actions/secrets/public-key`) as { key: string; key_id: string };
  await Promise.all(missing.map((s) => setRepoSecret(env, owner, repo, s.name, s.value(env) as string, publicKey)));
  return missing.map((s) => s.name);
}

/**
 * The harness: files a team repo needs in order to RUN a build turn, as
 * opposed to anything the agents themselves write. Kept as one list so
 * scaffolding and re-syncing can never disagree about what a team is
 * supposed to have.
 *
 * README.md is deliberately NOT here — it carries the team's idea brief and
 * is per-team content, not harness.
 *
 * Every file Dockerfile.arena-team-base COPYs into the image MUST be here:
 * a missing build-context path fails `docker build` before the agent ever
 * runs, deterministically, on every turn. Found live 2026-08-14:
 * playwright-mcp.json and docker/skills/ were added to the Dockerfile (COPY
 * lines) a week before they reached this list, so both teams' 26/26 turns
 * died at the image-build step with the repo's head_sha never moving an
 * inch. The allowlist is only a contract if new harness files are added to
 * it when the harness grows.
 */
const SKILL_PATHS = [
  "docker/skills/arena-team/SKILL.md",
  "docker/skills/code-review-and-quality/SKILL.md",
  "docker/skills/debugging-and-error-recovery/SKILL.md",
  "docker/skills/security-and-hardening/SKILL.md",
  "docker/skills/skill-creator/SKILL.md",
  "docker/skills/test-driven-development/SKILL.md",
  "docker/skills/ui-verify/SKILL.md",
  "docker/skills/verification-before-completion/SKILL.md",
  "docker/skills/verification-loop/SKILL.md",
] as const;

const HARNESS_FILES = [
  ".github/workflows/team-build-turn.yml",
  "docker/Dockerfile.arena-team-base",
  "docker/opencode.json",
  "docker/playwright-mcp.json",
  ...SKILL_PATHS,
] as const;

/**
 * The ONE-TIME product scaffold, as opposed to the harness: files a team
 * repo is seeded with at creation so the coding agent builds INTO a real
 * structure from turn 1 — agent conventions (AGENTS.md), a working task
 * list (BACKLOG.md), repo hygiene (.gitignore, .env.example), and the
 * product's own stack-detecting CI (.github/workflows/ci.yml). Rooted at
 * the repo audit's finding (2026-08-01): teams started from an empty repo
 * and never produced tests, CI, or a backlog, and a Python idea landed in
 * a node-only sandbox.
 *
 * Deliberately separate from HARNESS_FILES: that list is re-synced before
 * every turn for fairness (syncTeamHarness) and must never overwrite
 * agent-written content — BACKLOG.md in particular is the agent's working
 * document. These are seeded once, at creation. Everything under .github/
 * (including ci.yml) is arena-managed: the build-turn workflow mounts
 * .github/ read-only in the agent container and restores it to the turn-start
 * HEAD before each push, so a team repo's CI cannot diverge from what the
 * arena shipped — the arena extends ci.yml when a product needs new CI, not
 * the team.
 */
const SCAFFOLD_FILES = [
  "AGENTS.md",
  "BACKLOG.md",
  "arena.config.json",
  ".gitignore",
  ".env.example",
  ".github/workflows/ci.yml",
] as const;

/**
 * Bring a team repo's harness back in line with the main repo.
 *
 * Found live 2026-08-01: `createTeamRepo` copies these files once, at repo
 * creation, and never again — so a team formed on the 29th was still running
 * the 29th's workflow on the 1st. That team's copy had no `run-name`, which
 * is what `reconcileBuildTurns` matches a run to a turn by; without it every
 * turn fell back to positional matching and conclusions were mis-assigned
 * (turns reported `success` against runs that were cancelled). It also
 * predated the P0-0a shim, so that fix had never once executed against a real
 * turn despite being shipped and verified.
 *
 * Every fix to the build harness was landing in the main repo and reaching
 * nobody.
 *
 * **On fairness:** every team converges on the same canonical harness, each
 * immediately before its own next turn — so in principle one team can hold a
 * newer harness than its opponent for the gap between their dispatches
 * (minutes, in practice one tick). That is acceptable because the harness is
 * the scoreboard and the plumbing, not the contest: it decides whether a turn
 * RUNS and whether its result is recorded correctly, not how good the code is.
 * Teams are judged on what they write, and this touches none of it —
 * HARNESS_FILES is an allowlist for exactly that reason, so a bug here can
 * overwrite the harness but never a team's work.
 *
 * Leaving teams frozen instead is the worse trade: a team stuck on a harness
 * that mis-records its own results is not being judged fairly either.
 *
 * Content-compared before writing, so a repo already in sync costs one GET
 * per file and no commit — which matters because this runs before each
 * dispatch.
 */
export async function syncTeamHarness(env: Env, repoFullName: string): Promise<string[]> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return [];
  const updated: string[] = [];

  // Patch rather than overwrite — see ensureGitignoreTracksArtifacts for why
  // .gitignore cannot simply join HARNESS_FILES. Runs first so the negations
  // are in place before any turn can fail verification.
  try {
    const patched = await ensureGitignoreTracksArtifacts(env, repoFullName);
    if (patched.length) updated.push(`.gitignore (+${patched.join(", ")})`);
  } catch {
    // Never let a hygiene patch block a dispatch. If it fails, the turn still
    // runs; the verify report is simply lost again, which is the status quo
    // this exists to end, not a new failure mode.
  }

  for (const path of HARNESS_FILES) {
    let canonical: string;
    try {
      canonical = await fetchMainRepoFile(path);
    } catch {
      continue; // main repo unreachable for this file — leave the team's copy alone
    }

    let existing: { content?: string; sha?: string } | null = null;
    try {
      existing = await githubRequest(env, "GET", `/repos/${owner}/${repo}/contents/${path}`);
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 404) continue;
      existing = null; // absent — the shim is exactly this case on older repos
    }

    if (existing?.content) {
      // GitHub returns base64 with newlines; compare decoded text so trivial
      // encoding differences don't cause a pointless commit every dispatch.
      const current = base64ToUtf8(String(existing.content).replace(/\n/g, ""));
      if (current === canonical) continue;
    }

    await githubRequest(env, "PUT", `/repos/${owner}/${repo}/contents/${path}`, {
      message: `Sync build harness: ${path}`,
      content: utf8ToBase64(canonical),
      ...(existing?.sha ? { sha: existing.sha } : {}),
    });
    updated.push(path);
  }

  return updated;
}

/**
 * Ensures a team repo's `.gitignore` cannot ignore the harness's own
 * required-reading artifacts, WITHOUT overwriting the file.
 *
 * Why this is not just "add .gitignore to HARNESS_FILES": agents legitimately
 * edit `.gitignore` (alpha-75504818 turn 1 appended `/.pydeps/`; beta
 * c5ad953c turn 8 touched it too). `syncTeamHarness` overwrites any file whose
 * content differs from main's, so promoting it would silently delete those
 * additions on the next dispatch. The agents' lines are their work; the
 * negations are the harness's contract. Both must survive, so this appends
 * only when a required line is genuinely absent.
 *
 * Idempotent, and a no-op once the lines are present, so it costs at most one
 * GET per dispatch. The failure it prevents is severe and silent: `*.log`
 * matched `VERIFICATION_FAILURE.log`, so `git add -A` skipped the verify
 * step's report and it never reached ANY of the four team repos across two
 * events (incident §9.5) — every agent was told to read a file that could not
 * exist in its repo.
 */
const GITIGNORE_ARTIFACTS = ["VERIFICATION_FAILURE.log", "VERIFICATION_NOTE.log"] as const;

export async function ensureGitignoreTracksArtifacts(env: Env, repoFullName: string): Promise<string[]> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return [];

  let current: string;
  try {
    const res = await githubRequest(env, "GET", `/repos/${owner}/${repo}/contents/.gitignore`);
    current = base64ToUtf8(String((res as { content?: string }).content ?? "").replace(/\n/g, ""));
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
    return []; // no .gitignore at all — nothing to patch (scaffold writes one)
  }

  const missing = GITIGNORE_ARTIFACTS.filter((name) => !new RegExp(`^!${name}$`, "m").test(current));
  if (missing.length === 0) return [];

  const block = [
    "",
    "# Arena verification artifacts — tracked on purpose.",
    "# The verify step writes these; the turn prompt tells the next agent to read",
    "# them. A blanket '*.log' above would make `git add -A` skip them, so they",
    "# would never reach the repo. Appended by the arena, not overwriting: agents",
    "# add their own entries here (e.g. /.pydeps/) and those must survive.",
    ...missing.map((name) => `!${name}`),
  ].join("\n");

  const res = await githubRequest(env, "GET", `/repos/${owner}/${repo}/contents/.gitignore`);
  await githubRequest(env, "PUT", `/repos/${owner}/${repo}/contents/.gitignore`, {
    message: "Arena: track VERIFICATION_FAILURE.log / VERIFICATION_NOTE.log",
    content: utf8ToBase64(current + "\n" + block),
    ...(((res as { sha?: string }).sha) ? { sha: (res as { sha?: string }).sha } : {}),
  });
  return missing;
}

async function fetchMainRepoFile(path: string): Promise<string> {
  countMainRepoFetch();
  const res = await fetch(`https://raw.githubusercontent.com/${MAIN_REPO}/master/${path}`);
  if (!res.ok) throw new Error(`Failed to fetch scaffold file ${path} from ${MAIN_REPO}: ${res.status}`);
  return res.text();
}

/**
 * Harness-drift probe: compares each team repo's copy of the build-turn
 * workflow against this repo's, by blob SHA.
 *
 * Why this exists (found live 2026-09-28): `syncTeamHarness` re-syncs
 * HARNESS_FILES only at dispatch time, so a team repo silently drifts
 * whenever it is not actively building. Beta's copy was found 7 commits
 * behind — missing pool pinning, both failover layers, the Enforce
 * attempt-log exclusions, and the lockfile guard — one dispatch away from
 * running a pre-failover harness on a live build phase. It was caught by a
 * human remembering to check. This makes it self-detecting instead.
 *
 * Blob SHA rather than content: git hashes are content-addressed, so equal
 * SHAs mean byte-identical files regardless of commit history, and the
 * Contents API returns the sha without a second download.
 *
 * Read-only and best-effort: any failure (404, no teams, rate limit) yields
 * `error` for that repo rather than throwing, because this runs on a public
 * operator route and must never take down /headroom.
 *
 * CAUGHT A REAL BUG IN ITS FIRST HOUR (2026-09-28): a manual harness sync
 * pushed the Windows WORKING COPY rather than git's committed blob, so both
 * team repos got 948 CRLF line endings against main's 0. Bash is
 * CRLF-hostile — `set +e\r` does not parse — so a build turn on that copy
 * would have failed on its first line, hours before the build phase. Any
 * future manual sync must push `git cat-file blob <sha>` bytes, never
 * `ReadAllBytes` on the checkout.
 */
export interface HarnessDrift {
  repo: string;
  inSync: boolean;
  mainSha: string | null;
  teamSha: string | null;
  error?: string;
  /** Secrets the build workflow needs but this repo does not have. */
  missingCredentials?: string[];
  /** Secrets present that the build workflow reads opportunistically. */
  optionalCredentialsMissing?: string[];
  /** True when the repo cannot run a build turn as configured. */
  runnable?: boolean;
}

/**
 * Credentials `team-build-turn.yml` reads, split by whether their absence
 * stops a turn outright. Both lists are derived from BUILD_SECRET_SPEC — the
 * same list provisioning seals from — so reporting and provisioning cannot
 * drift apart.
 *
 * `required` is the list whose absence makes every build turn fail at the
 * workflow's own credential guard — the defect that cost event_7308f1fe a full
 * day (2026-09-30, incident §9): `createTeamRepo` never set them, and
 * `checkHarnessDrift` reported `inSync: true` on both unusable repos because it
 * only compared the workflow file's blob SHA. A green check for the wrong
 * property is worse than no check, so the invariant now spans both properties.
 *
 * `OPENCODE_API_KEY_2` is optional by design: a missing second pool means "no
 * failover attempt", not "cannot run". One pool is a degraded but working turn,
 * so it is reported separately instead of failing the check.
 */
export const REQUIRED_BUILD_SECRETS: readonly string[] = BUILD_SECRET_SPEC.filter((s) => s.required).map((s) => s.name);
// Every secret createTeamRepo provisions beyond REQUIRED. These are all
// either (a) an alternate provider kept for a cheap revert or (b) the `_2`
// half of a pool pin. Missing => "degraded but working", not "cannot run",
// so they are reported separately instead of failing the check.
export const OPTIONAL_BUILD_SECRETS: readonly string[] = BUILD_SECRET_SPEC.filter((s) => !s.required).map((s) => s.name);

export interface CredentialCheck {
  repo: string;
  runnable: boolean;
  missing: string[];
  optionalMissing: string[];
  error?: string;
}

/**
 * Verifies each live team repo holds the secrets its own build workflow reads.
 *
 * Read-only and name-only: GitHub's `GET /repos/{repo}/actions/secrets` returns
 * names and timestamps, never values, so this can run on the cron tick without
 * putting a credential anywhere it isn't already stored. A repo the token
 * cannot read is reported as an error rather than as "no missing secrets" —
 * an unanswerable question must never read as a passing one.
 */
export async function checkTeamCredentials(env: Env, repoUrls: string[]): Promise<CredentialCheck[]> {
  return Promise.all(repoUrls.map(async (repoUrl): Promise<CredentialCheck> => {
    try {
      const res = await githubRequest(env, "GET", `/repos/${repoUrl}/actions/secrets`);
      const present = new Set(
        ((res as { secrets?: Array<{ name?: string }> }).secrets ?? [])
          .map((s) => s?.name)
          .filter((n): n is string => typeof n === "string"),
      );
      const missing = REQUIRED_BUILD_SECRETS.filter((n) => !present.has(n));
      const optionalMissing = OPTIONAL_BUILD_SECRETS.filter((n) => !present.has(n));
      return { repo: repoUrl, runnable: missing.length === 0, missing, optionalMissing };
    } catch (err) {
      return {
        repo: repoUrl, runnable: false,
        missing: [...REQUIRED_BUILD_SECRETS], optionalMissing: [...OPTIONAL_BUILD_SECRETS],
        error: err instanceof GitHubApiError ? `${err.status}` : (err instanceof Error ? err.message : String(err)),
      };
    }
  }));
}

export async function checkHarnessDrift(env: Env): Promise<HarnessDrift[]> {
  const WATCH = ".github/workflows/team-build-turn.yml";
  // Only repos for a LIVE event. Scoping to active events matters: the
  // historical set is 12+ repos from completed arenas whose harness is
  // permanently frozen and irrelevant, and reporting all of them as "drifted"
  // buried the one row that mattered (first build on 2026-09-28 listed 14
  // repos, 13 of them archaeology).
  const teams = await env.DB.prepare(
    `SELECT DISTINCT t.repo_url FROM hackathon_teams t
       JOIN archive_events e ON e.id = t.event_id
      WHERE t.repo_url IS NOT NULL
        AND e.status NOT IN ('judged', 'complete', 'superseded')
        AND e.abandoned_at IS NULL
      ORDER BY t.repo_url`
  ).all<{ repo_url: string }>();

  let mainSha: string | null = null;
  try {
    const [owner, repo] = MAIN_REPO.split("/");
    const res = await githubRequest(env, "GET", `/repos/${owner}/${repo}/contents/${WATCH}`);
    mainSha = ((res as { sha?: string }).sha ?? null);
  } catch (err) {
    return teams.results.map((t) => ({
      repo: t.repo_url, inSync: false, mainSha: null, teamSha: null,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return Promise.all(teams.results.map(async ({ repo_url }): Promise<HarnessDrift> => {
    // Both properties are fetched per repo so one /headroom row answers
    // "is this repo current?" AND "can it actually run a turn?" — the second
    // question is the one that went unanswered for 27 hours on event_7308f1fe
    // (incident §9). A credential read that errors is folded into the row's
    // `error` rather than being allowed to read as a pass.
    const [contentRes, credCheck] = await Promise.all([
      githubRequest(env, "GET", `/repos/${repo_url}/contents/${WATCH}`).catch((err) => ({ __err: err })),
      checkTeamCredentials(env, [repo_url]).then(([c]) => c),
    ]);
    const creds = {
      missingCredentials: credCheck.missing,
      optionalCredentialsMissing: credCheck.optionalMissing,
      runnable: credCheck.runnable,
    };
    if ("__err" in (contentRes as object)) {
      const err = (contentRes as { __err: unknown }).__err;
      return {
        repo: repo_url, inSync: false, mainSha, teamSha: null, ...creds,
        error: [err instanceof GitHubApiError ? `${err.status}` : (err instanceof Error ? err.message : String(err)),
          credCheck.error].filter(Boolean).join("; "),
      };
    }
    const teamSha = ((contentRes as { sha?: string }).sha ?? null);
    return { repo: repo_url, inSync: teamSha === mainSha, mainSha, teamSha, ...creds };
  }));
}

export interface TeamRepoIdea {
  title: string;
  oneLiner: string;
  problem: string;
  solution: string;
  buildScope: string;
}

export interface CreateTeamRepoResult {
  fullName: string; // "org/repo" — the html URL is trivially derivable from this whenever display needs it, no need to carry both
}

/** The scaffold for a new team repo, as content rather than per-file API calls. */
interface ScaffoldFile {
  path: string;
  content: string;
}

/**
 * One seed file, then one tree, one commit, one ref. The Contents API writes
 * a commit per file, so the 20-file scaffold cost 20 PUTs; with the 19
 * template fetches and 9 secret calls, a single team_formation item measured
 * **53 subrequests against the free-plan cap of 50** on event_382ab43e
 * (2026-10-31) and retried until the watchdog abandoned the hackathon.
 *
 * A truly empty repo cannot take a tree (GitHub 409s "Git Repository is
 * empty"), so the first file seeds the branch through the Contents API. Its
 * response carries the new commit and tree SHAs, and the other 19 files land
 * in one tree commit: 4 calls instead of 20, ~38 subrequests total. A retry
 * diffs the existing tree instead of writing files that are already there.
 */
function scaffoldTree(files: ScaffoldFile[]): Array<{ path: string; mode: "100644"; type: "blob"; content: string }> {
  return files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content }));
}

async function createRootScaffoldCommit(
  env: Env, owner: string, repo: string, files: ScaffoldFile[],
): Promise<void> {
  const [seed, ...rest] = files;
  if (!seed) return;
  const first = await githubRequest(env, "PUT", `/repos/${owner}/${repo}/contents/${seed.path}`, {
    message: "Scaffold: team repo",
    content: utf8ToBase64(seed.content),
  }) as { commit?: { sha?: string; tree?: { sha?: string } } };
  const headSha = first.commit?.sha;
  const baseTree = first.commit?.tree?.sha;
  if (!headSha || !baseTree) throw new Error(`No scaffold seed commit for ${owner}/${repo}`);
  if (rest.length === 0) return;

  const tree = await githubRequest(env, "POST", `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTree,
    tree: scaffoldTree(rest),
  }) as { sha: string };
  const commit = await githubRequest(env, "POST", `/repos/${owner}/${repo}/git/commits`, {
    message: "Scaffold: team repo",
    tree: tree.sha,
    parents: [headSha],
  }) as { sha: string };
  await githubRequest(env, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, {
    sha: commit.sha,
    force: false,
  });
}

async function commitScaffold(
  env: Env, owner: string, repo: string, files: ScaffoldFile[], repoIsFresh: boolean,
): Promise<void> {
  if (files.length === 0) return;
  if (repoIsFresh) {
    await createRootScaffoldCommit(env, owner, repo, files);
    return;
  }

  // A 422 on create means an earlier attempt made the repo. Diff its tree so
  // a retry adds only what is missing and never rewrites an agent's edits.
  const info = await githubRequest(env, "GET", `/repos/${owner}/${repo}`) as { default_branch?: string };
  const branch = info.default_branch || "main";
  let headSha = "";
  try {
    const ref = await githubRequest(env, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`) as {
      object?: { sha?: string };
    };
    headSha = ref.object?.sha ?? "";
  } catch (err) {
    // Repo exists but has no commits yet (the previous attempt died before
    // the scaffold commit): seed it exactly like a fresh repo.
    if (err instanceof GitHubApiError && err.status === 404) {
      await createRootScaffoldCommit(env, owner, repo, files);
      return;
    }
    throw err;
  }
  if (!headSha) {
    await createRootScaffoldCommit(env, owner, repo, files);
    return;
  }

  const head = await githubRequest(env, "GET", `/repos/${owner}/${repo}/git/commits/${headSha}`) as {
    tree?: { sha?: string };
  };
  const headTree = head.tree?.sha;
  if (!headTree) throw new Error(`No tree on head commit for ${owner}/${repo}`);
  const tree = await githubRequest(env, "GET", `/repos/${owner}/${repo}/git/trees/${headTree}?recursive=1`) as {
    tree?: Array<{ path?: string }>;
    truncated?: boolean;
  };
  if (tree.truncated) throw new Error(`Tree too large to diff for ${owner}/${repo}`);
  const existing = new Set((tree.tree ?? []).map((e) => e.path).filter((p): p is string => !!p));
  const missing = files.filter((f) => !existing.has(f.path));
  if (missing.length === 0) return;

  const newTree = await githubRequest(env, "POST", `/repos/${owner}/${repo}/git/trees`, {
    base_tree: headTree,
    tree: scaffoldTree(missing),
  }) as { sha: string };
  const newCommit = await githubRequest(env, "POST", `/repos/${owner}/${repo}/git/commits`, {
    message: "Scaffold: missing team files",
    tree: newTree.sha,
    parents: [headSha],
  }) as { sha: string };
  await githubRequest(env, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
    force: false,
  });
}

/**
 * Creates the team's repo, scaffolds it in one tree commit (after a one-file
 * seed), and sets its secrets. Idempotent — safe to call again for the same
 * (teamName, eventId) if a prior attempt got partway through: repo creation
 * tolerates "already exists" by fetching the existing repo instead, and the
 * scaffold diffs the current tree so only missing paths are added.
 * handleTeamFormation (executor.ts) is what actually drives retries — this
 * function just needs to not blow up when called on top of earlier partial
 * progress.
 */
export async function createTeamRepo(env: Env, teamName: string, eventId: string, idea: TeamRepoIdea): Promise<CreateTeamRepoResult> {
  const repoName = `arena-team-${teamName}-${eventId.slice(-8)}`;
  const owner = env.GITHUB_ORG;

  // auto_init deliberately omitted: the Git Data API below creates the root
  // commit and `main` ref itself, so the repo must arrive empty. auto_init
  // would create a README and a branch first, and the root-commit path would
  // then try to seed a second history on top of it (the same collision the
  // old Contents API path hit on team_formation's first real run, 2026-07-21).
  let repoIsFresh = false;
  try {
    await githubRequest(env, "POST", `/orgs/${owner}/repos`, {
      name: repoName,
      private: false, // public repo required for free unlimited Actions minutes, spec §8
      description: `The Arena — Team ${teamName} building "${idea.title}" (event ${eventId})`,
    });
    // Creation succeeded, so the repo is empty (auto_init is deliberately off,
    // see below) and every path is provably absent. This is what lets
    // commitScaffold create the root commit without diffing.
    repoIsFresh = true;
  } catch (err) {
    // A retried team_formation attempt after this repo already got created
    // (e.g. the OTHER team's step is what failed last time) — reuse it
    // instead of erroring, rather than force every retry back to a fresh
    // eventId (which is what forced 3 stray test repos during Week 4
    // live testing, 2026-07-21, before this fix existed).
    if (!(err instanceof GitHubApiError && err.status === 422 && /already exists/i.test(err.body))) {
      throw err;
    }
    // Falls through with repoIsFresh === false: this repo may already hold
    // files from a partially-completed earlier attempt, so the tree diff below
    // is doing real idempotency work and must still run.
  }

  // Driven off HARNESS_FILES rather than a second hand-written list, so
  // scaffolding and syncTeamHarness can never disagree about what a team
  // needs — a file added to one and forgotten in the other is exactly how a
  // team ends up running a harness nobody intended.
  const harness = await Promise.all(HARNESS_FILES.map((p) => fetchMainRepoFile(p)));

  const readme = `# ${idea.title}\n\nTeam ${teamName} — spec §3.2 hackathon build.\n\n**One-liner:** ${idea.oneLiner}\n\n**Problem:** ${idea.problem}\n\n**Solution:** ${idea.solution}\n\n**Build scope:** ${idea.buildScope}\n\nBuilt entirely by an AI coding agent across discrete GitHub Actions build turns (spec §8) — no human-written code.\n`;

  // Load the one-time product scaffold over HTTP like the harness files
  // (fetchMainRepoFile), not from disk: this runs inside a Cloudflare Worker,
  // which has no local filesystem or node:fs at runtime, and live-fetching
  // from this repo's master branch is the one loading path this file already
  // uses — so the templates and the code that seeds them can't drift.
  const scaffold: ScaffoldFile[] = [
    { path: "README.md", content: readme },
    ...HARNESS_FILES.map((path, i) => ({ path, content: harness[i] })),
  ];
  for (const path of SCAFFOLD_FILES) {
    scaffold.push({ path, content: await fetchMainRepoFile(`repo-scaffold/${path}`) });
  }

  // Two commits for all 20 files: the first seeds the empty repo's branch,
  // the other 19 land in one tree commit. Per-file Contents PUTs measured 53
  // subrequests against the free-plan cap of 50 on event_382ab43e
  // (2026-10-31) and wedged team formation for two days.
  await commitScaffold(env, owner, repoName, scaffold, repoIsFresh);

  // List first and set only missing names: a retry is one GET, not eight
  // blind PUTs. On a fresh repo this still sets every value.
  await ensureTeamRepoSecrets(env, `${owner}/${repoName}`);

  return { fullName: `${owner}/${repoName}` };
}
