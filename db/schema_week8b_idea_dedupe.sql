-- Week 8b — idea idempotency for the event engine's submit_idea queue items.
--
-- A Worker invocation can die between postIdea's INSERT and the queue item's
-- markCompleted; resetStuckItems then re-claims the item 10 minutes later and
-- the retry inserts a SECOND idea for the same quota slot (an agent could end
-- up with up to 6 ideas instead of 3). archive_ideas.queue_item_id anchors an
-- idea to the queue row that produced it; postIdea checks it first and
-- returns the existing idea instead of inserting a duplicate, and this
-- partial UNIQUE index backstops it against a genuine double-run race.
--
-- queue_item_id is NULL for ideas created directly via POST /ideas, which is
-- exactly what the partial index's WHERE clause is for.
--
-- Apply with:
--   wrangler d1 execute arena-db --remote --file=db/schema_week8b_idea_dedupe.sql

ALTER TABLE archive_ideas ADD COLUMN queue_item_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ideas_queue_item
  ON archive_ideas(queue_item_id) WHERE queue_item_id IS NOT NULL;
