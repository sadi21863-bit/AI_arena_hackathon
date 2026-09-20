# Deploy runbook

Order matters. Schema migrations must land BEFORE the code that reads the
new columns — `deploy-worker.yml` deliberately does not run them (see its
header comment), so this stays a human procedure, not a push side effect.

## Worker (backend) changes

1. `node scripts/apply_schema.js --remote --status` — confirm what's pending.
2. If a migration is pending: `node scripts/apply_schema.js --remote`, then
   verify the sentinel (`--status` clean).
3. `npx tsc --noEmit` — must be exit 0.
4. Commit + push to `master`. `Deploy Worker to Cloudflare` auto-runs on
   `src/**` pushes (with its own typecheck gate) — watch it go green.
5. Manual `npx wrangler deploy` only when you need it live *now* (note the
   version ID); otherwise the auto-deploy in step 4 is the deploy.
6. Verify: `GET /health`, `GET /headroom` (fresh cron timestamp, no error),
   and for scheduler changes one manual admin tick on a live event with a
   D1 read-back of the affected rows.

## Frontend-only changes (`public/**`)

Commit + push. `Deploy Observatory to Cloudflare Pages` auto-deploys.
Verify on the live URL (hash route + `?kiosk` if shell chrome changed).

## Rollback

Worker: `wrangler rollback` (or redeploy the previous commit). D1 schema
changes are additive-only by convention (new columns/tables) — old code
ignores them, so rolling code back never requires rolling the schema back.
If a migration breaks the live tick, fix forward; do not hand-edit prod rows
except through the admin cleanup route (which refuses events with real
ideas/teams).
