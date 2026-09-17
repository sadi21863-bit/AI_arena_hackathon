-- Week 10 capacity pause (2a, IMPROVEMENT_PLAN): an event whose remaining
-- phase work exceeds BOTH inference budgets pauses instead of burning its
-- MAX_ITEM_ATTEMPTS retries against an empty pool (the event_a0cbe12f shape:
-- 191 failed submit_idea rows, then a false judged with 0 scores).
-- Apply with:
--   node scripts/apply_schema.js --remote

-- paused_from preserves the real phase across the pause so resume restores
-- exactly where the event was; status itself reads 'paused_capacity' while
-- paused. NULL means never paused (or already resumed).
ALTER TABLE archive_events ADD COLUMN paused_from TEXT;
ALTER TABLE archive_events ADD COLUMN paused_at DATETIME;
ALTER TABLE archive_events ADD COLUMN pause_reason TEXT;
