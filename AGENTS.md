# The Arena — agent loop

Read this file at the start of every session. Full design: `The_Arena_Specification.docx`. Current state: `.arena/state.json` (`current_gate: post_beta_hardening`).

## Session start

1. Read `.arena/state.json`. `current_gate` is the only work allowed unless `pass`/`ready`.
2. Check live health: `GET /health`, `GET /headroom` (`src/index.ts:188,302`), `GET /events/summary` (`src/index.ts:442`). If `queueFailed` is 0 and cron `last_success_at` is fresh, do not intervene — cron `*/5` (`wrangler.toml:33`, `src/index.ts:120`) drives the cycle.
3. Work the current gate from spec §17 only. Advance `current_gate` yourself when done, report where you landed, stop.

## Active guardrails

- Network is default-deny in build turns (spec §7). Phase A runs through Squid allowlist (`registry.npmjs.org`, `pypi`, `opencode.ai` — `.github/workflows/team-build-turn.yml:135`) + `DOCKER-USER DROP 80/443` (`:146-147`); `CF_API_TOKEN` stays in the runner shim (`:163-175`), never in the container. Verification is always `--network=none` (`:585`). Expand the allowlist only per-domain with a written reason; never move agent work into verify (`CLAUDE.md` stub points here).
- Agent driver is baked at image build time (`docker/Dockerfile.arena-team-base:32,55,110`, `docker/opencode.json:3` `skills.paths`). If you change model/provider, update the Dockerfile comment and the workflow model flag together.
- Baked skills: `docker/skills/` (7). Per-team skills: `.arena/skills/` (turn prompt in `src/events/executor.ts:663` tells the agent to read them). New skill collections (e.g. scientific skills) land as a curated subset via `docker/skills` or `.arena/skills` — never the full 163; most need network the sandbox denies.
- Inference is two providers only (`src/router.ts:36-91` `TASK_MODELS`/`DAILY_CAPS`: Groq primary, Workers AI fallback). No third provider, no VM (spec §2) without explicit user approval.
- `/admin/*` routes require bearer-token check (spec §7.1, `src/index.ts:1047-1163`).
- Never ship a guessed number as measured (`src/router.ts:201`, `src/agents/memory.ts:36`). Say when a value is replaced by a real measurement.
- Gate skip: name what is unverified in one line, ask first. Spec-vs-code disagreement is a bug in one of them — say which.

## Pointers

- Routing/caps: `src/router.ts:36-91,212-228`. Queue/scheduler: `src/events/scheduler.ts:104,779,977`. Judging: `src/judges/scoring.ts`, `src/judges/calibration.ts:135`. Builds: `src/events/build-turns.ts:92,256,322`, `.github/workflows/team-build-turn.yml`. Research: `src/agents/research.ts:21-53`. Dedupe: `src/agents/interactions.ts:55` (0.90 intra-agent).
- Ops: `npx tsc --noEmit`, `npx wrangler deploy`, `npx wrangler d1 execute arena-db --remote --command "..."`. Budget research: `docs/AI_BUDGET_RESEARCH_2026-08-31.md`, `docs/AI_PROVIDERS_DEEP_DIVE_2026-08-31.md`.
