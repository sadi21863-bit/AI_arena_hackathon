# Week 0 — Feasibility Spike

Two gates, both real, neither needs any VM signup.

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

Writes `inference_pool_results.json`. Check it with:

```bash
python3 ../scripts/check_inference_gate.py
```

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

Then check the result:

```bash
export GITHUB_TOKEN=...    # needs actions:read
export GITHUB_REPO=owner/repo
python3 ../scripts/check_build_pipeline_gate.py
```

**Go/no-go:** the workflow needs to complete successfully at least once before
Week 4 (Build System) starts. First-run failures are almost always branch
protection blocking the bot's commit, or a Docker build error — the checker
script prints the run URL so you can read the actual log.
