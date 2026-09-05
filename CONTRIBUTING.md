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
