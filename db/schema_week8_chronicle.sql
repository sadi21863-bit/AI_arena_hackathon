-- N-7 (docs/ARENA_BACKLOG.md) — Chronicler / live commentary.
--
-- The Observatory shows real data and nothing else: queue counts, scores,
-- interaction timelines. That is legible to someone already tracking the
-- event and opaque to everyone else. A per-phase narrative ("Day 3: Casey and
-- Iris both landed on elder-care logistics from opposite directions") is what
-- makes the public view readable without watching every tick.
--
-- One row per (event, phase). The UNIQUE constraint is the idempotency
-- mechanism, not a nicety: phase transitions are detected by the scheduler on
-- whichever cron tick happens to notice them, and that detection is re-run
-- freely, so INSERT OR IGNORE against this constraint is what stops one phase
-- being narrated repeatedly.

CREATE TABLE IF NOT EXISTS event_chronicle (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    phase TEXT NOT NULL,              -- the phase being narrated (the one that just ended)
    narrative TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_chronicle_event ON event_chronicle(event_id, created_at);
