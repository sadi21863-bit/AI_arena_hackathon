# The Arena — project loop

Read this file at the start of every session. Full design:
`The_Arena_Specification.docx`.

## Why a loop instead of a prompt

Two things in this repo are estimates until measured: whether Groq's
published free-tier caps hold up on a real account, and whether the GitHub
Actions build-turn pattern (§8) actually works end to end. A loop means every
session re-checks where the build actually stands before writing code,
instead of trusting that a past session's assumptions are still good.

## Step 1, every session: read state

```
cat .arena/state.json
```

Look at `current_gate`. That's the only thing you're allowed to work on this
session unless it's already `pass`/`ready`.

## Step 2: act on the current gate

**`current_gate == "inference_pool"`**
- Check for `week0-spike/inference_pool_results.json`.
  - Missing: tell the user to get free API keys for Groq (console.groq.com)
    and Cloudflare Workers AI, then run
    `node week0-spike/inference_pool_probe.js`. Stop; don't write Week 1+ code.
  - Present: run `python3 scripts/check_inference_gate.py`. Report the result
    plainly — which tiers actually worked, not just pass/fail.
  - Fail: Groq failing on judging/architecture prompts is usually a bad key
    or a model ID that's rotated (§5 models can change — check
    console.groq.com/docs/models against what's hardcoded in `src/router.ts`
    before assuming it's a real capacity problem). Fix, re-run.

**`current_gate == "build_pipeline"`**
- Tell the user to trigger `.github/workflows/team-build-turn.yml` manually
  once (`gh workflow run team-build-turn.yml -f team=alpha -f turn_id=spike-001
  -f task_prompt="..."`, or via the GitHub UI's Actions tab).
- Then run `python3 scripts/check_build_pipeline_gate.py` (needs `GITHUB_TOKEN`
  and `GITHUB_REPO` env vars).
- Fail: the checker's own output includes the most common first-run failures
  (branch protection blocking the bot's push, a Docker build error in
  `docker/Dockerfile.arena-team-base`) — read those before re-triggering blind.

**`current_gate` is `week1_*` or later**
- Re-read `gates.inference_pool.status` and `gates.build_pipeline.status`
  first. If either isn't `"pass"`, STOP and say so, even if `current_gate`
  claims to be further along.
- If both are `pass`: work the current week's tasks from spec §17 only. When
  done, advance `current_gate` yourself, report where you landed, stop.

## Standing rules — every session

- Never hardcode a placeholder cost estimate as if it were measured.
  `src/router.ts`'s `recordUsage(env, "workers_ai", model, req.task_type, 300)`
  call uses a placeholder Neuron estimate — replace it with real numbers from
  `inference_pool_probe.js`'s output once the `inference_pool` gate passes,
  and say so when you do it.
- Never add a `docker run` inside `team-build-turn.yml`'s agent-work step
  without keeping the network scoped to named endpoints (the inference
  provider, GitHub, the package registry) — it's intentionally network-on for
  the coding agent's own API calls, not an excuse to drop network discipline
  entirely. The verification step stays fully network-isolated — don't move
  agent work into it by mistake.
- The coding agent used in `team-build-turn.yml` is baked into
  `docker/Dockerfile.arena-team-base` at build time, not installed fresh per
  turn — if you change which model or provider it uses, update both the
  Dockerfile comment and the workflow's model flag, don't let them drift.
- Never add an `/admin/*` route without the bearer-token check (spec §7.1).
- Don't reintroduce a VM anywhere. If a task seems to need one, re-read spec
  §2 first, then flag it and ask before adding infrastructure the spec
  doesn't call for.
- Don't add a third inference provider without the user explicitly asking for
  it. Two providers is a deliberate choice, not an oversight.
- If asked to skip a gate, name what's unverified in one line and ask for
  confirmation before proceeding — don't refuse outright, don't silently
  comply either.
- If the spec and the code ever disagree, that's a bug in one of them — say
  which, don't pick one silently.
