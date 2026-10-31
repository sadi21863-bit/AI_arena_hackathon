-- Per-event quality snapshots (2026-10-31 review follow-up, R-2 persistence).
--
-- The public `quality` object is computed live from calibration_runs and
-- judge_scores so it cannot go stale. This table stores the same computation at
-- the moment an event reaches a terminal judging state, which gives Headroom a
-- durable history and lets an operator see drift without re-running the
-- retrospective.
--
-- The live API remains the source of truth; this is a snapshot, not a gate.
CREATE TABLE IF NOT EXISTS event_quality_snapshots (
  event_id TEXT PRIMARY KEY,
  judged_population INTEGER NOT NULL,
  pre_correlation REAL,
  pre_passed INTEGER,
  retrospective_correlation REAL,
  retrospective_band TEXT NOT NULL,
  confidence_level TEXT NOT NULL,
  confidence_reasons TEXT NOT NULL,   -- JSON array; reasons travel with the label
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_quality_snapshots_computed
  ON event_quality_snapshots (computed_at);
