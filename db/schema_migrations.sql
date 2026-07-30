-- Which schema files have actually been applied to this database.
--
-- Until now nothing recorded that. db/ held ten loose .sql files with no
-- ordering, no dependency information and no applied-state, and production D1
-- had been patched incrementally by hand (`wrangler d1 execute arena-db
-- --remote --file=...`) as each week's work landed. That left two real
-- problems, both found auditing live prod on 2026-07-30:
--
--   1. The repo could not rebuild the database. Getting from empty to
--      current-production required knowing an apply order that existed only in
--      git history and session notes.
--   2. Most of those files are not idempotent — bare CREATE TABLE and ALTER
--      TABLE ADD COLUMN, which error on a second run. So "just apply them all"
--      was not a safe recovery path either, and there was no way to tell which
--      ones were already in.
--
-- scripts/apply_schema.js reads this table to decide what still needs running.
-- See db/APPLY_ORDER.md for the canonical order and the baseline procedure for
-- a database that predates this table (i.e. production).

CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,             -- file name within db/, e.g. 'schema_week5_tribunal.sql'
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- 'applied' = this run executed it. 'baseline' = it was already in the
    -- database before tracking existed and was recorded without being run.
    -- Kept distinct so a future reader can tell verified-by-execution from
    -- asserted-by-operator rather than having to trust them equally.
    method TEXT NOT NULL DEFAULT 'applied'
);
