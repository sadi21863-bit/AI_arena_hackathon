# Pre-Part-1 investigation — 2026-07-28

Required by `ARENA_BACKLOG.md` (external review @ `638468c`) before touching any
item in that doc: re-verify gate claims against real data, sample other
agent-generated artifacts for the same "looks-done-but-isn't" failure shape as
P0-0a, check for more duplicate ideas, and audit tool-use everywhere an agent
is supposed to act. Method below is the same as the backlog doc's own standard:
pull real data (live Worker API, GitHub API via the project's own token, a
direct API call to the inference endpoint), not summaries.

Repo state checked: `638468c` (same commit the backlog review ran against —
confirmed via `git log`, nothing has changed since).

---

## New findings (highest priority — read before starting Part 1)

### NEW-1 — Workers AI tool-calling works fine. The P0-0a root cause is the prompt, not the provider.

P0-0a listed two candidate causes and asked to verify #1 first: "send a trivial
tool-requiring prompt down the same path and check for a tool part in the log."
Did exactly that — a direct `POST` to
`https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1/chat/completions`
with `model: "@cf/openai/gpt-oss-120b"` (the exact model `docker/opencode.json`
configures), a `write_file` tool schema, and the prompt "Create a file named
hello.txt containing the text 'hi'. Use the write_file tool to do this now."

Result: `finish_reason: "tool_calls"`, with a well-formed
`tool_calls: [{"function":{"name":"write_file","arguments":"{\"content\": \"hi\", \"path\": \"hello.txt\"}"}}]`.
**The model calls tools correctly over this exact endpoint when given an
unambiguous imperative instruction.** Root cause #1 (tool-calling structurally
broken on the Workers AI path) is ruled out by direct test, not inference.

Then checked root cause #2 directly against source and a real log:

- `src/events/executor.ts:216` (`handleTeamFormation`, unchanged at current
  HEAD): `taskPrompt: \`Build this from scratch: ${idea.title} — ${idea.one_liner}. Problem: ${idea.problem}. Solution: ${idea.solution}. Scope: ${idea.build_scope}\``.
  `idea.build_scope` at this point is not a short scope string — it's the full
  ~185-word Day 4-5 architecture essay written by `handleArchitecture`
  (confirmed by reading it directly from the live API, e.g. PainPal's
  `build_scope`: `"**PainPal – Day 4‑5 Architecture (≈185 words)** ... **Tech‑stack** ... **Fallback scope** ..."`).
- Pulled `opencode-turn.log` from the real `arena-team-alpha-808e646c` repo via
  the GitHub API. The model's one and only text part is that *exact* PainPal
  architecture essay, reproduced near-verbatim as prose continuation — not a
  new artifact, not a tool call, not even a paraphrase. `step-start` →
  `text` → `step-finish`, nothing else.

Conclusion: the model isn't incapable of tool calls — it's being handed a
prompt that ends in a long block of essay-formatted prose and it continues the
pattern instead of switching modes. This matches the trivial test's contrast
exactly: a short imperative prompt with no trailing prose → tool call; a long
architecture essay tail → prose continuation. **Fix should be the prompt
restructure the backlog doc already proposed (imperative lead, demote
`build_scope` to reference material) — not a provider swap.**

**Fix applied and live-verified same day.** Restructured both build-turn
prompts in `src/events/executor.ts` (turn 1 in `handleTeamFormation`, turn 2+
in `handleDispatchBuildTurn`) to lead with an explicit "write code now / use
your tools" instruction and demote `build_scope` to a trailing
guidance-only block. Added a real acceptance-check step to
`team-build-turn.yml` ("Enforce real build output") that fails the job if
`git status --porcelain -- . ':!opencode-turn.log'` is empty after Phase A —
the exact guardrail the backlog doc asked for.

Verified live by dispatching a real `workflow_dispatch` against
`arena-team-alpha-808e646c` (already-complete from the closed beta, safe to
re-test against) using the new prompt shape for its actual idea (PainPal).
**Confirmed: the agent immediately called `glob` to inspect the repo, `read`
README.md, then `write .gitignore`, then `write client/package.json` with
real React/MUI dependencies** — a complete behavioral change from the old
prompt's zero-tool-calls essay. This directly confirms the root-cause
diagnosis: it was the prompt, not the provider.

