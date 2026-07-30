-- Indexes on event_id for the three fastest-growing tables.
--
-- Found by auditing live production (2026-07-30): event_queue had exactly one
-- index, idx_event_queue_pending(status, scheduled_for, priority), which serves
-- claimNext() and nothing else. Every OTHER query against that table filters on
-- event_id — and the scheduler runs about a dozen of them per event per tick
-- (ensureIdeathonJudging's alreadyQueued + backoff pair, ensureHackathonJudging's
-- pair, queueCollaboration's existingProposals, queueArchitecture's
-- existingArchItems, the building phase's todaysDispatches + pending pair, plus
-- nonFailedCountForAgent/shouldEnqueueForAgent once per agent per task type).
-- With no index on event_id every one of those was a full table scan.
--
-- event_queue was at 2118 rows when this was written, and it is append-only:
-- nothing prunes it, every failed attempt adds a row (the 2026-07-23 Tribunal
-- incident alone left 676), and the autonomous cadence starting 2026-08-01 adds
-- three events a month forever. The scan cost grows without bound on a table
-- read every 5 minutes by cron.
--
-- archive_interactions had NO index of any kind (its PK is INTEGER AUTOINCREMENT,
-- so not even an implicit autoindex) despite /events/:id/timeline, /agents/graph
-- and queueArchitecture's critique-count LEFT JOIN all filtering or joining on
-- it. archive_ideas had only its PK autoindex.
--
-- IF NOT EXISTS throughout so this is safe to re-run — see db/APPLY_ORDER.md
-- for why that matters and which older files in this directory are not.

CREATE INDEX IF NOT EXISTS idx_event_queue_event ON event_queue(event_id, task_type, status);
-- agent_id is nullable and only 7 of the 12 task types set it; the partial index
-- keeps it to the rows shouldEnqueueForAgent/nonFailedCountForAgent actually scan.
CREATE INDEX IF NOT EXISTS idx_event_queue_agent ON event_queue(event_id, agent_id, task_type)
    WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_archive_interactions_event ON archive_interactions(event_id);
-- queueArchitecture joins on (target_id, type) to count critiques per idea.
CREATE INDEX IF NOT EXISTS idx_archive_interactions_target ON archive_interactions(target_id, type);

CREATE INDEX IF NOT EXISTS idx_archive_ideas_event ON archive_ideas(event_id, status);

-- ensureArenaCadence's NOT EXISTS subquery and every "this hackathon's parent"
-- lookup filter on parent_event_id.
CREATE INDEX IF NOT EXISTS idx_archive_events_parent ON archive_events(parent_event_id)
    WHERE parent_event_id IS NOT NULL;
