-- Week 8 post-beta hardening (P0-2, ARENA_BACKLOG.md): judge_scores never
-- recorded which model produced a score. If Groq's daily cap was hit
-- mid-event, idea #1 could be scored by gpt-oss-120b and idea #4 by a
-- Workers AI model, summed into one weighted ranking with no record it
-- happened. Apply with:
--   wrangler d1 execute arena-db --remote --file=db/schema_week8_judge_model_tracking.sql

ALTER TABLE judge_scores ADD COLUMN provider TEXT;
ALTER TABLE judge_scores ADD COLUMN model_id TEXT;

-- The judging model is now pinned once per event at calibration time
-- (judges/calibration.ts runCalibration) and reused for every subsequent
-- judge_idea/judge_team call that event (judges/scoring.ts scoreTarget) —
-- NULL until calibration has run for this event.
ALTER TABLE archive_events ADD COLUMN judging_provider TEXT;
ALTER TABLE archive_events ADD COLUMN judging_model TEXT;
