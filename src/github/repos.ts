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
 * stops a turn outright.
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
export const REQUIRED_BUILD_SECRETS = ["CF_ACCOUNT_ID", "CF_API_TOKEN", "OPENCODE_API_KEY"] as const;
export const OPTIONAL_BUILD_SECRETS = ["OPENCODE_API_KEY_2"] as const;

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
  try {
    await githubRequest(env, "POST", `/orgs/${owner}/repos`, {
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
    if (!(err instanceof GitHubApiError && err.status === 422 && /already exists/i.test(err.body))) {
      throw err;
    }
  }

  // Driven off HARNESS_FILES rather than a second hand-written list, so
  // scaffolding and syncTeamHarness can never disagree about what a team
  // needs — a file added to one and forgotten in the other is exactly how a
  // team ends up running a harness nobody intended.
  const harness = await Promise.all(HARNESS_FILES.map((p) => fetchMainRepoFile(p)));

  const readme = `# ${idea.title}\n\nTeam ${teamName} — spec §3.2 hackathon build.\n\n**One-liner:** ${idea.oneLiner}\n\n**Problem:** ${idea.problem}\n\n**Solution:** ${idea.solution}\n\n**Build scope:** ${idea.buildScope}\n\nBuilt entirely by an AI coding agent across discrete GitHub Actions build turns (spec §8) — no human-written code.\n`;

  // Sequential, not Promise.all: the repo has zero commits at this point,
  // so the first successful PUT is what creates the initial commit/default
  // branch ref. Firing all of them in parallel races them against that same
  // ref-creation and GitHub 409s ("reference already exists") on whichever
  // loses (found live, 2026-07-21, second team_formation run after the
  // auto_init fix above). Once the first PUT lands the branch exists, so
  // the rest are ordinary sequential commits — no race left to have.
  await putFile(env, owner, repoName, "README.md", readme, "Scaffold: idea brief");
  for (let i = 0; i < HARNESS_FILES.length; i++) {
    await putFile(env, owner, repoName, HARNESS_FILES[i], harness[i], `Scaffold: ${HARNESS_FILES[i]}`);
  }

  // One-time product scaffold, seeded after the harness so agents build
  // into a real structure from turn 1 (see SCAFFOLD_FILES). Loaded over
  // HTTP like the harness files (fetchMainRepoFile), not read from disk:
  // this runs inside a Cloudflare Worker, which has no local filesystem and
  // no node:fs at runtime, and live-fetching from this repo's master branch
  // is the one loading path this file already uses — so the templates and
  // the code that seeds them can't drift. putFile() skips paths that
  // already exist, so a retried team_formation attempt stays idempotent
  // without touching agent edits.
  for (let i = 0; i < SCAFFOLD_FILES.length; i++) {
    const path = SCAFFOLD_FILES[i];
    await putFile(env, owner, repoName, path, await fetchMainRepoFile(`repo-scaffold/${path}`), `Scaffold: ${path}`);
  }

  await Promise.all([
    setRepoSecret(env, owner, repoName, "CF_ACCOUNT_ID", env.CF_ACCOUNT_ID),
    setRepoSecret(env, owner, repoName, "CF_API_TOKEN", env.CF_API_TOKEN),
    // Zen pool keys (2026-09-30). Optional, so a Worker holding only one pool
    // still forms teams: the workflow treats a missing second key as "no
    // failover" rather than as a misconfiguration. Provisioning these here is
    // what stops a new hackathon from repeating the 27-hour, 14-turn outage
    // where every build turn refused to run for want of credentials.
    ...(env.OPENCODE_API_KEY ? [setRepoSecret(env, owner, repoName, "OPENCODE_API_KEY", env.OPENCODE_API_KEY)] : []),
    ...(env.OPENCODE_API_KEY_2 ? [setRepoSecret(env, owner, repoName, "OPENCODE_API_KEY_2", env.OPENCODE_API_KEY_2)] : []),
  ]);

  return { fullName: `${owner}/${repoName}` };
}
