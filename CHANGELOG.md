# Changelog

Recent operator-visible changes. `git log` is the full record; this file
notes what changed behavior in production and why.

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
