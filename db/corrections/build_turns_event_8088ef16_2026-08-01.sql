-- Historical correction of build_turns for event_8088ef16 (2026-08-01).
-- Rationale and evidence: docs/BUILD_TURN_CORRECTION_2026-08-01.md
--
-- Apply with:
--   npx wrangler d1 execute arena-db --remote --file db/corrections/build_turns_event_8088ef16_2026-08-01.sql
--
-- Ground truth used:
--   * GitHub run conclusions — alpha 176 runs / 173 cancelled,
--     beta 176 runs / 172 cancelled. Five successful runs across both teams.
--   * "Build turn <turn_id>" commit messages, which embed the exact turn_id.
--     These are the only surviving per-turn evidence: the run titles on these
--     repos carry no turn_id, which is precisely what caused reconcileBuildTurns
--     to fall back to positional matching and mis-attribute in the first place.
--
-- Only turns whose turn_id appears in a real commit produced any work.

-- 1. Turns recorded as success that inherited a run they did not cause.
--    Eighteen alpha turns all pointed at run 30434155001. Both the conclusion
--    and the run link are false, so both are cleared — a wrong pointer is
--    worse than none, because it invites verifying against the wrong run.
UPDATE build_turns
   SET conclusion = 'cancelled', run_id = NULL, run_url = NULL
 WHERE event_id = 'event_8088ef16-f68e-4955-9c55-13974409ed00'
   AND conclusion = 'success'
   AND turn_id NOT IN (
     'team_09417b76-29e8-4da9-91f6-c8d9a865d47b_turn1',
     'team_09417b76-29e8-4da9-91f6-c8d9a865d47b_turn2',
     'team_1fd09b06-b4ae-454d-b9e2-1d4357dc03e9_turn1',
     'team_1fd09b06-b4ae-454d-b9e2-1d4357dc03e9_turn2'
   );

-- 2. Alpha's turn 2 kept turn 1's run id. Its real run is unambiguous:
--    run 30631195060 started 12:35:47 and the turn2 commit landed 12:37:36.
UPDATE build_turns
   SET run_id = 30631195060,
       run_url = 'https://github.com/AI-arena-hackathon/arena-team-alpha-4409ed00/actions/runs/30631195060'
 WHERE turn_id = 'team_09417b76-29e8-4da9-91f6-c8d9a865d47b_turn2';

-- Deliberately NOT done: beta has a turn1 commit but no build_turns row at
-- all, so its first turn was never recorded. Inserting one now would be
-- inventing a record rather than correcting one, and the gap is a real finding
-- worth leaving visible.
