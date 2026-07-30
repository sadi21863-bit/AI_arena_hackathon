-- Stall detection for events, so one wedged event can't halt the Arena forever.
--
-- Found auditing live prod on 2026-07-30, ahead of the autonomous cadence
-- starting 2026-08-01. Every phase in scheduler.ts is self-healing per item, but
-- every phase's COMPLETION check requires that every item eventually succeed:
-- ensureIdeathonJudging waits for every architecture_complete idea to be judged,
-- ensureHackathonJudging for every team, isStageComplete for all 12 agents. There
-- is no attempt cap anywhere — markFailed writes status='failed' and the
-- scheduler enqueues a brand-new row on the next tick behind a time backoff only
-- (which is why event_queue was at 2118 rows, and why the 2026-07-23 Tribunal
-- incident alone left 676 failures).
--
-- So a single permanently-failing item — one malformed LLM response that
-- re-malforms on every retry — pins its event short of terminal status. And
-- ensureArenaCadence's stillRunning guard then returns early on every subsequent
-- tick, meaning no future ideathon is ever created again. One stuck item stops
-- the whole competition, permanently and silently: the cron heartbeat only
-- records thrown exceptions, and a wedged event throws nothing at all.
--
-- last_progress_at is the signal the watchdog needs and nothing recorded before:
-- when this event last completed a real unit of work. Distinct from created_at
-- (start) and from updated timestamps on child rows (which a retry storm churns
-- without making progress).

ALTER TABLE archive_events ADD COLUMN last_progress_at DATETIME;

-- Set once when the watchdog gives up on an event, alongside status='abandoned'.
-- Kept as its own column rather than inferred from status so that "when did we
-- stop waiting" survives any later status change, and so an operator can tell an
-- abandoned event from one that merely looks quiet.
ALTER TABLE archive_events ADD COLUMN abandoned_at DATETIME;

-- Why the event was abandoned, in one line, for the Observatory and /headroom.
-- A silent status flip is the failure mode this whole migration exists to fix;
-- abandoning an event without recording why would reintroduce it one level up.
ALTER TABLE archive_events ADD COLUMN abandoned_reason TEXT;
