-- Week 9 — Code of Conduct v3.1 (docs/ARENA_CONDUCT_V3.md), production
-- implementation of the sim-validated ruleset (docs/ARCHITECTURE_COMPARISON.md,
-- whole-arena A2+ v3.1: winner-hit 73.5%, best-legal 79.5%, derivative ->
-- hackathon 1.0%).
--
-- Classification happens once, in postIdea (src/agents/interactions.ts via
-- src/conduct/classify.ts), and the results are stored on the idea itself so
-- every later stage (judge prompts, scoring, team formation) reads stored
-- facts instead of recomputing similarities with possibly-different vectors.
--
--   archive_ideas.recycle_sim    max embedding cosine vs the comparison set
--   archive_ideas.recycle_class  fresh | evolution | marginal | violation | hard | dup
--   archive_ideas.recycle_of     record id the idea most resembles (NULL when fresh)
--   archive_ideas.conduct_penalty  full penalty/credit applied once at ideathon scoring
--
-- Strikes live on the agent (R4 ladder: 3 strikes = privilege loss via idea
-- status 'blocked'; clean-arena decay = -1 strike per event without one).
--
-- Apply with:
--   node scripts/apply_schema.js --remote

ALTER TABLE archive_ideas ADD COLUMN recycle_sim REAL;
ALTER TABLE archive_ideas ADD COLUMN recycle_class TEXT;
ALTER TABLE archive_ideas ADD COLUMN recycle_of TEXT;
ALTER TABLE archive_ideas ADD COLUMN conduct_penalty REAL;

ALTER TABLE archive_agents ADD COLUMN conduct_strikes INTEGER DEFAULT 0;
ALTER TABLE archive_agents ADD COLUMN conduct_last_strike_event TEXT;