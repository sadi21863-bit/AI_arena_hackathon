# Code review — 2026-07-22

Three-agent review (deep bug/security/spec review, code-quality/simplification pass, web+GitHub research on the underlying stack). Findings below; checked off as fixed.

## Critical

- [x] **`team-build-turn.yml` Phase A container has no real network restriction**, despite comments claiming it's scoped. Fixed: Squid forward proxy on the runner + Docker's `DOCKER-USER` iptables chain to DROP any container-originated traffic that doesn't go through it, allowlisting only `api.cloudflare.com` (Workers AI) + `registry.npmjs.org` (verified these are the only 2 domains the container actually needs by reading `docker/opencode.json` + `Dockerfile.arena-team-base` directly). **Verified live** via a real workflow_dispatch run: proxy setup succeeded, and the request reached `api.cloudflare.com` with a genuine authenticated Cloudflare response (real `cf-ray`, cookies) — the run's only failure was an unrelated stale `CF_API_TOKEN` repo secret (since fixed) returning a real 401, not a network-path problem. HTTPS CONNECT-proxying never decrypts request content, so the proxy architecturally cannot have caused that 401 either. Bonus find along the way: a genuine pre-existing YAML bug (an unquoted colon in a step name) was silently breaking `workflow_dispatch`/`repository_dispatch` recognition for this file entirely — fixed as part of getting this verification to run at all.
- [x] **Retry-safety fix never backported.** Backported the per-item (`status != 'failed'`) idempotent check to `deep_research`/`ideation_critique` (per-agent), `architecture` (per-idea, reusing `queuedPayloadValues`), `team_formation`, and daily `dispatch_build_turn` in `src/events/scheduler.ts`.
- [x] **`judge_scores` can accumulate duplicate rows on retry.** Fixed: per-judge-name idempotency check (not all-or-nothing count), `INSERT OR IGNORE`, plus a genuine `UNIQUE(target_type, target_id, phase, judge_name)` index as defense in depth (`db/schema_week5b_judge_scores_unique.sql`).

## Important

- [x] Calibration's pass/fail result is computed and stored but never actually checked. Fixed to at least be **visible** (`GET /events/:id` now returns `calibration: {correlation, passed}`) rather than silently discarded — deliberately not turned into a hard block, since an unattended false block risks permanently stalling a real event over a low-n (3 anchor) correlation dip. Verified live: the earlier ideathon's real calibration run actually **failed** (correlation 0.57, below the 0.6 threshold) and this was completely invisible until this fix — a genuine finding, not just a hypothetical.
- [x] `POST /inference` had zero auth. Fixed: gated behind `requireAgentToken`, verified live (401 without a token).
- [ ] Implemented `/admin/*` routes don't match what the spec's route table apparently lists — left as-is, this is a product/spec-reconciliation decision (add the missing routes, or update the spec table) rather than a bug fix, out of scope for this pass.

## Code quality — all applied 2026-07-23

- [x] `queuedPayloadValues` extracted to a new shared `src/events/payload-utils.ts` (alongside a new `countPayloadFieldMatches`), imported by both `scheduler.ts` and `executor.ts` instead of a hand-rolled duplicate.
- [x] Added `requirePayloadField` to `payload-utils.ts`; replaced 6 near-identical parse+check preambles across `executor.ts`'s task handlers with it.
- [x] `ensureTribunalReflections` now reuses `isStageComplete`, matching the other two Tribunal stages.
- [x] Removed `commentOnIdea`, `proposeCollaboration`, `formAlliance`, `mergeIdeas` from `agents/interactions.ts` — fully-correct implementations but genuinely zero callers anywhere (confirmed via repo-wide grep), and no scheduler/executor path ever decided to invoke them. Also removed the now-fully-dead `propose_collaboration` task type from `queue.ts` and its no-op switch case in `executor.ts`. **Judgment call, not automatic**: these are spec-required interaction types (§4) — deleted per this project's own standing rule against speculative future-proofing, not because the feature is unwanted. If agent-collaboration mechanics get built in a later week, restore from git history (this commit) rather than rewriting from scratch.
- [x] Removed dead exports: `router.ts`'s redundant `Env` re-export and `InferenceRequest`'s `export` keyword (still used internally, just not by any other file), `repos.ts`'s unused `CreateTeamRepoResult.htmlUrl` field, `env.ts`'s vestigial `ADMIN_BEARER_TOKEN` binding (real admin auth goes entirely through the hashed `admin_tokens` D1 table — this secret was declared but never once read). `wrangler.toml`'s secret comment updated to match reality.
- [x] `memory.ts`'s duplicated Vectorize→`RecalledMemory` mapper eliminated more fully than just extracting the mapper: `recallMemory` is actually a special case of `queryArchive` (agent-scoped filter only), so it now delegates to it directly instead of maintaining a parallel implementation.

## Research findings (informational / future consideration)

- **Actionable**: Groq's `reasoning_effort: "low"` parameter (documented for `gpt-oss-120b`) attacks the cause of the reasoning-token-truncation bug fixed today, rather than just widening `max_tokens`.
- Vectorize metadata string filters truncate at 64 bytes — fine today, worth remembering if filters expand beyond `agentId`/`eventId`/`type`.
- Cloudflare Cron Triggers have no automatic retry/failure alerting — self-healing covers stalls, but a hard-throwing tick is silent.
- GitHub's Contents-API-on-a-fresh-repo race (already found/fixed live) matches a documented class of "acted before async repo-init finished" bugs — if a future feature calls branch protection or PR creation right after `createTeamRepo`, add the same defensive retry.
- `github/client.ts`'s `githubRequest()` has no retry/backoff on 403/429/5xx — low risk at current (2-team) scale, worth adding if team count grows.
- Published multi-agent-debate research shows judge bias *amplifies* after the first round — relevant to Tribunal's cross-examination stage (pairs an agent with whoever critiqued it most). Flagged as a known risk area, not fixed.
- 7 stray test repos under the `AI-arena-hackathon` org from earlier live testing — harmless, manual cleanup only (no `delete_repo` scope on the current token).

## Not re-flagged (already known, see `.arena/state.json`)
- Workers AI `DAILY_CAPS` undercounting because `agents/memory.ts`'s `embed()` calls aren't recorded against router usage tracking.
- Cold Storage Rollover (spec §15.1) — explicitly deferred.
