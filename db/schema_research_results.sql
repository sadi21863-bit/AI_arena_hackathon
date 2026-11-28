-- Research result sources (A3, Step 1) — additive, no changes to existing tables.
--
-- Tavily's URL/title/snippet currently survive only inside Vectorize memory
-- text, where they cannot be scoped to an event and can be clipped before the
-- idea prompt sees them. This table stores only the identifiers and a hash of
-- the snippet — never the full page text. ~190 calls/event x ~5 results is
-- ~1,000 rows/event, far below any D1 concern.
--
-- source_id is the numbered label (S1..S5) shown to the idea agent. call_id is
-- the research_calls.id from the same call, so a retry cannot duplicate rows.
CREATE TABLE IF NOT EXISTS research_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  agent_id TEXT,
  call_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  snippet_hash TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (call_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_research_results_event_agent
  ON research_results (event_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_research_results_call
  ON research_results (call_id);