**But this surfaced a second, independent bug**: after the third tool call,
the run hit `{"type":"error","error":{"name":"UnknownError","data":{"message":"Expected 'id' to be a string."}}}`
and `opencode run` exited 1, failing the job before the "Commit progress"
step ever ran — so nothing was actually pushed. This looks like a schema
mismatch between OpenCode (installed fresh from `curl https://opencode.ai/install`
at every image build, so always "latest," not pinned) and Workers AI's
OpenAI-compatible response shape, most likely surfacing partway through a
multi-turn tool exchange rather than on the first call (the first 3 tool
calls all completed fine). Not investigated further this pass — would need
either reproducing locally against a pinned OpenCode version to bisect, or
checking OpenCode's own issue tracker for this exact error against a custom
`openai-compatible` provider. **P0-0a is not fully closed**: the prompt-bias
half is fixed and proven, but a build turn still can't complete end-to-end
and commit real code until this second crash is resolved too. The new
acceptance-check step in the workflow will correctly fail loud on this rather
than reporting false success, at least.

Not yet done: pushing these two commits (`src/events/executor.ts`,
`.github/workflows/team-build-turn.yml`) to the main repo. Until pushed,
`createTeamRepo`'s `fetchMainRepoFile` (which pulls the workflow/prompt setup
live from the main repo at team-creation time) will keep handing new teams
the old, unfixed workflow file.

**Follow-up same session: the crash reproduces outside the sandbox as a clean success, which relocates the bug.**
Installed `opencode-ai@1.18.8` locally (`npm install opencode-ai`, no Docker
available in this environment) and ran the *exact* same prompt, model
(`workers-ai/@cf/openai/gpt-oss-120b`), and `docker/opencode.json` provider
config directly against the real Workers AI account — no container, no Squid
proxy, no read-only rootfs, no `HOME=/tmp` tmpfs, real filesystem instead of
the bind-mounted `/workspace`.

**Result: complete success.** 17 steps, a full client+server scaffold
written (`client/package.json`, `tsconfig.json`, `webpack.config.js`,
`public/index.html`, `src/index.tsx`, `src/App.tsx`, `server/package.json`,
`server/tsconfig.json`, `server/src/index.ts`, `server/.env.example`,
`.gitignore`, updated `README.md`), ending in a clean
`step-finish reason="stop"` and a real closing summary message — no
`"Expected 'id' to be a string"` error anywhere in stdout or `--log-level
DEBUG` stderr.

Also tried to reproduce the error via raw multi-turn API calls (simulating an
assistant tool-call message + tool result + continuation) directly against
Workers AI's endpoint. Found one real, separate compatibility wrinkle along
the way — Workers AI's schema validator rejects the standard OpenAI
convention of `content: null` on an assistant message with `tool_calls`
(`"Type mismatch of '/messages/2/content', 'string' not in 'null'"`), only
accepting a string like `""`. But this isn't the actual crash's cause: the
real GitHub Actions run got through *four* successful multi-turn tool-call
round trips (which would all have required correctly-serialized history)
before failing on the fifth — if the SDK were sending literal `null` and
Workers AI rejected it, the very first continuation would have failed, not
the fifth. Worth fixing as a latent risk, but ruled out as this bug's cause.

