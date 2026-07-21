-- Links a hackathon event back to the ideathon it advanced from, and models
-- the two build teams — needed so multiple ideathon+hackathon events can
-- run without ambiguity about which ideas belong to which build.
-- Apply with: wrangler d1 execute arena-db --remote --file=db/schema_hackathon_events.sql

ALTER TABLE archive_events ADD COLUMN parent_event_id TEXT;

CREATE TABLE hackathon_teams (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,           -- the hackathon event
    idea_id TEXT NOT NULL,            -- which advancing idea this team builds
    team_name TEXT NOT NULL,          -- 'alpha' | 'beta'
    repo_url TEXT,
    status TEXT NOT NULL DEFAULT 'forming',  -- 'forming' | 'building' | 'complete'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_hackathon_teams_event ON hackathon_teams(event_id);
