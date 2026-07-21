-- The Arena — D1 schema (spec §9). No VM anywhere.
-- Apply with: wrangler d1 execute arena-db --file=db/schema.sql

CREATE TABLE archive_events (
    id TEXT PRIMARY KEY,
    type TEXT CHECK(type IN ('ideathon', 'hackathon')),
    start_date TEXT,
    end_date TEXT,
    status TEXT,
    winner_team_id TEXT,
    winning_idea_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE archive_agents (
    id TEXT PRIMARY KEY,
    name TEXT,
    persona TEXT,
    lens TEXT,
    created_at DATETIME,
    total_ideas_submitted INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_collaborations INTEGER DEFAULT 0,
    total_critiques_given INTEGER DEFAULT 0,
    total_critiques_received INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0.0,
    current_status TEXT DEFAULT 'active'
);

CREATE TABLE archive_ideas (
    id TEXT PRIMARY KEY,
    event_id TEXT,
    agent_id TEXT,
    co_agent_id TEXT,
    title TEXT,
    one_liner TEXT,
    problem TEXT,
    solution TEXT,
    target_user TEXT,
    build_scope TEXT,
    research_anchor TEXT,
    estimated_build_time INTEGER,
    status TEXT,
    ideathon_score REAL,
    created_at DATETIME,
    revised_at DATETIME
);

CREATE TABLE archive_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    timestamp DATETIME,
    actor_id TEXT,
    target_id TEXT,
    type TEXT,
    content TEXT,
    sentiment REAL,
    weight INTEGER DEFAULT 1
);

CREATE TABLE model_registry (
    id TEXT PRIMARY KEY,
    name TEXT,
    family TEXT,
    size_b INTEGER,
    quantization TEXT,
    file_name TEXT,
    file_size_mb INTEGER,
    active_ram_mb INTEGER,
    load_time_sec INTEGER,
    provider TEXT,
    cap_coding INTEGER,
    cap_reasoning INTEGER,
    cap_creativity INTEGER,
    cap_speed INTEGER,
    cap_context INTEGER,
    workers_ai_id TEXT,
    status TEXT DEFAULT 'available',
    last_loaded_at DATETIME,
    load_count INTEGER DEFAULT 0,
    huggingface_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- provider_usage_log — spec §9. Tracks daily usage across the two pooled
-- providers (Groq, Workers AI) with different unit types (requests vs.
-- Neurons) — kept explicit per-provider rather than forcing a false common
-- unit. This is what src/router.ts writes to via recordUsage().
CREATE TABLE provider_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,               -- UTC date, YYYY-MM-DD
    provider TEXT NOT NULL,          -- 'groq' | 'workers_ai'
    model_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    units_used INTEGER NOT NULL,     -- requests for groq; estimated neurons for workers_ai
    event_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_provider_usage_day ON provider_usage_log(day, provider);

-- admin_tokens — spec §7.1. Backs bearer-token validation for /admin/*
-- routes. Store only a hash, never the raw token.
CREATE TABLE admin_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME
);
