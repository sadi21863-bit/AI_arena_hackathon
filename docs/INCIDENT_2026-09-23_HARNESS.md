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
can be drawn from this window. Failover fires correctly throughout and
also fails — as designed (it guards per-account quota, not upstream
outages). Testing paused: further attempts burn turns for zero
information. This is the exact scenario the dynamic throttle
(`a9b42be`) exists for — repeated attempts into a common-mode outage all
fail identically. No 429s observed: this is NOT the Zen-429 watch
triggering, and issue #8 stays open.

## Commits (main repo, all pushed)

`4a9d396` env prompt · `9526edd` model grep · `4a9d834` pinning ·
`677d39d` failover · `622d762` manual ref · `203c8ca` chain fix ·
`511ab45` env keys + guard.
