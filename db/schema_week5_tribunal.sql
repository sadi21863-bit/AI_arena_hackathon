-- Week 5: Seven Judges (spec §13) + Tribunal (spec §14).
-- Apply with: wrangler d1 execute arena-db --remote --file=db/schema_week5_tribunal.sql

-- One row per (judge, target, criterion) score. target_type distinguishes
-- an ideathon idea from a hackathon team so the same table serves both
-- phases (spec §13's judges score both, with different weight columns).
CREATE TABLE judge_scores (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    judge_name TEXT NOT NULL,
    criterion TEXT NOT NULL,
    weight REAL NOT NULL,           -- the weight actually used (phase-dependent)
    target_type TEXT NOT NULL,      -- 'idea' | 'team'
    target_id TEXT NOT NULL,
    phase TEXT NOT NULL,            -- 'ideathon' | 'hackathon'
    score REAL NOT NULL,            -- 0-10
    rationale TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_judge_scores_target ON judge_scores(target_type, target_id);
CREATE INDEX idx_judge_scores_event ON judge_scores(event_id);

-- Mandatory pre-event calibration (spec §13: "all 7 judges score 3 anchor
-- ideas... if inter-judge correlation falls below 0.6, adjust weights or
-- provide clearer anchor examples").
CREATE TABLE calibration_runs (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    correlation REAL NOT NULL,
    passed INTEGER NOT NULL,        -- 1 if correlation >= 0.6, else 0
    details TEXT NOT NULL,          -- JSON: per-judge score vectors across the 3 anchors
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Post-event AI-only reflection (spec §14). reflection_type distinguishes
-- the three stages; target_agent_id is only set for cross_examination
-- (whose reasoning is being examined).
CREATE TABLE tribunal_reflections (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    reflection_type TEXT NOT NULL,  -- 'individual' | 'cross_examination' | 'synthesis'
    target_agent_id TEXT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_tribunal_event ON tribunal_reflections(event_id);

-- Final weighted scores, computed once judging completes for each phase.
-- archive_ideas.ideathon_score already exists (db/schema.sql) for the
-- ideathon side; hackathon_teams needs the equivalent two columns.
ALTER TABLE hackathon_teams ADD COLUMN hackathon_score REAL;
ALTER TABLE hackathon_teams ADD COLUMN final_score REAL; -- ideathon_score*0.3 + hackathon_score*0.7, spec §3.2
