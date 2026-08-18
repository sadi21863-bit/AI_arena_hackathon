-- G7 — queue journal. One append-only row per event_queue state transition,
-- so the replay/scrub path can show what actually happened instead of what
-- a snapshot happens to contain right now.
--
-- Context (docs/OFFICE_INVESTIGATION_2026-07-31.md, G7): every transition
-- below updates event_queue IN PLACE, destroying the history a replay needs:
--   claimNext        pending    -> in_progress (claims a row)
--   markCompleted    in_progress -> completed
--   markFailed       in_progress -> failed      (error_message retained)
--   resetStuckItems  in_progress -> pending     (clears claimed_at)
-- archive_interactions only records the successes that produced content, so
-- failures, resets and dead claims never appear anywhere. This table is the
-- missing journal; the Replay view merges it into its timeline.
--
-- No backfill: the pre-existing transition history is genuinely gone (the
-- in-place updates above), and reconstructing it from current status would
-- fabricate the very history G7 exists to preserve. The journal starts
-- recording from deploy time forward.

CREATE TABLE queue_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,               -- event_queue.id
    event_id TEXT NOT NULL,
    agent_id TEXT,                          -- NULL for event-level tasks (judging kickoff, phase transitions)
    task_type TEXT NOT NULL,
    from_status TEXT,                       -- NULL on the row's creation (enqueue)
    to_status TEXT NOT NULL,                -- 'pending' | 'in_progress' | 'completed' | 'failed'
    error_message TEXT,                     -- set on failed transitions only
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Replay reads one event's whole life, in order. Item lookup is for
-- operator forensics ("what happened to item 2788?").
CREATE INDEX idx_queue_journal_event ON queue_journal(event_id, created_at, id);
CREATE INDEX idx_queue_journal_item ON queue_journal(item_id);