-- Research budget tracking — caps Tavily usage so a single event can't eat
-- into the 1,000-credit/month free tier that has to cover every event.
-- Apply with: wrangler d1 execute arena-db --remote --file=db/schema_research_budget.sql

CREATE TABLE research_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    agent_id TEXT,                    -- agent id for ideathon; team id (e.g. 'team_alpha') for hackathon
    phase TEXT NOT NULL,              -- 'ideathon' | 'hackathon'
    query TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_research_calls_budget ON research_calls(event_id, agent_id, phase);
