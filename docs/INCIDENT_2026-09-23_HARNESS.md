# 2026-09-29 — Ideathon judged on qwen3.8; calibration broke the ceiling; a verify failure nobody read

Two firsts from the `d9d7a33f` ideathon, plus one structural gap found by
reading the finished products rather than the logs.

## 8.1 Judging debut, and the first calibration failure

`qwen/qwen3.8-27b` on Groq scored all 126 judge scores with **no fallback to
Workers AI** — the first judging pass entirely inside the primary provider, so
these 18 ideas' scores are internally comparable in a way the previous
arena's were not. Distribution healthy: range 1–9, mean 5.69, no saturation and
no all-7s collapse (the two failure modes the judge sims flagged as live
hazards). Top two, both `fresh` recycle class — NFT-KYC Hub (8.0) and
Auto-Expense Capture Assistant (7.7).

**Calibration returned 0.959 and `passed: 0`** — the first recorded failure,
and it broke the *upper* bound of the 0.60–0.95 band, not the lower one. That
bound exists to catch an overfit or over-tired judge, and the anchor details
are its textbook signature: every judge separates strong/mid/weak almost
perfectly (strong-vs-weak gaps of 5–8 points across all seven judges).

**Suspected link to our own change, not proven.** The weak-entry padding
clause was strengthened on 2026-09-27 ("score the substance first, then
subtract; padding on a 0-3 entry can never lift it out of 0-3"). If every judge
applies the same deterministic penalty their relative ordering converges —
exactly what the ceiling detects. But a single sample cannot separate
"clause over-tightened the judges" from "qwen3.8 is simply a consistent
model", and calibration has run clean on previous models. Recording it as an
open hypothesis to test against the next event's correlation, not as a cause.

**Judging proceeded anyway, and that was correct** — not the "P2-7 gap" it
first looked like. `src/events/scheduler.ts:417-425` reasons that with no human
reliably watching a live event, a hard block risks permanently stalling the
event over a single low-n (3 anchors) dip, which is worse than proceeding
flagged; the soft-flag was implemented 2026-07-28
(`docs/INVESTIGATION_2026-07-28.md:504`). The non-enforcement is a documented
trade-off, so the follow-up is not "enforce it."

**The real defect was in how the flag was worded.** The Live view reported
this failure as:

> Judge calibration failed for this Arena (correlation 0.96, **below the 0.6
> threshold**) — every score below is lower-confidence.

Wrong side of a two-sided band. The Office view and `scripts/health_check.js`
compounded it by calling every failure "low-confidence", which is false for an
over-correlation — the judges were *over*-agreeing. So the one calibration
failure the arena has ever produced that fired the new ceiling was reported to
readers as the opposite condition, pointing an operator at the wrong remedy
(loosen the anchors, add examples) for a signal that had never fired before.

Root cause is duplication, not a missing feature: `0.6` was hardcoded in a UI
string while the live check lived in `calibration.ts`, and the field was
constructed inline at four separate API sites. Fixed by making the band a
single exported constant, returning `failedSide` + the `band` with the
payload so no client restates it, and describing the side actually breached.
The one historical trap found while doing this: `event_c35a0401` stored
`passed: 1` at correlation 0.994, because the 0.95 ceiling postdates that run
— so a verifier that trusts the stored verdict alone will disagree with the
current band, which the export now reports as `calibration_band_drift` rather
than papering over.

**Residual P2-7 gap, now closed.** The backlog's "Done when" (`ARENA_BACKLOG.md:403`)
asks for the failure to be visible "somewhere a reader of the results would
see it". That was true in the Observatory but false in the frozen export
bundle, which emitted `passed: 0` as a bare row in `calibration.json` for
someone to know to look for. `manifest.json` now carries `caveats[]` with a
direction-specific message, verified against four real events.

## 8.2 A verify failure that nothing compelled any turn to read

Post-hackathon code-quality review of both team repos. Beta is clean: 8/8 CI
green, 434 lines of genuinely isolated tests (temp SQLite, PRAGMA parity,
boundary mocks), no secrets. Alpha has 2 green then **10 consecutive failures
since 2026-09-21**: `src/services/storage.ts` imports
`@aws-sdk/lib-dynamodb` at 12 sites and that package is not in
`package.json`, so `tsc` fails TS2307 on every push.

The interesting part is not the missing dependency — the interesting part is
that **every layer above it behaved exactly as designed and the bug still
shipped**:

- The verify step *did* catch it. The turn is recorded failed, with
  `VERIFICATION_FAILURE.log` committed to the repo.
- The work was still committed anyway, deliberately — "after the work was
  preserved" is the right call for an autonomous loop; losing a turn's output
  to a red typecheck is worse than keeping a red tree.
- The turn prompt instructs the next turn to read the failure log. Nothing
  checks that it did.

Alpha's own `BACKLOG.md` tells the story: "In Progress — add persistent storage
(DynamoDB/S3)" was never closed, and "keep `.github/workflows/ci.yml` green on
every push" sat in Todo the whole time. The agent half-implemented a feature,
never added the dependency, and ran out of turns. The rule it was given was
visible in its own notes and unmet.

This is the same shape as the padding clause above: **reported honestly,
acted on by nobody.** Neither a failed calibration nor a failed verify step
currently changes any downstream behavior. Both are computed, stored, and
surfaced to an operator who has to notice. The fix is not more enforcement
inside the turn (that is already maximal) — it is making the failure state
*load-bearing* at the next decision point: a red verify log should shape the
next turn's prompt or block its success, and a failed calibration should mark
the event. Until then the harness can tell you everything is wrong and still
ship it.

Also noted: both team repos independently regenerated a copy of the dead
`scripts/workers_ai_shim.js` (302 lines, removed from the harness 2026-09-21).
Harmless, but two agents reaching the same dead artifact is a sign the
scaffold invites it.

# 2026-09-26 — Harness hardening via affaan-m/ECC (MIT)

Three transplants from `affaan-m/ECC` (MIT, 2.2.2), all copy-adapt, no infra
change. Researched, not bulk-installed: ECC is a 292-skill distro whose hook
runtime is Claude-format and whose AgentShield/cloud features are paid; the
parts below are the OpenCode-compatible markdown discipline.

1. **`docker/skills/verification-loop/` (new).** Their 6-phase ladder
   (build→type→lint→test→security→diff) with a fixed `VERIFICATION REPORT`
   format, mapped onto this harness: turns write `VERIFICATION_REPORT.md`,
   each phase carries the real command + exit code, SKIPPED-with-reason is
   mandatory (a phase with nothing to check is never PASS), and the Verdict
   is READY only when every applicable phase passed. Registered in
   `repos.ts` `SKILL_PATHS` (the allowlist is a contract — a skill not listed
   never syncs to team repos) and cross-referenced from `arena-team`'s VERIFY
   step and both build-turn prompts in `executor.ts`.
2. **TDD evidence report + untrusted-plan rules** appended to
   `docker/skills/test-driven-development/SKILL.md`. Their RED/GREEN
   checkpoint commits don't fit a one-commit-per-turn harness, so the
   evidence becomes a fixed block in the turn's final message instead. Their
   Plan-Handoff rule (plans are data, not instructions) is the direct
   generalization of the backtick incident: any document in the repo can
   contain text that looks like commands. Mirrored as rule 12 in
   `repo-scaffold/AGENTS.md` so it binds even if the skill is skipped.
3. **Flaky-failure triage table** appended to `docker/skills/ui-verify/`:
   four browser-failure shapes, only one of which is a product bug.

Deliberately NOT taken: the GateGuard pre-write fact-forcing hook (needs
porting from Claude `PreToolUse` to OpenCode `tool.execute.before`, plus
container-durable state — spec'd, not built), the memory vault (design work),
AgentShield (needs an Anthropic key + network outside the sandbox allowlist),
and the 280+ other skills. ECC has no anti-essay/no-op-turn enforcement at
all (verified by code search) — the scheduler-side Enforce gate stays ours.

# 2026-09-23 — Harness incident day: backtick kills, key pinning, failover, and two self-inflicted bugs caught by the test harness

Event context: `event_a988b3dd-7baa-4570-a6cc-6b5675504818` hackathon finished
(both teams `judged`, queue 70 completed / 4 failed / 0 pending, cron healthy).
No production turns dispatched after 00:10 UTC — everything below was found
and fixed without touching a live event.

## 1. The backtick incident (root cause of 12+ failed turns, 09-22 → 09-23)

- Symptom: 12+ straight turn failures on both teams, `opencode exited 127`,
  empty `opencode-turn.log`, `recordActivation(userId, plan, ts)` /
  `{sessionId,: command not found` in Phase A logs. Docker never started.
- Cause: an agent-written BACKLOG table row containing backticks
  (`` `utm_*` ``, `` `{sessionId, url, ts}` ``) was interpolated inline into
  the Phase A bash script via `"${{ inputs.task_prompt ... }}"`. Bash
  executes backticks inside double quotes — the prompt ran as shell.
- Proof: local reproduction under Git Bash with the exact poison strings
  produced byte-identical errors (`{sessionId,: command not found`);
  env-passed values passed through intact.
- Fix (`4a9d396`): `task_prompt` travels via step-level `env: TASK_PROMPT`,
  referenced as `"$TASK_PROMPT"`. Env values are set without shell parsing
  and expansions are never rescanned.
- Live proof: manual test 001's log shows the poison strings exactly once —
  the intact env dump — with zero backtick execution.

## 2. Crash-grep hardening (`9526edd`)

- Zen's live catalog (`https://opencode.ai/zen/v1/models`, fetched 09-23)
  still lists our pinned `nemotron-3-ultra-free`, but churn is heavy
  (GPT Codex line, Sonnet 4, Kimi K2.5, MiniMax M2.5, GLM 4.x/5, Qwen3 Coder
  480B all deprecated). Groq precedent (`qwen3.6` died silently once).
- The crash-signature grep now also matches
  `model not found / unknown model / MODEL_NOT_FOUND / deprecated`, so the
  next dead model ID fails with the cause in the log.

## 3. Dual-key Zen pools → per-team pinning + same-turn failover

- Rationale: both teams shared one Zen key (one undocumented quota pool).
  Two keys on SEPARATE accounts halve per-pool burst load and de-correlate
  failures. Same-account second key shares one pool (harmless, no gain).
- Placement lesson: `secrets.X` resolves where the workflow RUNS. The
  personal-repo copies are inert for builds; the live keys resolve in the
  org team repos (beta authenticated via org-level key 1 before ever having
  a repo-level copy — evidence, not assumption).
- Final layout: both keys in both team repos
  (`arena-team-alpha-75504818`, `arena-team-beta-75504818`).
- Pinning (`4a9d834`): `TEAM_KEY_PIN` from repo name
  (`*beta*` → key 2, else key 1). Deterministic 50/50, per-team attribution.
- Failover (`677d39d`): Phase A wrapped in `run_attempt()`. If the attempt
  dies WITH a provider signature (429/quota/5xx/dead-model, incl.
  watchdog-kills caused by 429 hangs), logs archive to `attempt1.*` and the
  turn re-runs once on the other pool. Non-provider deaths (essay-exit-0,
  backtick-127) do NOT retry — pointless there. Verified via `bash -n` and
  an 8-case decision simulation, all correct.

## 4. Bug A (caught by test 001): comments inside the docker-run chain

- A comment block placed between `-e` continuation lines breaks the chain:
  line joins into the comment, next `-e` executes as a command
  (`-e: command not found`), Docker never starts, exit 127 — same code as
  the backtick bug, which is why it hid behind it.
- Introduced by the pin commit; never reached a production turn (a988 was
  already judged). Sole victim: test 001 — the harness doing its job.
- Fix (`203c8ca`): comments relocated above `docker run`; new standing
  check: between `docker run` and the backgrounded `sh -c`, zero comments
  and zero missing backslashes (asserted, 0 violations).

## 5. Bug B (caught by test 002): runner shell never sees `secrets.*`

- `secrets.X` only materializes via `${{ }}` substitution; referencing
  `$OPENCODE_API_KEY` in bash yields EMPTY. The failover commit selected
  keys in the runner shell → test 002 ran its whole turn on an empty key
  and died on a misleading `503 Upstream error from Nvidia`.
- Fix (`511ab45`): keys mapped to step env (`ZEN_KEY_1/_2`), selection uses
  those; only the ACTIVE key enters the container (`-e ZEN_ACTIVE_KEY`),
  so the sandbox never holds the spare pool's key. Plus a real fail-fast
  guard when both keys are empty (refusing a credential-less turn loudly
  instead of a mystery 503).

## 6. Manual-test `ref` bug (`622d762`)

- `manual-build-test.yml` hardcoded `ref: master` for its
  `team-build-turn` dispatch; team repos default to `main` (422s there
  since 2026-07-21). Now resolves the target repo's default branch at
  runtime. Also re-synced the fixed `team-build-turn.yml` into alpha via
  the Contents API (content-verified each time).

## 7. Test runs

| run | turn | result | meaning |
|-----|------|--------|---------|
| 35877812285 → turn 35877839705 | manual-verify-001 | Phase A failed (`-e: command not found`) | env fix PROVEN (poison intact, unexecuted); caught Bug A |
| 35879537840 → turn 35879558683 | manual-verify-002 | Phase A ok, agent ran, `503 Nvidia overloaded`, Enforce failed by design | chain fix PROVEN; caught Bug B (empty key) |
| 35880753792 → turn 35880770336 | manual-verify-003 | **FULL PASS of the harness**: attempt 1 on key 1 hit the Nvidia 503 storm → **failover fired live** (`Pinned pool errored — failing over`) → attempt 2 on key 2 ran (same storm, common-mode, also 503) → Enforce/install/verify all green → commit step failed only pushing to a remote that had moved mid-run (test artifact of running on the live management repo, not a harness bug; work preserved in the uploaded artifact) | env fix + chain fix + real-key auth + live failover ALL proven in one run |
| 35898572551 → turn 35898593174 | manual-pickle-001 (`opencode/big-pickle`) | **MODEL PASS**: exit 0 in 61s, healthy tool stream; agent hit a bad `tsc` fetch, diagnosed it, ran `npm ci`, re-ran tsc → PASS, reported faithfully | stealth model works end-to-end in the harness; fallback shelf, not pinned (identity swaps, expiring free, training-data terms) |
| burst 18:30 UTC (8 models) | mimo25/ling ran; 6 others `cancelled` in queue | Burst-dispatching 8 identical workflow_dispatches within ~40s got the queued duplicates mass-cancelled by GitHub (concurrency is `cancel-in-progress: false`, so this is platform spam-protection, not our config). Lesson recorded: stagger manual dispatches ≥3 min; production already staggers per tick. The 6 need sequential re-fire. |
| 35904323347 → turn 35904337369 | manual-ling-002 | `Unexpected server error` on both pools, twice 10 min apart | inconclusive (storm, see §10) |
| 35905566366 → turn 35905584392 | manual-nemo3-control (`opencode/nemotron-3-ultra-free`) | Same `503 Nvidia overloaded` on both pools — on the proven production model | **common-mode Zen/Nvidia outage**, not dead models; all 18:30–19:00 model verdicts suspended |
| 36016328630 → turn 36016343884 | manual-a3-proof (default nemotron) | **FULL 3-ATTEMPT CHAIN LIVE**: A1 exit 1 → pool-failover warning → A2 exit 1 → model-failover warning (`Both pools errored on opencode/nemotron-3-ultra-free — failing over to model opencode/big-pickle`) → **A3 exit 0, full tool stream, tsc executed**; Enforce failed by design | attempt-3 model failover PROVEN during a real outage — the turn that would have died now builds |

Expected shape of a passing verification: Phase A success, agent executes
the prompted `tsc --noEmit`, Enforce fails (read-only prompt → no changes
by design). The verdict comes from logs, not the conclusion.

## 8. Corrections owned

- Claimed beta would "fail its guard" without repo key 1: no such guard
  existed. (A real guard now exists — §5. Conclusion stood regardless.)
- Commit message "broke every turn since pin commit": true of the code,
  but no production turn ever ran it. Precision matters; blast radius was
  one test run.

## 9. Still open (not actionable today)
- PR inboxes (#1604, #594, #6) — silent; bump e2b ~2 weeks.
- qwen3.8 production calibration debut — next ideathon.
- Winners ritual — when the current event completes.
- Zen-429 pause — no qualifying signal (see §10 for the storm that wasn't one).
- Live failover — OBSERVED in test 003 (fired on the Nvidia 503 storm;
  both pools hit the same common-mode outage, so the retry also 503'd —
  correct behavior: per-account quota deaths, the case it guards, are
  independent, not common-mode).
- Remaining free-model evals (mimo25/26, ling, nemo35, ms12/13, ds4, jev) —
  suspended until the §10 storm clears; resume sequentially with the
  nemotron control first.
- Dropped permanently: kaushikb11 (fork deleted by owner), Python install.

## 10. Zen outage 18:30–19:00+ UTC (common-mode, not quota)

Nvidia-backed models erroring on BOTH pools simultaneously: `503 Upstream
error from Nvidia: Service temporarily overloaded` plus generic
`Unexpected server error`s. Proven common-mode by the nemotron control
(§7): the proven production model fails identically, so no model verdict
can be drawn from this window. Still ongoing 2026-09-24 14:12 UTC (19h+).
Failover fires correctly throughout and also fails — as designed (it
guards per-account quota, not upstream outages). Testing paused: further
attempts burn turns for zero information. This is the exact scenario the
dynamic throttle (`a9b42be`) exists for — repeated attempts into a
common-mode outage all fail identically. No 429s observed: this is NOT
the Zen-429 watch triggering, and issue #8 stays open.

Storm-proof exception: Big Pickle (`manual-pickle-002`, 2026-09-24 14:12
UTC) runs clean THROUGH the outage — exit 0, ~30 tool calls, full
autonomous tsc troubleshooting. Non-Nvidia upstream (presumed GLM family)
is unaffected. Implication: pool failover (accounts) cannot survive
upstream outages; only MODEL diversity can. Proposed: model-fallback
dimension (pinned model → big-pickle) as attempt 3 — needs owner approval
since it changes which model builds production code mid-event.

**Storm resolved: 2026-09-28 10:54 UTC** (~4 days, 20h total). Control
`manual-nemo3-stormcheck3` (run 36412285990): nemotron exit 0 on the
FIRST attempt, no failover, Phase B install + `--network=none` verification
+ commit all green, conclusion `success` — the first complete end-to-end
turn since 2026-09-23. Common-mode only, no 429s, no quota actions, no
code change needed. The suspended free-model evals (mimo25/26, ling,
nemo35, ms12/13, jev) can resume; `deepseek-v4-flash-free` is skipped on
evidence — upstream opencode#42977 reports it returning
`FreeUsageLimitError` continuously for 5-7 days including 1-message
requests.

## 7.1 Free-model fallback evaluation (complete — full free catalog, 2026-09-28)

Read-only prompt (run `npx tsc --noEmit`, change nothing) dispatched through
`manual-build-test.yml` with a `model` override. Verdict shape: A1/A2/A3
exits, then whether the Enforce gate passed. 1 min between dispatches
after 8 simultaneous dispatches got mass-cancelled by GitHub queueing.

| model | A1 | A2 | A3 (big-pickle) | verdict |
|---|---|---|---|---|
| `nemotron-3-ultra-free` (pinned) | 0 | — | — | **PASS** — first clean full turn since 09-23 |
| `mimo-v2.5-free` | 0 | — | — | **PASS** — all steps green incl. Enforce + commit |
| `big-pickle` | 0 | — | — | **PASS** — proven storm-proof (ran clean through the 4d20h Nvidia outage) |
| `nemotron-3.5-lightning-free` | 1 | 1 | 0 | **DEAD** — 3-attempt chain rescued the turn, Enforce then correctly failed it (no tool calls, no files) |
| `ling-3.0-flash-fin-free` | 1 | 1 | 0 | **DEAD** — same shape |
| `mimo-v2.6-flash-free` | 1 | 1 | 0 | **DEAD** — same shape (note: 2.5 passes, 2.6 does not) |
| `deepseek-v4-flash-free` | — | — | — | **SKIPPED** — upstream opencode#42977 reports it returning `FreeUsageLimitError` continuously for 5-7 days, including 1-message requests |
| `jev-1.13-free` | 1 | 1 | 0 | **NOT A CODING MODEL** — System One (TypeSafe AI): evaluates a `state` against typed questions and returns values + probabilities on `/zen/v1/systemone`, not text. Cannot be a build agent. Reclassified: candidate for the *judging* layer (calibrated probabilities), not the build layer. |
| `space-bunny-free` (stealth #2) | **132** | — | — | **DEAD — SIGILL.** Crashes the `opencode` binary itself (128+4) on attempt 1, so no provider signature and therefore **no failover fired**; Enforce correctly failed the turn. 132 is a hard crash of our own driver, not a provider error — a different failure class from the 429/503 family. |
| `muse-spark-1.2-contributor-free` | 1 | 1 | 0 | **DEAD** (429/503 family) |
| `muse-spark-1.3-contributor-free` | 1 | 1 | 0 | **DEAD** (429/503 family) |
| `longcat-2.5-preview-free` (zero-retention) | 1 | 1 | 0 | **DEAD** (429/503 family) — A3 rescued, Enforce correctly failed it |

Two distinct failure shapes worth separating, because they are NOT the same
bug and only one of them is the gate doing its job:

- **DEAD models (429/503 family)**: A1 and A2 both exit 1 with a provider
  signature, A3 rescues with exit 0 — the turn is saved by the model
  failover, then failed by Enforce because the rescued attempt wrote
  nothing. The fallback saved the run; the gate kept it honest. Correct end
  state: failed turn, nothing committed.
- **`space-bunny-free` (driver-crash class)**: exit 132 with no provider
  signature, so the failover chain correctly declined to fire — there is
  nothing to fail over from. The three-attempt design assumes provider-side
  death; a SIGILL in our own binary is outside that assumption and is caught
  only by the Enforce gate. Worth watching if more stealth models appear.

### Privacy terms of the free tier (from opencode.ai/v2/docs/console/models)

Relevant because build turns write proprietary product code and read the
arena scaffold. Training-on-prompts exceptions: `big-pickle`,
`mimo-v2.5-free`, `mimo-v2.6-flash-free`, `ling-3.0-flash-fin-free`, and
`muse-spark-1.3-contributor-free` (Meta contributor tier). Trial-logged:
both Nemotron free models (NVIDIA terms — "do not submit personal or
confidential data", and session logs are used for product improvement).
**Zero-retention:** only `space-bunny-free` and
`longcat-2.5-preview-free` — and **both are DEAD** (bunny SIGILLs the
driver, longcat 429/503s). So no verified build model is both working and
zero-retention. `mimo-v2.5-free` is the only other verified one, and its
prompts do go to training.

This table, not capability, is what decides whether a new model may be
pinned for production: a model that works but trains on our prompts is a
different decision than one that works and forgets. Re-check the free-tier
terms whenever the catalog churns.

Verdict: **3 of the 12 free models on Zen actually work as build agents.**
Working: `nemotron-3-ultra-free` (pinned), `mimo-v2.5-free`, `big-pickle`.
Dead: `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`,
`mimo-v2.6-flash-free`, `space-bunny-free` (SIGILL),
`longcat-2.5-preview-free`, `muse-spark-1.2-contributor-free`,
`muse-spark-1.3-contributor-free`. Not a coding model: `jev-1.13-free`.
Skipped on upstream evidence: `deepseek-v4-flash-free`.

(Count corrected 2026-09-29: this verdict originally read "3 of the 10" while the
enumeration above it listed 12 entries — 3 working, 7 dead, 1 non-coding,
1 skipped. The 10 was a miscount, not a change in the catalog.)

The 9-in-12 failure rate is the load-bearing fact, not a footnote: the free tier
is far thinner than its catalog suggests, which is exactly why the pinned
model plus a two-rung fallback (pool -> model) exists at all. Both team
repos re-synced to the current harness (beta was 7 commits behind).

## 7.2 Beta was 7 commits behind the harness (caught 2026-09-28)

`syncTeamHarness` re-syncs `HARNESS_FILES` before each turn, so a team repo
drifts whenever it is not actively building. Beta's copy was still
`8f40f3f7` (2026-09-22) — before pool pinning, both failover layers, the
Enforce attempt-log exclusions, and the lockfile guard. It was one dispatch
away from running a pre-failover harness on tonight's build phase. Both repos
now pinned to blob `3e7069fd`.

Takeaway: harness sync is lazy, so "the fix is committed to main" does not
mean "the team repo has it". Check the blob SHA on both repos after any
harness change during a quiet period. Now automated: `GET /headroom` carries
a `harness` array comparing each LIVE event's team repos' build-workflow
blob SHA against main (`checkHarnessDrift` in `repos.ts`).

## 7.3 CRLF in both team repos — caught by the drift probe, 8h before impact

The drift probe reported `inSync: false` for `75504818` on its first run —
a repo I had synced by hand two hours earlier and believed was fine. Cause:
**the manual sync pushed the Windows working copy instead of git's committed
blob.** `.gitattributes` normalizes the checkout to CRLF on Windows, so
`ReadAllBytes(checkout)` uploaded 948 CRLF-terminated lines against main's
0. Verified by counting CR bytes in the fetched blobs.

Impact had it shipped: bash is CRLF-hostile, so `set +e\r` fails to parse —
a build turn would have died on its first line, at the start of tonight's
build phase, on the exact harness the two days of fixing were meant to
protect. Every *previous* manual sync carried the same defect; it was simply
never exercised, because no turn dispatched during the quiet period.

Fixed by pushing `git cat-file blob <sha>` bytes (byte-exact, verified by
`git hash-object` matching the committed SHA `1bea42c1`) to both repos, and
confirmed CR=0 in the fetched content of each.

Two transferable rules, both now in the code comments:

1. **A manual harness sync must push git's blob, never the checkout.** The
   working copy is not the committed content; only the blob is.
2. **A blob-SHA comparison detects this class for free.** It is the reason
   the probe is worth its 60 lines — content diffing would have shown
   "different line endings" as noise; SHA equality is unambiguous, so a
   mismatch means *investigate*, never *ignore as harmless*.

Reusable tooling note: `cmd /c "git cat-file blob <sha> > file"` is the
byte-transparent way to extract a committed blob on Windows. PowerShell's
`>` and `[IO.File]::WriteAllText` round-trip both add CRLF and mangle
multi-byte characters (an em-dash in a commit message once produced an
invalid JSON body and an HTTP 400 — use `-Encoding`/`UTF8Encoding($false)`
for any JSON written to a file for `gh --input`).

## Commits (main repo, all pushed)

`4a9d396` env prompt · `9526edd` model grep · `4a9d834` pinning ·
`677d39d` failover · `622d762` manual ref · `203c8ca` chain fix ·
`511ab45` env keys + guard.
