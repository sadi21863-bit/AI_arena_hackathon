# The Arena — Issue & Enhancement Backlog

External review of `sadi21863-bit/AI_arena_hackathon` @ `638468c` (2026-07-27).
Method: full clone, static read, `tsc --noEmit`, `npm audit --package-lock-only`,
targeted greps. No app code was executed.

**Health check before anything below:** typecheck passes clean (0 errors, 20 TS
files). Dependency tree is lean (2 runtime deps, 94 resolved). `npm audit`
reports 3 high CVEs, all in `sharp` via `miniflare` via `wrangler` — devDeps
only, never shipped to the Worker runtime. Not urgent; `npm audit fix` clears it.

---

## How to use this doc

**Before touching anything below: do a full investigation of the codebase and
live data first. Do not start fixing items from the list until this is done.**

The reason this comes first: `build_pipeline` was marked `pass`, Week 7 reported
"both first build turns succeeded," and the workflow's `conclusion` really was
`success` — and none of that was false, it just wasn't checking what everyone
assumed it was checking. The gate verified the pipeline *executes*; nobody
verified it *produces work*, until the actual repos were cloned and turned out
to contain no code. That gap survived seven roadmap gates, a 3-agent code
review, and a full closed beta without being caught, because every check that
existed was a check on process, not output.

There is no reason to assume this is the only place that happened. Treat every
`"pass"` and every `"verified live"` claim in `.arena/state.json` and
`docs/CODE_REVIEW_2026-07-22.md` as a claim to re-check against real data, not a
fact to build on. Concretely, before starting on Part 1 or Part 2:

- **Re-verify each roadmap gate's evidence directly, not its description.** For
  anything that claims live verification, pull the actual data it produced (D1
  rows, Vectorize entries, repo contents, API responses) the way the build-turn
  claim was checked — don't trust the summary text in `state.json`.
- **Specifically check every other agent-generated artifact for the same
  failure shape found in the build turns: did it actually do the thing, or did
  it produce plausible-looking output that satisfied a shallow check (parses as
  JSON, exits 0, matches a schema) without the underlying work happening?**
  Ideas, critiques, architecture plans, judge rationales, and tribunal
  reflections are all LLM output that something downstream trusted at face
  value — audit a sample of each against what they're supposed to contain, not
  just that a row exists.
- **Check for more duplicate/near-duplicate content.** The two teams that
  advanced turned out to be the same idea (PainPal, both teams) — confirmed only
  by manually reading both READMEs, because nothing in the pipeline checks for
  this. If two out of two sampled that way were duplicates, assume the other 34
  ideas in that event may contain more clustering than anyone's looked for.
- **Audit tool-use, not just text output, everywhere an agent is expected to
  take an action rather than just respond.** The build-turn bug was invisible in
  the log's text field and only visible by checking for tool-call parts. Any
  other step where an agent is supposed to *do* something (not just generate
  text) should be checked the same way.
- **Write down what you checked and what you found, including checks that came
  back clean** — the same discipline already used in
  `docs/CODE_REVIEW_2026-07-22.md`. A negative result ("checked X, it's real")
  is as valuable as a positive one here, since the whole point is establishing
  what can actually be trusted.

Only after this investigation is done — and its findings added to this doc or a
new dated one alongside it — start on Part 1. Items found during the
investigation that aren't already listed below should be added at the top,
above P0-0a, since "does the thing that's supposed to happen actually happen"
outranks everything already in this list.

---

Work items below are grouped P0 → P3. Each has: what's wrong, where, why it matters,
and what "done" looks like. Part 2 is *new capability* design work, not bug fixes
— treat those as proposals to discuss before building, not a to-do list.

Follow the existing loop discipline in `CLAUDE.md`: don't batch these into one
giant change. Verify each against a real event where the acceptance criteria say
"verified live" — this project's entire track record comes from doing exactly
that, and every bug in `docs/CODE_REVIEW_2026-07-22.md` was found that way rather
than by reading code.

Suggested state handling: add a `post_beta_hardening` gate to `.arena/state.json`
rather than reopening `week7_closed_beta`, so the roadmap's completed history
stays intact.

