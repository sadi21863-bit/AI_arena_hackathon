-- Week 3 — event queue. Same role as ideaconnect's aiQueue: decouples
-- "deciding what work needs to happen" (scheduler) from "doing it"
-- (executor), with atomic claiming so a missed/overlapping cron tick never
-- double-processes a row. Apply with:
--   wrangler d1 execute arena-db --remote --file=db/schema_week3_event_queue.sql

CREATE TABLE event_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    agent_id TEXT,                              -- NULL for event-level tasks (phase transitions, judging kickoff)
    task_type TEXT NOT NULL,                    -- 'research' | 'submit_idea' | 'critique' | 'propose_collaboration'
    payload TEXT,                               -- JSON, task-specific params
    status TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'in_progress' | 'completed' | 'failed'
    priority INTEGER NOT NULL DEFAULT 5,
    scheduled_for DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at DATETIME,
    completed_at DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Every claim query filters on (status, scheduled_for) and orders by
-- priority — this index carries the executor's hot path.
CREATE INDEX idx_event_queue_pending ON event_queue(status, scheduled_for, priority);