**Implication: the crash is very likely specific to the GitHub Actions
sandbox (Squid proxy, read-only rootfs + tmpfs `/tmp`, non-root uid, or
`HOME=/tmp` redirecting OpenCode's own state/cache) rather than a
fundamental OpenCode↔Workers AI incompatibility.** The identical
prompt/model/provider combination that crashes at turn ~5 in the real
sandboxed container runs clean to completion with no sandbox at all. This
reframes P0-0a's remaining piece from "fix an upstream library bug" (open-
ended, no access to OpenCode's source from here) to "bisect which specific
container restriction breaks a long-running multi-step OpenCode session" —
a much more tractable, in-repo fix, but confirming *which* restriction is
responsible requires either local Docker (not available in this
environment) or further live GitHub Actions runs that strip back one
sandbox restriction at a time (proxy, tmpfs size, `HOME` path) — each
costs a real CI run + Workers AI usage, so this was paused here rather than
run blind. Prime suspect, given OpenCode's own `$HOME/.local` config/cache
behavior (documented in `Dockerfile.arena-team-base`'s own comments) and a
noexec `tmpfs` mounted at `/tmp` sized only for `HOME=/tmp`: something
OpenCode writes under `$HOME` for multi-step session bookkeeping may not
tolerate that combination past a handful of steps.

### NEW-2 — The duplicate-idea bug is systemic self-duplication within ideation, not two agents converging. P0-0b's scope is bigger than one pair.

Pulled all 36 ideas from the actual week7 closed-beta ideathon
(`event_e5415c58-99b1-4c96-aaca-6cd583c252e4`) via `GET /ideas?event_id=...`
and grouped by submitting agent (each agent submits exactly 3). Result — **10
of 12 agents' 3-idea batches are the same idea restated 2-3 times**, either
under an identical title or a cosmetically reworded one, with near-identical
`problem`/`target_user` text:

| Agent | Titles | Verdict |
|---|---|---|
| casey | PainPal / PainPal / PainPal | identical (same problem/target_user, minor paraphrase) |
| alex | FrictionFinder ×3 | same concept, same problem statement, reworded |
| jade | Schema Sentinel / SchemaShield / SchemaShield | 2 of 3 word-for-word identical one-liner |
| ellis | AutoFlow ×3 | same concept, reworded |
| blake | Regulatory Waveguide Companion / Waveguide Compliance Toolkit ×2 | same concept, reworded |
| gale | ForensiLens / ForensicLens / ForensicForge | same concept, reworded |
| iris | SecureHub / Career Transition Assistant / Career Transition **Tool** | 2 of 3 literally identical one-liner |
| kai | IdeaMerger / IdeaMeld / IdeaMerge | same concept (ironic: Kai's persona is the collaboration facilitator) |
| drew | 3 fintech-compliance variants | same concept, reworded |
| hale | 3 translation/brand-voice variants | same concept, reworded |
| finn | Authenticity Atlas ×3 (same title) | **actually distinct** — 3 different problem framings (personal, corporate, cultural) under a reused name |
| leo | ChronoLens / EchoPlex / PatternVault | 2 of 3 overlap (historical-pattern tools), 3rd (antique sewing patterns) is unrelated |

Of the 36, only 6 reached `status='judged'` (5 distinct agents: casey ×2,
ellis, blake, gale, leo). The two that advanced to the hackathon were the
**top 2 by `ideathon_score`** — 6.35 and 6.20 — which are literally casey's
two duplicate PainPal submissions, the two highest scores of the six judged.
This is the exact, fully-traced mechanism behind the backlog doc's P0-0b
finding: not two independent agents converging on a similar idea, but one
agent's copy-pasted idea occupying both of the two open slots because nothing
between ideation and top-2 selection de-duplicates *within* an agent's own
batch, let alone across agents.

This matters for scoping the fix: P0-0b's "minimum fix" (embed-similarity
filter immediately before top-2 selection) would have caught this specific
case, but the underlying gap is upstream — nothing about how `handleSubmitIdea`
runs three times per agent varies the second and third calls at all (same
prompt, same recalled-memory query, no awareness of what the agent already
submitted). Worth checking before or alongside the N-1 collaboration/merge
work: does the idea-generation prompt need to see the agent's own prior
submissions this event, to explicitly push toward a different angle on the
third call?

### NEW-3 — A documented "fixed" claim has never actually been re-observed in live data (smaller instance of the same pattern as P0-0a)

`state.json`'s `week7_closed_beta` gate (and the code comment at
`executor.ts:78-89`) describes finding, live, that only 1 critic was queued
per idea instead of the spec's 3, and fixing it to `LIMIT 3`. Confirmed the
fix is present in current source. But pulling the actual timeline for
`event_e5415c58` — the same event this fix was diagnosed against, and the
same event `state.json` cites as "verified_live_full_cycle" for
`week7_closed_beta` — shows **the unfixed pattern**: 33/36 ideas have exactly
1 critique, 3 have zero (0 self-critiques, so critique *quality* isn't in
question — just count).

This isn't a false claim — `state.json`'s wording accurately describes what
was found and that the code was then changed — but the fix's effect has never
actually been observed against live output, because the bug was found and
patched *after* this event's ideation/critique phase had already run, and no
ideation phase has executed since. Flagged rather than filed as a bug: next
real ideathon event should be checked for exactly this (3 critiques per idea,
distinct non-self critics) before treating it as closed.

---

## Re-checked and found genuinely OK (negative results, recorded per the doc's own standard)

- **Architecture plans (`build_scope` for all 6 judged ideas)**: read in full.
  Each is a distinct, idea-specific technical plan — different stacks
  (DynamoDB vs Postgres+pgvector vs SQLite, Twilio vs Cytoscape.js, etc.),
  different named risks, different fallback scopes. Not template filler
  reused across ideas.
- **Critique content**: sampled several of the 33 real critique rows — real
  structured `{strength, weakness, suggestion}` JSON, specific to the target
  idea's actual problem/solution, not generic. 0/33 self-critiques (an agent
  critiquing its own idea) — the `WHERE id != ?` exclusion in the critic query
  works.
- **Tribunal reflections**: sampled `event_f3601765`'s tribunal data (36
  rows = 12 individual + 12 cross-exam + 12 synthesis, matching
  `state.json`'s claim). Content is genuinely personalized first-person
  reflection referencing the agent's own actual behavior pattern that event,
  not boilerplate.
- **P0-1 (judge/architecture model collision)**: re-checked `src/router.ts`
  at current HEAD — `judging` and `architecture` still both route to
  `groq: "openai/gpt-oss-120b"` / `workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"`.
  The backlog doc's claim is accurate and still unfixed.