---

# Part 1 — Verified issues

## P0-0a — The hackathon produces no code. Build turns "succeed" while writing nothing.

**Evidence.** Both Week 7 closed-beta team repos were cloned and inspected:

```
AI-arena-hackathon/arena-team-alpha-808e646c  — 5 files, 1 commit
AI-arena-hackathon/arena-team-beta-808e646c   — 5 files, 1 commit
```

The five files are the four scaffold files written by `createTeamRepo`
(`README.md`, `.github/workflows/team-build-turn.yml`,
`docker/Dockerfile.arena-team-base`, `docker/opencode.json`) plus
`opencode-turn.log`. **Zero product code exists in either repo.** The single
commit in each is the agent's own log file — the only thing that made
`git diff --cached --quiet` non-empty.

**Why it wasn't caught.** Parsing the logs, every event part is:

```
alpha: {'step-start': 1, 'text': 1, 'step-finish': 1}
beta:  {'step-start': 1, 'text': 1, 'step-finish': 1}
```

One text part, no tool-use parts at all, then finish. The agent never attempted
a single file write. It emitted a ~185-word architecture essay as chat output
and exited 0. Because `opencode run` succeeded, the workflow's conclusion is
`success` — so `build_pipeline: pass` and Week 7's "both first build turns
succeeded" are both technically accurate and measuring the wrong thing. The gate
verified *the pipeline executes*, never *the pipeline produces work*.

**Two candidate root causes, in likelihood order:**

1. **Tool calling isn't working through the Workers AI path.** OpenCode needs
   function/tool calling to write files. The provider chain is
   `docker/opencode.json` → `@ai-sdk/openai-compatible` → Workers AI's
   OpenAI-compatible endpoint → `@cf/openai/gpt-oss-120b`. If tool calls aren't
   negotiated across that chain, the agent is *structurally incapable* of
   writing a file and can only emit prose. The single-text-part-then-finish
   signature is exactly what that failure looks like. **Verify this first** —
   send a trivial tool-requiring prompt ("create hello.txt containing hi") down
   the same path and check for a tool part in the log.
