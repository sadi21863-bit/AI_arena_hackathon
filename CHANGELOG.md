# Changelog

Recent operator-visible changes. `git log` is the full record; this file
notes what changed behavior in production and why.

## 2026-09-29

- **Ideathon `d9d7a33f` judged on `qwen/qwen3.8-27b` (Groq)** — the first
  production judging pass with no fallback to Workers AI. All 126 scores from
  the single model/pool, so this event's scores are internally comparable in a
  way the previous arena's were not. 18 ideas scored, range 1–9, mean 5.69, no
  saturation or all-7s collapse. Top two, both `fresh` recycle class:
  **NFT-KYC Hub (8.0)** and **Auto-Expense Capture Assistant (7.7)**.
- **Calibration failed for the first time ever: correlation 0.959 against a
  0.60–0.95 acceptance band, i.e. it broke the *upper* bound.** The anchor
  details show every judge separating the strong/mid/weak anchors almost
  perfectly, which is the over-discrimination signature the ceiling exists to
  catch. Judging proceeded regardless — **by design, not by oversight**
  (`src/events/scheduler.ts:417-425` reasons that a hard block risks
  permanently stalling an unattended event over one low-n dip; the soft flag
  was implemented 2026-07-28 per `docs/INVESTIGATION_2026-07-28.md:504`).
  **Suspected, not proven:** the strengthened weak-entry padding clause
  (2026-09-27) may be over-tightening judges into agreement. One sample
  cannot separate that from qwen3.8 simply being a consistent model; treat
  the causal link as an open hypothesis.
- **Fixed a real user-facing bug found by reading that first failure.** The
  Live view reported it as "correlation 0.96, **below the 0.6 threshold**" —
  the wrong side of a two-sided band, pointing an operator at the wrong remedy
  (loosen the anchors) for the one signal that had never fired before. The
  Office view and `scripts/health_check.js` compounded it by calling any
  failure "low-confidence", which is false for an over-correlation. Now the
  band is a single exported constant (`CALIBRATION_MIN`/`MAX`), the API
  returns `failedSide` and the `band` so no client restates the numbers, and
  every surface describes the side it actually breached. Covered by
  `scripts/calibration_verdict_test.mjs` (10 cases: live value, both
  boundaries, both failure sides, legacy payloads with no `band`).
- **Export bundles now carry calibration caveats in `manifest.json`.** P2-7's
  "Done when" — a failed calibration producing a visible consequence where a
  reader of the results would see it — was met in the Observatory but *not* in
  the frozen bundle, which shipped `passed: 0` as a bare row. Bundles now emit
  `caveats[]` with a direction-specific message. Also catches **band drift**:
  `event_c35a0401` stored `passed: 1` at correlation 0.994, above the ceiling
  that postdates it, so a bundle would otherwise claim "calibration passed".
  Verified against four real events (high fail, low fail, stored-pass drift,
  clean pass).
- **Product code-quality review of both hackathon repos** (alpha
  `75504818`, beta `75504818`). Beta is clean: 8/8 CI green, 434 lines of real
  isolated tests, no secrets. Alpha has 2 green then **10 consecutive failures
  since 2026-09-21** — `src/services/storage.ts` imports
  `@aws-sdk/lib-dynamodb` at 12 sites, and that package is absent from
  `package.json`, so `tsc` fails with TS2307. The arena's own verify step
  *did* catch it (the turn is recorded failed) but the work was still committed
  by design, and nothing compels the next turn to read
  `VERIFICATION_FAILURE.log` — alpha's own BACKLOG still lists "keep ci.yml
  green" as an open TODO. Same shape as the missing dependency: reported
  honestly, acted on by nobody.
- Both team repos independently regenerated a copy of the dead
  `scripts/workers_ai_shim.js` (302 lines, removed from the harness
  2026-09-21). Harmless but dead weight, and a sign the scaffold misleads.
- Conduct finding recorded for post-event analysis: cumulative strikes blocked
  17/36 ideas and touched 8/12 agents, vs ~2.4/12 agents expected by simulation.
  Thresholds deliberately left unchanged mid-event.

## 2026-09-28

- `GET /headroom` now reports **harness drift**: each live event's team
  repos' build-workflow blob SHA vs main. Added after beta was found 7
  commits behind and one dispatch from running a pre-failover harness.
- Fixed a CRLF defect the probe caught within an hour: manual harness syncs
  were pushing the Windows working copy instead of git's committed blob, so
  both team repos carried 948 CRLF line endings — bash would have failed on
  the first line of tonight's build phase. Re-synced byte-exact.
