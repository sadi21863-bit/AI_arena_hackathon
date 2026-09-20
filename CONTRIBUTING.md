# Contributing

This repo is a single-owner autonomous system, not a community OSS project.
External contributions are not expected, but this is the workflow if you
have access.

1. Read `AGENTS.md` first (session loop, guardrails, pointers). `CLAUDE.md`
   is a stub pointing there.
2. Check `.arena/state.json` — `current_gate` is the only sanctioned work.
3. Verify before pushing: `npx tsc --noEmit`, `node scripts/tiny_test.js`
   (same checks `.github/workflows/ci.yml` runs).
4. Deploy the Worker after merging to `master`: `npx wrangler deploy`.
   `deploy-pages.yml` / `deploy-worker.yml` auto-deploy on path-scoped
   pushes; anything else needs the manual deploy.
5. Never commit secrets (`.env` is gitignored; see `.env.example`). Never
   widen build-turn network scope without a written reason (spec §7).

## Use the arena skills in your own agent

The build-turn skills in `docker/skills/` (TDD, code review, debugging,
verification, …) follow the Agent Skills standard (`SKILL.md` + description
frontmatter) and work in any compatible host — no packaging step, copy the
directory:

```bash
cp -r docker/skills/arena-team ~/.agents/skills/   # user-level
```

Team repos additionally carry `AGENTS.md` (conventions), `BACKLOG.md` (the
task queue), and `arena.config.json` (machine-readable workspace pointers).
An external agent with those three plus the skill above can work a team
repo the same way a build turn does.
