-- Operational alerts (2026-10-31 review follow-up, R-1).
--
-- The runbook had thresholds but no push channel and no durable record, so a
-- subrequest stall was only visible to someone already reading the database.
-- The scheduled() tick now evaluates the two highest-frequency branches
-- (subrequest headroom and capacity pauses) and writes a row here. The same row
-- is surfaced on GET /headroom and GET /alerts. If ALERT_WEBHOOK_URL is set,
-- the alert is also POSTed there; without it, this is still a durable,
-- timestamped signal rather than a silent wedge.
--
-- No secrets or payloads belong in `details`: it is public operational data
-- (counts, event ids, thresholds only).
CREATE TABLE IF NOT EXISTS ops_alerts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,              -- subrequest_headroom | capacity_pause
  severity TEXT NOT NULL,          -- warning | critical
  event_id TEXT,
  task_type TEXT,
  message TEXT NOT NULL,
  details TEXT,                    -- JSON: counts/thresholds only
  notified_at TEXT,                -- webhook accepted at
  notify_error TEXT                -- webhook failure, if any
);

CREATE INDEX IF NOT EXISTS idx_ops_alerts_created
  ON ops_alerts (created_at);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_kind_event
  ON ops_alerts (kind, event_id, created_at);
