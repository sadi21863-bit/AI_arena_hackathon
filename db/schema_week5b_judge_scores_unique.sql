-- Defense in depth for src/judges/scoring.ts's per-judge idempotency fix
-- (2026-07-22 code review): even with the application-level check, a
-- genuine race (two queue items scoring the same target concurrently, which
-- shouldn't happen given atomic queue claiming, but this is cheap insurance)
-- shouldn't be able to double-insert. SQLite has no ALTER TABLE ADD
-- CONSTRAINT; a UNIQUE index is the equivalent enforcement mechanism.
-- Apply with: wrangler d1 execute arena-db --remote --file=db/schema_week5b_judge_scores_unique.sql

CREATE UNIQUE INDEX idx_judge_scores_unique ON judge_scores(target_type, target_id, phase, judge_name);