- **Tool-use audit beyond build turns**: team formation, repo creation, and
  GitHub Actions dispatch are done directly by the Worker's own TypeScript
  code (`src/events/executor.ts`, `src/github/*`), not by an LLM call — no
  tool-use risk there by construction. Idea submission, critique, architecture,
  judging, and tribunal reflection are all pure text-in/JSON-out tasks with no
  action-taking expectation. **The build turn is the only LLM-driven step in
  the entire pipeline expected to take a real action (write a file)** — so
  P0-0a is very likely the *only* instance of the "plausible text instead of
  the actual action" failure shape in this codebase, not one of several. This
  narrows (doesn't eliminate) the concern the backlog doc raised about
  auditing tool-use everywhere.

---

## Not reached this pass (time-boxed, flagged rather than skipped silently)

- Full re-verification of the `week1_cloudflare_foundation` through
  `week4_build_system` gate evidence against live D1/Vectorize data — spot
  checks above (router config, tool-calling, ideas/critiques/tribunal) covered
  the higher-risk later gates; the earlier infra gates (D1 schema, Vectorize
  index, R2 bucket existing) are lower-risk claims (existence, not "produces
  correct work") and weren't re-pulled.
- Raw `judge_scores` rows (rationale text, verbosity-vs-score correlation for
  P1-3) — no API route exposes this table directly; would need a D1 query via
  `wrangler d1 execute` (not installed locally; `npx wrangler` wasn't
  attempted this pass). Recommend as a fast follow before acting on P1-3.
- A full second read of `docs/CODE_REVIEW_2026-07-22.md` against current code
  (only skimmed for format/convention) — nothing in this pass contradicted it,
  but it wasn't independently re-verified line by line.

---

## P0-0b minimum fix — applied and verified against real data

Implemented the backlog's suggested minimum fix: `handleTeamFormation`
(`src/events/executor.ts`) now fetches *all* judged ideas for the parent
ideathon (not just the top 2), fetches their already-stored Vectorize
embeddings via a new `getVectorsByIds` (`src/agents/memory.ts`, reuses the
embedding `postIdea` already writes — no re-embedding cost), and greedily
walks the score-sorted list picking the top 2 whose cosine similarity to
each other is below a threshold, skipping and promoting the next distinct
idea otherwise (`selectDistinctTop2`). Falls back to the plain top-2 cut if
fewer than 2 sufficiently-distinct ideas exist, so team formation still
always produces 2 teams — a low-diversity event should be caught upstream by
NEW-2's ideation-diversity fix, not silently reduced to fewer teams here.

**Threshold calibrated against real embeddings, not guessed** (this
project's own CLAUDE.md standing rule against unmeasured placeholder
numbers): pulled real vectors from the `arena-archive-vectors` Vectorize
index via Cloudflare's REST API for three known categories —

| Pair type | Example | Cosine similarity |
|---|---|---|
| Identical idea resubmitted | PainPal vs PainPal (casey) | 0.990 |
| Same concept, reworded | FrictionFinder x3 (alex) | 0.946 – 0.974 |
| Genuinely different ideas | 6 cross-agent pairs sampled | 0.586 – 0.742 |

Set `DUPLICATE_SIMILARITY_THRESHOLD = 0.90` — sits in the wide gap between
the reworded-duplicate floor (0.946) and the genuinely-different ceiling
(0.742).

**Verified against the real closed-beta event's actual data** (not just
typecheck): re-ran the new selection logic against
`event_e5415c58`'s real 6 judged ideas and their real stored vectors.
Old logic's result (what actually happened): PainPal (6.35) + PainPal
(6.20) — the live P0-0b bug. New logic's result: PainPal (6.35) + PatternVault
(5.90) — the duplicate correctly skipped and the next distinct idea
promoted.

Not done as part of this fix (deliberately, out of scope for the minimum
fix): the upstream ideation-diversity gap from NEW-2 (nothing varies an
agent's 2nd/3rd idea-generation call), and the full N-1 collaboration/merge
mechanic. This fix only prevents the *symptom* (two teams building the same
idea) from this exact event's data — it doesn't stop agents from continuing
to submit near-duplicate idea batches.

## Net effect on `ARENA_BACKLOG.md`

- **P0-0a**: root cause narrowed from "two candidates, verify #1 first" to
  "#1 ruled out by direct test, #2 confirmed by source + live log — fix the
  prompt, not the provider." The acceptance-check recommendation (fail the
  job if no files changed) stands regardless.
- **P0-0b**: confirmed and widened. The embed-similarity filter at top-2
  selection is still the right minimum fix, but it's treating a symptom —
  10/12 agents produced self-duplicate batches this event. Worth raising
  alongside N-1 rather than as a narrow filter-only patch.
- **New, smaller item**: verify the critique-count fix (NEW-3) against the
  next real ideathon event's live data before considering it closed.
