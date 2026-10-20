# Rehearsal — beta turn 1 on the swapped build model (2026-10-18)

Purpose: validate the pinned build-model swap (nemotron-3.5-lightning ->
nvidia/nemotron-3-super-120b-a12b:free) against the real harness before the
first building-phase dispatch, and learn the actual turn shape under the
free-tier daily request cap. The swap was committed on 2026-10-18
(2618d39..bc71dbc) and synced to both team repos; lightning is still
upstream-dead.

## What ran

- Manual re-dispatch of beta turn 1 (user-approved), same turn_id as the
  original: team_9af854a7-928d-4aaf-91f5-800575320050_turn1.
- Run 39101835248 (arena-team-beta-d3e2e7be), 05:48:42Z -> 05:55:53Z, 6m33s.
- Pinned pool: KEY_2 (beta). Model: super-120b via the workflow default.

## What happened (all observed, no guesses)

- **super-120b worked.** The agent explored the repo, then wrote and tested
  real code: src/commitmentsync/main.py (+83), tests/test_main.py (+58),
  requirements.txt (+3), VERIFICATION_REPORT.md (+41), VERIFICATION_NOTE.log
  (+1), plus README/BACKLOG/.gitignore/.env.example edits. It ran its own
  mypy/flake8/pytest (3 passed) and was running bandit when killed.
- **Quota kill by design.** The in-run quota probe saw free_model_daily_requests
  remaining=0 and killed the agent container: "OpenRouter free-tier daily
  request cap exhausted (probe: remaining=0) — killing container
  arena-agent-39101835248 rather than retrying an unrecoverable wall. Quota
  resets at UTC midnight; committed work is the handoff."
- **Work preserved end-to-end.** Steps after the kill: Enforce real build
  output OK ("file changes but no commit — will be committed below" [notice]),
  Phase B install OK, Phase B verification OK (warning: pytest not installed,
  byte-compile gate only — add pytest to team requirements.txt to get a real
  test gate), Commit progress OK -> commit bdda3f6e (+208/-16) pushed at
  05:55:18Z, turn log uploaded as artifact. Only "Report agent crash" exited 1,
  marking the turn honestly incomplete.
- **Reconcile.** D1 build_turns t1: completed / failure, run 39101835248,
  head_sha d657d036. Note: head_sha is the run-ref (turn-start) HEAD, not the
  produced commit — bdda3f6e is the repo's new HEAD.
- **Quota accounting** (/api/v1/key reads at 06:0xZ, authoritative):
  KEY_2 used=54 limit=50 remaining=0 (about 4 of those were pre-dispatch
  probes at ~02:0xZ, so the turn itself consumed the full ~50 pool);
  KEY_1 used=0 limit=50 remaining=50 (fresh).

## Implications

1. Swap validated: the model explores, builds, tests, and the harness commits
   its work — the preservation pipeline survives a mid-turn hard kill.
2. New operating shape: a 50 req/day/key pool drains in ~5 minutes of agent
   work at this model's speed. Building turns are quota-bounded **partial
   turns** with committed work as the handoff, per key per UTC day.
3. Today: beta is spent (held until the 2026-10-19 UTC reset); alpha's turn 2
   (~07:20Z) runs on fresh KEY_1 and will have the same shape.
4. Candidate follow-up (not built): require pytest in the turn's
   requirements.txt so Phase B verification runs a real test gate instead of
   byte-compile only.

Artifact: build-turn-team_9af854a7-928d-4aaf-91f5-800575320050_turn1
(opencode-turn.log). Run URL:
https://github.com/AI-arena-hackathon/arena-team-beta-d3e2e7be/actions/runs/39101835248