- Lockfile churn no longer counts as build output. `npm`/`pip` rewrite
  lockfiles during the install phase, and that rewrite was satisfying the
  "Enforce real build output" gate — so a turn that wrote no product code
  could report success. Lockfiles are now excluded from the gate's
  change-detection and from the watchdog, and a commit-step guard restores
  them when they are the only change a turn produced. Package.json still
  counts, so genuine dependency work is unaffected. Verified in a scratch
  repo across 6 cases (churn-only, real work + churn, dependency change +
  churn, failure-log + churn, pure no-op, untracked new lockfile).
- Free-model evaluation completed across all 12 discovered Zen free-model
  entries: **3 work** (`nemotron-3-ultra-free`, `mimo-v2.5-free`,
  `big-pickle`), 7 dead, 1 is not a coding model (`jev-1.13-free`), 1 skipped
  on upstream evidence. (Corrected 2026-09-29 from "all 10 / 5 dead" — the
  original miscount; catalog contents were not re-measured.)
- Confirmed the Zen/Nvidia common-mode outage (2026-09-23 → 09-28, ~4d20h)
  resolved.

## 2026-09-26

- Adopted three discipline patterns from `affaan-m/ECC` (MIT): the
  `verification-loop` skill (6-phase ladder → `VERIFICATION_REPORT.md`,
  wired into both build-turn prompts and the team skill), a TDD evidence
  report (RED/GREEN/suite counts in the turn message) plus
  untrusted-plan rules in the TDD and scaffold skills, and a browser
  flake-triage table in `ui-verify`.
- `postIdea` coalesces agent-supplied fields to NULL (one submit died with
  an opaque `D1_TYPE_ERROR` on an undefined field, 2026-09-25).

## 2026-09-24

- Attempt-3 model failover: both pools failing the pinned model re-runs
  the turn once on `opencode/big-pickle` (default, dispatch-overridable).
  Proven live during the Nvidia outage — the turn that would have died
  now builds. Big Pickle runs clean through the storm (non-Nvidia
  upstream); remaining free-model evals stay suspended until it clears.
- Reverted a test turn's `package.json` churn on the management repo
  (agent ran `npm install` against a read-only prompt).

## 2026-09-23

- Build-turn prompt travels via environment, not inline interpolation —
  an agent-written BACKLOG row with backticks executed as shell and killed
  12 straight turns with exit 127 (`4a9d396`).
- One Zen key pinned per team (alpha→key 1, beta→key 2) with same-turn
  failover on provider-error signature; only the active key enters the
  sandbox; fail-fast guard when both keys are empty.
- Crash-grep covers dead/deprecated model IDs (Zen catalog churns).
- Manual test dispatches to the repo's default branch (was hardcoded
  `master`, 422 on team repos); Enforce/watchdog ignore failover
  `attempt1.*` diagnostics.
- Docs: providers deep-dive folded into budget research §9, architecture
  comparison folded into conduct spec §10, stale headers corrected
  (Office proposal, redesign plan), week-0 READMEs de-retired script refs.

## 2026-09-21

- Dead Workers AI shim removed from build turns (proven zero-traffic);
  prompt-injection-safe task passing; staggered team dispatches.
- `spike-turn.yml` renamed `manual-build-test.yml`; Week-0 gate scripts retired.

## 2026-09-20

- Observatory `?kiosk` query hides nav/context/footer for OBS capture.
- Office inspector shows cross-event Elo (N-5 ratings were computed but invisible).
- Ideas Board cards show harshest-judge rationale excerpt + conduct recycle chip.
- Nav dims phase-irrelevant instruments; arena switcher label deduped.
- Orphaned Graph/Replay views removed (live as Arena tabs); empty/error states carry retry/reason/link.
- New "What's new" delta view (`/events/:id/changes` + Live card).
- Office sprite-clump fix (group-shift spread math).

## 2026-09-19

- Predictive capacity pause (`paused_capacity`): parks events when both
  inference pools can't cover a phase, resumes after UTC reset. Caught and
  fixed its own permanent-park bug the next day via a live event.
- Orphaned hackathon `8d24ba01` (576 dead queue rows) deleted via admin cleanup route.
- Judging probe re-run on `qwen3.8-27b`; Mason outlier retested clean (8/9.5/9).

## 2026-09-17

- Groq judging moved `qwen3.6-27b` → `qwen3.8-27b` (both predecessors
  decommissioned; verified `model_not_found` live). Dead llama caps removed.
- Build turns: model via dispatch input, unused `GROQ_API_KEY` dropped,
  provider-error crash signatures, push-credential fallback documented.
- Main-repo CI, `.env.example`, headroom near-cap flags, CONTRIBUTING, MIT license, repo topics.

## 2026-09-16 and earlier

- See git history (`post_beta_hardening` era): revision gate, architecture
  recall grounding, superpowers skill adoptions, calibration overfit guard,
  same-SHA judging guard, intra-event dedupe, AGENTS.md doc reset.
