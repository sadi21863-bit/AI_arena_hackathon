-- Build turns: what each hackathon build turn actually DID.
--
-- Until now a build turn left no record at all. dispatch_build_turn fired the
-- workflow and the queue item completed as soon as GitHub accepted the
-- request, so "the hackathon is progressing" only ever meant "we asked CI to
-- run something." A turn that produced zero code was indistinguishable from
-- one that shipped a feature, and the CI outcome was read exactly once (at
-- judging) and never stored. That is the same looks-done-but-isn't failure
-- shape docs/INVESTIGATION_2026-07-28.md found behind `build_pipeline: pass`.
--
-- One row per dispatched turn, reconciled against the Actions API afterwards.

CREATE TABLE IF NOT EXISTS build_turns (
    turn_id TEXT PRIMARY KEY,          -- "<team_id>_turn<N>", also the workflow input
    event_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    dispatched_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Filled in by reconcileBuildTurns once the run is visible/finished.
    run_id INTEGER,
    run_url TEXT,
    status TEXT NOT NULL DEFAULT 'dispatched',  -- 'dispatched' | 'queued' | 'in_progress' | 'completed' | 'unmatched'
    conclusion TEXT,                            -- 'success' | 'failure' | 'cancelled' | ...
    completed_at DATETIME,

    -- The distinction that actually matters: a run can succeed while the
    -- agent wrote nothing. The workflow's own acceptance check fails the run
    -- when no files changed, so conclusion='success' implies real output —
    -- but keep the commit sha so it stays verifiable rather than assumed.
    head_sha TEXT,
    reconciled_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_build_turns_event ON build_turns(event_id);
CREATE INDEX IF NOT EXISTS idx_build_turns_team ON build_turns(team_id, turn_number);
-- Reconciliation only ever looks for turns that aren't finished yet.
CREATE INDEX IF NOT EXISTS idx_build_turns_open ON build_turns(status) WHERE status != 'completed';
