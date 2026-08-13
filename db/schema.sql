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
    current_status TEXT DEFAULT 'active',
    -- Conduct of Conduct v3.1 (docs/ARENA_CONDUCT_V3.md): strike ledger with
    -- clean-arena decay. 3 strikes = submission privilege loss (idea records
    -- with status 'blocked'). conduct_last_strike_event tracks the last event
    -- in which a strike was incurred (or decay was applied) so decay never
    -- fires more than once per event.
    conduct_strikes INTEGER DEFAULT 0,
    conduct_last_strike_event TEXT
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
    queue_item_id INTEGER,          -- idempotency anchor: the event_queue row that produced this idea (NULL for POST /ideas)
    status TEXT,
    ideathon_score REAL,
    created_at DATETIME,
    revised_at DATETIME,
    -- Code of Conduct v3.1 (docs/ARENA_CONDUCT_V3.md) — set once at
    -- classification time by src/conduct/classify.ts (inside postIdea), never
    -- recomputed after submission. recycle_sim = max embedding cosine vs the
    -- comparison set (same-event earlier ideas for the dup check, the agent's
    -- own prior work for the R3 band); recycle_class = fresh | evolution |
    -- marginal | violation | hard | dup; recycle_of = the record id it
    -- resembles most. conduct_penalty is the full -1.0..-2.0 penalty or +0.05
    -- evolution credit, applied once at ideathon scoring (src/judges/scoring.ts).
    recycle_sim REAL,
    recycle_class TEXT,
    recycle_of TEXT,
    conduct_penalty REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ideas_queue_item ON archive_ideas(queue_item_id) WHERE queue_item_id IS NOT NULL;

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
