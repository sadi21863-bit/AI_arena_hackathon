-- Team membership.
--
-- hackathon_teams was (id, event_id, idea_id, team_name, repo_url, status) —
-- no members, no join table, nothing. The 12 agents took no part in the
-- hackathon at all: every build turn was written by the coding agent in CI
-- with no reference to whose team it was. Spec §1 says "two teams of agents
-- write real code", and that was not what ran.
--
-- Membership is functional, not decorative: build turns rotate through a
-- team's roster, and the turn prompt is written from that member's persona
-- (see nextBuildAuthor in src/events/team-members.ts). A turn taken by the
-- Schema Validator and one taken by the Friction Hunter should not produce
-- the same commit.

CREATE TABLE IF NOT EXISTS hackathon_team_members (
    team_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    -- 'lead' authored the idea this team is building (or co-authored it via a
    -- merge); 'builder' was assigned. Leads take the first turn.
    membership TEXT NOT NULL DEFAULT 'builder',
    -- What this agent does on a build turn, derived from its own lens so the
    -- roster reads as a team rather than twelve interchangeable workers.
    build_role TEXT NOT NULL,
    turns_taken INTEGER NOT NULL DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (team_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_event ON hackathon_team_members(event_id);
CREATE INDEX IF NOT EXISTS idx_team_members_agent ON hackathon_team_members(agent_id);
