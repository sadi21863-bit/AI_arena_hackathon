# Week 0 — Feasibility Spike

Two gates, both real, neither needs any VM signup.

> **Status note (2026-09-20):** both gates below passed 2026-07-21 — this file
> is now the manual for the probes, which serve as regression harnesses, not
> entry gates. `judge_bias_probe.js` in particular tracks the pinned judging
> model (`TASK_MODELS.judging` in `src/router.ts`): when the judging model
> rotates, update its `MODEL` const + `reasoning_effort` and re-run before
> trusting the new model (see `judge_bias_results*.json` for run history).

## 1. Inference probe (`inference_pool_probe.js`)

Tests both tiers of the spec §6 routing order — Groq, then Cloudflare
Workers AI — against real accounts, using prompts shaped like the actual
task types (`summarize`, `judging`, `architecture`).

```bash
export GROQ_API_KEY=...            # console.groq.com — no card
export CF_ACCOUNT_ID=...           # from earlier Cloudflare setup
export CF_API_TOKEN=...
node inference_pool_probe.js
```

Writes `inference_pool_results.json`. Gate checks have moved on since:
`scripts/check_*_gate.py` were retired 2026-09-20 (superseded by
`/headroom`, CI, and `reconcileBuildTurns`). Current equivalents: Groq
headroom via `GET /headroom`, build-turn health via the `build-turn-*`
artifacts and `Enforce real build output` in
`.github/workflows/team-build-turn.yml`.

**Go/no-go:** Groq must succeed on judging and architecture prompts — it's the
primary tier. Workers AI failing is worth investigating (it's real fallback
capacity) but won't block this gate on its own.

## 2. Build pipeline spike (`.github/workflows/team-build-turn.yml`)

Trigger it manually once — note `task_prompt` is required:

```bash
gh workflow run team-build-turn.yml \
  -f team=alpha \
  -f turn_id=spike-001 \
  -f task_prompt="Add a simple health check endpoint that returns 200 OK"
```

Then check the result in the Actions run log (the `Enforce real build
output` step is the gate now — `scripts/check_build_pipeline_gate.py`
was retired with the other gate scripts 2026-09-20). For harness
experiments, prefer `.github/workflows/manual-build-test.yml`
(`gh workflow run manual-build-test.yml -f turn_id=...`), which
dispatches one turn without touching a live event.

**Go/no-go:** the workflow needs to complete successfully at least once before
Week 4 (Build System) starts. First-run failures are almost always branch
protection blocking the bot's commit, or a Docker build error — the checker
script prints the run URL so you can read the actual log.