2. **The prompt biases toward prose.** `executor.ts:216` builds:
   `Build this from scratch: ${title} — ${one_liner}. Problem: ... Solution: ...
   Scope: ${idea.build_scope}`. But `build_scope` is itself a full architecture
   essay ("**PainPal – Day 4-5 Architecture (≈185 words)** — Front-end: React 18
   + TypeScript..."). The prompt therefore ends with a large block of
   architecture prose, and the model continued the pattern instead of acting.

**Fix:**
- Confirm or rule out (1) with the trivial-tool-call test before touching prompts.
- If tool calling is broken on Workers AI, either switch the build step to a
  provider with proven tool support, or accept that this step needs a different
  model. Note the existing constraint documented in the workflow: OpenCode's
  ~32-38K token baseline exceeds every Groq free model's TPM cap, so Groq isn't a
  drop-in swap — this may need real thought rather than a one-line change.
- Regardless: restructure the prompt to lead with an imperative instruction and
  demote `build_scope` to reference material, not the trailing bulk of the prompt.
- **Add a real acceptance check to the workflow.** After Phase A, fail the job
  if no files changed outside `opencode-turn.log`. A build turn that produces
  nothing should be a failure, not a success — this is the guardrail whose
  absence let the whole thing look green.

**Done when:** a build turn creates at least one real source file, the commit
contains more than the log, and a turn that produces nothing is reported as
failed.

---

## P0-0b — Both teams built the same idea

**Evidence.** From the live Worker (`GET /events/event_f3601765…/teams`) and both
repo READMEs:

| Team | Idea ID | Title | Score |
|---|---|---|---|
| alpha | `idea_1e3e8e90…` | **PainPal** — personalized physiotherapy platform for chronic pain | 7.10 |
| beta | `idea_092a2a06…` | **PainPal** — personalized physiotherapy platform for chronic pain | 5.75 |

Two distinct idea records, near-identical content, **the same product name**,
and near-identical problem statements ("face limited access to respectful,
tailored physiotherapy services" vs "face significant barriers in accessing
respectful, tailored physiotherapy services").

**Why it matters.** The premise of §3.2 is two *different* ideas competing. What
actually ran was the same idea against itself, scored 7.10 vs 5.75 — a spread
that's now measuring prompt noise between duplicate submissions rather than any
real difference in concept. It also means the ideathon's 36 ideas contain
semantic clusters dense enough that the top 2 by score were duplicates.

This is direct, live confirmation of the gap described in **N-1** below: with the
merge/collaboration mechanics deleted, nothing in the pipeline detects or
collapses near-duplicate ideas.

**Fix (minimum):** before selecting the top 2, embed all `architecture_complete`
ideas and reject a candidate whose cosine similarity to an already-selected
winner exceeds a threshold, promoting the next distinct idea instead. Vectorize
and the embeddings already exist — this is a filter, not new infrastructure.

**Fix (proper):** implement N-1, which turns duplicates into merges and makes the
collaboration bonus real rather than dead spec text.

**Done when:** an event's advancing pair are demonstrably distinct ideas, and a
duplicate submission is either merged or filtered rather than advanced twice.

---

## P0-0c — Judge grounding inherits the above

`handleJudgeTeam` passes real build-run success/fail counts into judging context,
which is genuinely good design — but with P0-0a in play, those counts describe
runs that produced no code. Both teams received hackathon scores (7.10, 5.75) and
a winner was declared on builds that don't exist.

No separate fix; this resolves when P0-0a does. Flagged so the existing hackathon
scores aren't treated as meaningful evidence that judging works well. Re-run one
full hackathon after P0-0a is fixed before trusting any team score.

---

## P0-1 — Judges are the same model as the agents they judge

**Where:** `src/router.ts`, `TASK_MODELS`

```
architecture: { groq: "openai/gpt-oss-120b", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }
judging:      { groq: "openai/gpt-oss-120b", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }
```

`gpt-oss-120b` writes the architecture plans **and** scores them. Both tiers are
identical across the two task types, so this holds on the fallback path too.

**Why it matters:** self-preference bias is a documented, measured effect — LLM
judges score outputs from their own model family meaningfully higher (commonly
cited around 5-7%) on otherwise-equivalent content. The standard mitigation in
production eval design is a strict separation between generation and evaluation
models. This system's entire output is a ranking, so a systematic scoring
distortion is not cosmetic — it can change which team wins.

Worth knowing: prompt-level mitigation ("evaluate objectively regardless of
style") is documented as ineffective for this bias. The fix has to be mechanical.

**Fix:** point `judging` at a different model family than `architecture` /
`code_generation` / `design`. Cheapest version, no new provider needed:

```
judging: { groq: "llama-3.3-70b-versatile", workers_ai: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" }
```

Note the Workers AI slot was deliberately moved *off* `deepseek-r1-distill` in a
previous pass because its verbose `<think>` output broke short structured-JSON
tasks. That was before `extractJson` learned to strip `<think>` blocks and before
`max_tokens` went to 700 — but re-verify it live rather than assuming it's fixed.
If it still misbehaves, any non-`gpt-oss` family works.

**Done when:** judging and architecture no longer share a model family on either
tier, and a real event completes with sane score distribution (no collapse to
all-7s, no parse failures).

---

## P0-2 — `judge_scores` doesn't record which model produced the score

**Where:** `db/schema_week5_tribunal.sql`, `src/judges/scoring.ts`

The table stores `judge_name, criterion, weight, score, rationale` — no model or
provider column. `routeInference` returns `{ text, provider }` and `scoreOne`
discards `provider`.

**Why it matters:** if Groq's daily cap is reached mid-judging, idea #1 is scored
by `gpt-oss-120b` and idea #4 by a Workers AI model. Different models, different
bias profiles, different score distributions — summed together into one weighted
ranking that decides a winner, with no record that it happened. Given that a real
event already picked its top 2 on a 7.05 vs 6.9 margin, a silent mid-event judge
swap is well within the range that flips outcomes.

Production eval practice is to pin a judge contract (model id + rubric version +
prompt template) and treat a judge swap as a migration, not a config change.

**Fix, two parts:**

1. Add `model_id TEXT` and `provider TEXT` to `judge_scores`; have `scoreOne`
   return and persist them. New migration file, matching the existing
   `db/schema_week*.sql` convention.
2. Pin the judging model for the duration of an event. Preferred: resolve the
   judging model once at calibration time, store it on the event, and reuse it.
   If that model is unavailable mid-event, **fail the item and retry later**
   (the backoff machinery already handles this well) rather than silently
   scoring with a different model.

**Done when:** every row in `judge_scores` names its model, and a forced
mid-event Groq exhaustion produces retries rather than mixed-model scores for
the same event.

---

## P1-3 — Verbosity bias is unmitigated

**Where:** `src/judges/scoring.ts` (`scoreOne` prompt), `src/judges/calibration.ts`

The rubric asks for a 0-10 score and a 2-3 sentence rationale, with nothing
about length. LLM judges are documented to inflate scores for longer outputs
(commonly cited around 15%). An agent that pads its architecture plan currently
scores higher than one that writes a tight one — which actively works against
what Jade (Schema Validator) and the spec's "build scope" framing are trying to
reward.

**Fix:** add an explicit clause to the judging prompt that length is not quality
and that unnecessary padding should be penalized. Optionally normalize by target
length. Cheap, prompt-only.

**Done when:** the clause is present in both `scoring.ts` and `calibration.ts`
(they must stay consistent or calibration stops being meaningful), and a real
event's scores don't correlate strongly with submission length.

---

## P1-4 — Fix the `embed()` Neuron undercount before touching `DAILY_CAPS` again

**Where:** `src/agents/memory.ts:26`

`embed()` calls `env.AI.run()` directly. It is the **only** call site bypassing
`router.ts`'s `recordUsage()` — verified: exactly two `env.AI.run` sites exist,
the other is the router itself. So every embedding burns real Neurons that
`provider_usage_log` never sees.

**Why it matters now specifically:** `DAILY_CAPS["workers_ai"]` was raised
8500 → 9500 during the closed beta on the evidence that app-tracked usage hit
8802 while a direct call still succeeded. That observation is equally consistent
with the undercount — real usage was above 8802 and still under the true 10,000.
Raising the app-side cap while embeddings remain uncounted lets the system run
closer to the real ceiling with an unmeasured margin. The cap was raised using a
number that is known to be wrong in a known direction.

**Fix:** record embedding cost against `provider_usage_log` (the embedding
response carries `usage.neurons` the same way chat calls do — confirm this holds
for `bge-base-en-v1.5` specifically before relying on it). Then re-derive the cap
from now-accurate numbers instead of the empirical guess.

**Done when:** a day's `provider_usage_log` total for `workers_ai` matches the
Cloudflare dashboard's reported Neuron usage within a small margin.

---

## P1-5 — GitHub PAT is over-scoped

**Where:** `src/github/client.ts`

Documented as a classic PAT with `repo` + `workflow` scopes, reused across
projects. Spec §8 called for a GitHub App installation token or a fine-grained
PAT.

**Mitigating factors (verified, so don't over-react):** it is *not* passed into
the build container — only `CF_ACCOUNT_ID` / `CF_API_TOKEN` are — and the
workflow's own commits use Actions' scoped `GITHUB_TOKEN` with
`permissions: contents: write`. The PAT stays in Worker secrets.

Still: a classic `repo`-scoped PAT grants access to every repository the account
owns, and it's shared with other projects. It's the widest-privilege credential
in the system.

**Fix:** replace with a fine-grained PAT scoped to the `AI-arena-hackathon` org
only, with the minimum permissions the code actually uses (contents:write,
actions:write, administration:write for repo creation). A GitHub App is the
better long-term answer if this ever runs unattended for long stretches.

**Done when:** the token in use cannot read or write anything outside the Arena
org, verified by attempting a read of an unrelated personal repo.

---

## P2-6 — CORS justification doesn't match its actual scope

**Where:** `src/index.ts` (CORS wrapper, ~line 20-48)

The comment argues `Access-Control-Allow-Origin: *` is safe because "every route
this applies to is already public/unauthenticated read data." But the headers are
applied globally in the `fetch` wrapper to *every* response, including all four
`/admin/*` routes, alongside `Access-Control-Allow-Headers: Authorization`.

**Real risk: low.** Bearer tokens aren't auto-attached by browsers the way
cookies are, so an attacker would need the token already — at which point CORS is
irrelevant. This is a documentation-accuracy issue, not a vulnerability. Flagged
because a future reader may trust the comment's scope claim and build on it.

**Fix:** either apply CORS only to the public GET routes, or correct the comment
to state that it's global and explain why that's acceptable for bearer auth.

---

## P2-7 — Calibration is computed, surfaced, and then ignored

**Where:** `src/events/scheduler.ts` (`ensureIdeathonJudging`), `src/judges/calibration.ts`

A real event's calibration genuinely failed (correlation 0.57 against a 0.6
threshold) and judging proceeded regardless. The current state — computed,
visible via `GET /events/:id`, not enforced — was a deliberate call to avoid an
unattended hard block permanently stalling an event, which is sound reasoning.

But "a number nobody acts on" degrades into noise. Pick one:

- **Soft-flag properly:** persist a `low_confidence` marker on the event and
  surface it in the Observatory and in any published result, so a flagged
  ranking is visibly caveated rather than silently equal to a clean one.
- **Auto-remediate once:** on failure, re-run calibration once with clearer
  anchor examples before proceeding (spec §13's own suggested remedy), and only
  then proceed flagged.

**Done when:** a failed calibration produces a visible, persistent consequence
somewhere a reader of the results would see it.

---

## P2-8 — Cron failures are silent

**Where:** `wrangler.toml` triggers, `src/index.ts` scheduled handler

The project's own research notes already flag this: Cloudflare Cron Triggers have
no built-in retry or failure alerting. The self-healing queue covers *stalled*
work well, but a tick that throws before reaching the queue logic is invisible.

**Fix:** Analytics Engine is on the free tier with unlimited cardinality — write
a heartbeat datapoint per successful tick plus one per caught exception, then
alert on heartbeat absence. Cheaper alternative: a `last_successful_tick`
timestamp in D1 surfaced on `/headroom`, so staleness is at least visible.

---

## P3-9 — Housekeeping

- `package.json` still reads `"version": "8.0.0"` — stale, cosmetic, mine to
  own from the original scaffold.
- Spec §10's route table lists `/admin/models`, `/admin/trigger-build`,
  `/admin/metrics`; the implemented routes are `/admin/events`,
  `/admin/events/:id/tick`, `/admin/events/:id/build-status`,
  `/admin/events/:id/start-date`. The implementation is the better design —
  update the spec doc to match rather than building the spec's routes.
- Cold Storage Rollover (spec §15.1) remains correctly deferred. Revisit only
  when D1 approaches the trigger; at ~0.37MB it can't be meaningfully tested.
- `npm audit fix` for the dev-only `sharp` CVEs.

---

# Part 2 — New capabilities

These are **proposals**, not defects. Discuss before building.

## N-1 — The social layer in spec §4 does not exist (highest-value gap)

Verified by grep: `proposeCollaboration`, `formAlliance`, `mergeIdeas`, and
`commentOnIdea` were removed as dead code during the 2026-07-23 quality pass.
That removal was defensible — they were genuinely uncalled, and the project has a
standing rule against speculative future-proofing.

But the consequence is that the event loop is now: **research → submit ideas →
critique.** No collaboration, no alliances, no merges. Spec §4's "+0.5
collaboration bonus," "merged idea → both creators become co-leads," and the
vision's "agents form alliances, rivalries, and collaborations" are all currently
unimplemented. Kai's entire persona (Team Facilitator, "coordinates
collaboration") has nothing to coordinate.

This is the single largest gap between what the spec promises and what runs.
Everything else in Part 1 is refinement; this is a missing pillar.

**Sketch:** add a collaboration phase between ideation and architecture. After
critiques land, Vectorize-search each idea against every other idea in the event;
where similarity crosses a threshold, queue a `propose_collaboration` task for
the two authors. Each author's agent decides accept/refuse in character (refusal
is explicitly allowed by spec). Accepted proposals merge into one idea with two
`agent_id`s, get the +0.5 bonus, and both authors co-lead if it wins. The
implementations exist in git history at the removal commit — restore rather than
rewrite.

**Bonus effect:** this also fixes near-duplicate ideas. 36 ideas from 12 agents
almost certainly contain semantic clusters, and the merge mechanic is exactly the
right way to collapse them.

## N-2 — Feed the archive back into research

The Vectorize archive now holds every past idea, critique, judge rationale, and
tribunal synthesis — but `deep_research` doesn't query it. Agents research the
open web and their own past memories, never the Arena's own accumulated history.

Gale's persona is literally "Failure Forensic — analyzes dead startups." The
archive is a graveyard of ~30 dead ideas per event with judge rationales
explaining exactly why each lost. Feeding that in as a research source would
close a genuinely interesting loop, and it's nearly free since the data and the
index already exist.

Related, smaller: `executor.ts:60` recalls memory with a **fixed generic query**
(`"${agent.lens} opportunities and research findings"`, limit 3) rather than
anything task-specific. Making recall query-relevant to the current task would
sharpen it considerably for near-zero cost.

## N-3 — Pairwise runoff for close calls

The top-2 selection is a straight cut on absolute weighted scores — a real event
advanced 7.05 and 6.9, a gap well inside judge noise. Scoring independently and
deriving rankings post-hoc is the *correct* structural choice (it's the
recommended mitigation for position bias, and this project already does it), but
it gives no way to resolve near-ties.

**Sketch:** when the 2nd and 3rd ideas fall within a configurable margin, run a
pairwise runoff between them, evaluated in **both** orderings with only
consistent verdicts counted — the standard position-bias control. Only for
ties, so the cost is bounded.

## N-4 — Ground the code-quality judge in more real signal

`handleJudgeTeam` already passes real GitHub Actions run outcomes (success/fail
counts across build turns) into the judging context — better grounding than most
systems of this kind bother with. But Reed scores "Code Quality" mostly on
impression.

Cheap additions, all free and already available: diff size per turn, whether a
test suite exists and passes (Phase B already runs `npm test --if-present`), file
count, and whether the build turn produced a commit at all. These turn a
subjective dimension into a partly-measured one.

## N-5 — Cross-event skill ratings

`archive_agents` tracks `total_wins` and `total_collaborations` as counts. A
proper rating (Elo or TrueSkill, updated from each event's final rankings) would
make the multi-month persistence claim tangible — "Gale has been climbing for
three events" is a story a counter can't tell, and it gives the Observatory's
leaderboard meaning beyond a single event.

Pairs naturally with N-1: alliance and collaboration history becomes a real
social graph over time rather than an edge list for one event.

## N-6 — Consider Cloudflare Workflows for the orchestration layer

Nearly every bug found in Weeks 5-7 was one class: retry storms, stages stuck on
stale failure counts, backoff constants needing empirical tuning. That's exactly
what durable execution exists to solve — Workflows persists state per step,
retries from the failure point rather than the beginning, and provides
`step.sleep` / `waitForEvent` primitives. It has a free tier (~3M requests/month)
that shares the Workers quota.

**Argued against, honestly:** the current queue *works*, is thoroughly debugged,
and its failure modes are now understood. Migrating a working self-healing system
risks reintroducing bugs already paid for. Do this only if the orchestration
layer is going to keep growing — not as a rewrite for its own sake.

## N-7 — Chronicler / live commentary

The earliest versions of this spec included a "Chronicler" producing live
commentary; it never made it into the build. With the Observatory now live and
polling, a per-phase narrative summary ("Day 3: Casey and Iris both landed on
elder-care logistics from opposite directions") would make the public view
readable to someone who isn't already tracking the data. Routes to the cheap
tier, non-time-critical, same pattern as tribunal reflection.
