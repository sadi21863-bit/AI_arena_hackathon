-- Week 8c — self-healing revival tracking. checkForStalledEvents' abandonment
-- is meant to be final, but production showed a false-positive shape: a
-- day-gated phase finishing its work early, then sitting in a legitimate
-- calendar wait, gets abandoned at +25h anyway. reconcileAbandonedEvents()
-- (scheduler.ts) revives events whose abandonment is provably wrong; these
-- columns bound how many times an event may be revived so a genuinely dead
-- event can't become an unkillable zombie that blocks arena cadence forever
-- (ensureArenaCadence's stillRunning check). Apply with:
--   wrangler d1 execute arena-db --remote --file=db/schema_week8c_self_heal.sql

ALTER TABLE archive_events ADD COLUMN revival_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE archive_events ADD COLUMN last_revived_at DATETIME;
