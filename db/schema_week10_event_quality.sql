-- Event quality records (2026-10-31 review follow-up, R-3 persistence).
--
-- Confidence is computed live from calibration + judge_scores, not stored here:
-- a stored label can silently go stale when a late judge row lands. This table
-- stores only the artifact-audit result, which is produced by an external
-- read-only script (`scripts/artifact_audit.mjs --persist`) and cannot be
-- recomputed from the event tables alone.
--
-- One row per event. An ideathon row holds the full audit (ideas, critiques and
-- the build cycle it points at); a hackathon row holds its build slice. The API
-- exposes failures/warnings in list payloads and the compact summary on
-- GET /events/:id.
CREATE TABLE IF NOT EXISTS event_quality (
  event_id TEXT PRIMARY KEY,
  audit_json TEXT,
  audit_failures INTEGER,
  audit_warnings INTEGER,
  audited_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_quality_audited
  ON event_quality (audited_at);
