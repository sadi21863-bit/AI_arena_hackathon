# Schema apply order

`scripts/apply_schema.js` holds the canonical order in its `MIGRATIONS` array
and reads `schema_migrations` to decide what still needs running. This file
explains the order and the one procedure the script can't infer.

```bash
node scripts/apply_schema.js --remote --status
```

## Order, and why it isn't alphabetical

| # | File | Depends on |
|---|------|-----------|
| 1 | `schema_migrations.sql` | — (must be first; everything else is recorded here) |
| 2 | `schema.sql` | — (Week 1 core: `archive_events`, `archive_agents`, `archive_ideas`, `archive_interactions`, `model_registry`, `provider_usage_log`, `admin_tokens`) |
| 3 | `schema_week3_event_queue.sql` | — |
| 4 | `schema_research_budget.sql` | — |
| 5 | `schema_hackathon_events.sql` | `schema.sql` (ALTERs `archive_events`); creates `hackathon_teams` |
| 6 | `schema_week5_tribunal.sql` | #5 (ALTERs `hackathon_teams`); creates `judge_scores` |
| 7 | `schema_week5b_judge_scores_unique.sql` | #6 |
| 8 | `schema_week8_cron_heartbeat.sql` | — |
| 9 | `schema_week8_judge_model_tracking.sql` | #6 (ALTERs `judge_scores`) + `schema.sql` |
| 10 | `schema_build_turns.sql` | — |
| 11 | `schema_team_members.sql` | — |
| 12 | `schema_week8_event_id_indexes.sql` | #2, #3 (indexes their tables) |
| 13 | `schema_week8_stall_tracking.sql` | #2, #3 |
| 14 | `schema_week9_conduct.sql` | #2 (ALTERs `archive_ideas` + `archive_agents`) |

`seed_agents.sql` is **not** in the list. It is data, not schema — re-running it
against a live archive would be a data change rather than a no-op. Apply it by
hand exactly once when bootstrapping a new database.

## Which files are safe to re-run

Files 1, 10, 11, 12 and 13 use `IF NOT EXISTS` throughout and are idempotent.
**Files 2-9 and 14 are not** — they use bare `CREATE TABLE` and `ALTER TABLE ADD
COLUMN`, both of which error on a second run. That's exactly why the tracking
table exists: "apply everything and let the duplicates fail harmlessly" was
never a safe recovery path, and before `schema_migrations` there was no way to
tell which ones were already in without reading `sqlite_master` by hand.

Don't retrofit `IF NOT EXISTS` onto 2-9. Editing an already-applied migration
means the file in the repo no longer describes what ran against production, and
SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` anyway. New changes go
in a new file.

## Fresh database

```bash
node scripts/apply_schema.js --local          # or --remote for a new D1
npx wrangler d1 execute arena-db --local --file=db/seed_agents.sql
```

## An existing database that predates tracking (i.e. production)

Production was migrated by hand, file by file, as each week's work landed, so
it already contains files 2-11 but has no `schema_migrations` table. Baselining
records them as present without executing them:

```bash
node scripts/apply_schema.js --remote --baseline   # creates the table, records 2-11
node scripts/apply_schema.js --remote              # actually runs 12-13
```

`--baseline` verifies rather than asserts. Each entry in the script's
`MIGRATIONS` array declares a **sentinel** — a table, index, or column the file
creates — and baselining records a migration only when its sentinel is genuinely
present in the database. So it can't mark a fresh database as migrated (it
refuses outright if no sentinel is found), and it can't swallow a
genuinely-new migration that happens to be sitting in the list: files 12-13 have
no sentinel in production yet, stay pending through the baseline pass, and get
executed by the normal run above. That makes `--baseline` safe to re-run at any
point, including after adding new migrations.

Rows written by baselining are marked `method='baseline'` rather than
`'applied'`, keeping asserted-by-operator distinguishable from
verified-by-execution.

`--status` checks every sentinel regardless of what the tracking table says, so
it reports drift in both directions — recorded but missing, or present but
unrecorded — instead of just echoing the table back.
