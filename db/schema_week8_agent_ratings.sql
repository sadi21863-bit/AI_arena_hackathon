-- N-5 (docs/ARENA_BACKLOG.md) — cross-event skill ratings.
--
-- archive_agents already tracks total_wins / total_collaborations / win_rate,
-- but those are counters: they say how often an agent won, never who it beat.
-- An agent that won twice against weak fields and one that won twice against
-- the strongest rosters are indistinguishable, and a counter cannot express
-- "Gale has been climbing for three events" — which is the multi-month
-- persistence the spec claims and the Observatory leaderboard needs to mean
-- anything beyond a single event.
--
-- Elo is deliberate over TrueSkill here: a hackathon is a two-sided match
-- between two rosters with a definite winner, which is exactly the shape Elo
-- was designed for. TrueSkill's advantage is free-for-all ranking with
-- uncertainty tracking, and it would be the better choice if the Arena ever
-- ran more than two teams per event.

ALTER TABLE archive_agents ADD COLUMN elo_rating REAL DEFAULT 1200;

-- How many rated events this agent has actually played. Distinguishes a
-- provisional 1200 (never competed) from a hard-earned one that returned to
-- 1200 after wins and losses — without it the leaderboard cannot tell a new
-- agent from an average one.
ALTER TABLE archive_agents ADD COLUMN rating_events INTEGER DEFAULT 0;

ALTER TABLE archive_agents ADD COLUMN rating_updated_at DATETIME;

-- Idempotency marker for the rating pass. Ratings are the one thing in this
-- system that is genuinely NOT safe to recompute: every other handler is
-- written to be re-runnable because the scheduler retries freely, but Elo is
-- an accumulating delta, so applying it twice permanently inflates a winner
-- and deflates a loser with no way to tell afterwards that it happened.
-- Stamped in the same D1 batch as the rating writes, so a retry that lands
-- between the two is impossible.
ALTER TABLE archive_events ADD COLUMN ratings_applied_at DATETIME;
