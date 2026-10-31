# Maintainers

## Current

| role | person | scope |
|---|---|---|
| Owner / maintainer | [@sadi21863-bit](https://github.com/sadi21863-bit) | repository, Cloudflare account, provider accounts, deployment, event operations |

`CODEOWNERS` names the same person for every path. There is currently **one
human in the operational loop**. That is the project's largest non-technical
risk, and this file exists to state it rather than imply a team that is not
there.

## What the maintainer is responsible for

- the scheduled tick and `/headroom` / `/alerts` review;
- applying schema migrations before deploying code that reads them
  (`db/APPLY_ORDER.md`);
- the OpenRouter / Cloudflare / GitHub credential surface, including rotation;
- the quota posture decision in `docs/QUOTA_POSTURE_2026-10-31.md`;
- reviewing the daily artifact-audit workflow result and the post-event
  calibration retrospective.

## Decision rights

Changes to the following need the owner's explicit decision, not an autonomous
agent's judgement:

- adding a provider or a second account;
- paid plans or spend;
- judge weights, calibration thresholds, or the event cadence;
- expanding the build sandbox's network allowlist;
- adding a second maintainer or granting repository/Cloudflare access.

## Adding a maintainer

The owner nominates a second maintainer, grants repository write access (and,
only if they will operate the system, the Cloudflare/provider credentials),
then updates this file and `.github/CODEOWNERS` in the same change. Until that
happens, the bus factor is one and a single absence can stop the cadence.

## If the owner is unavailable

This is the minimum a second operator needs to keep the cadence alive. It does
not grant decision rights over providers, spend or judge weights.

1. `GET /health`, `GET /headroom`, `GET /alerts`, `GET /events/summary`.
   Check `cron.stale`, not just `cron.last_error`.
2. Identify the active event and phase. If `queueFailed` is rising, use
   `docs/RUNBOOK_PROVIDER_AND_QUOTA_FAILURES.md` before retrying anything.
3. If the Worker needs a code fix: apply pending migrations first
   (`node scripts/apply_schema.js --remote`), then push to `master`; the
   `deploy-worker.yml` / `deploy-pages.yml` workflows deploy on path-scoped
   pushes. Do not deploy a Worker that reads a column before the migration.
4. If the build provider is holding dispatches, read
   `docs/QUOTA_POSTURE_2026-10-31.md`. Do not add a provider, a second account,
   paid credit, or rotate keys on your own. A hold is a valid state.
5. If an event needs to be closed, follow runbook §D and record the reason.
   Do not hand-write a `repo_url` for a repo that was never scaffolded.
6. Escalate provider/spend/cadence/judge-weight decisions to the owner.
   Operational fixes, migrations and documentation are fair game.

Access needed for that handoff: repository write (or at least Actions +
issues), Cloudflare account access for D1/Workers/Pages, and read access to the
GitHub org that owns the team repos. Provider keys are only needed for
rotation, which is an owner decision.

## Review cadence

- **Every scheduled tick (5 min):** the Worker drives events; `/alerts` records
  subrequest and capacity conditions.
- **Daily:** the `Artifact audit` workflow runs against the newest judged
  ideathon and persists its contract result.
- **Per event:** the calibration retrospective is available via
  `scripts/calibration_retrospective.mjs`; the public confidence label is on
  `/events`, `/events/summary` and the Observatory Archive.
- **Weekly (or after any incident):** read `/headroom`, `/alerts`, the latest
  audit, and the open items in `docs/ARENA_BACKLOG.md`.
