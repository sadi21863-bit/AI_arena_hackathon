# Correcting `build_turns` for event_8088ef16 — 2026-08-01

A competition record is being edited. This document exists so that edit is
auditable: what was wrong, what evidence establishes the truth, exactly what
changed, and what was deliberately left alone.

Correction script: `db/corrections/build_turns_event_8088ef16_2026-08-01.sql`

---

## What was wrong

`build_turns` recorded **38 successful turns** for this hackathon. GitHub
recorded **5 successful runs** across both team repos, and the repos contain
**4 build-turn commits** between them.

The inflation came from two compounding faults, both since fixed:

1. **The daily dispatch cap never fired** (`scheduler.ts`). It counted with
   `queuedPayloadValues`, which returns a Set, so every team's dispatches-today
   was permanently 1 against a ceiling of 6. The event dispatched 226 turns on
   07-31 and 122 more by 06:25 on 08-01.
2. **Team repos froze their harness at creation** (`repos.ts`). This team's
   workflow predated `run-name`, which is how `reconcileBuildTurns` matches a
   run to a turn. With no turn_id in any run title, every turn fell through to
   positional matching — documented as safe "as long as turns are dispatched in
   order", which the runaway destroyed. One genuinely successful run was then
   re-claimed by turn after turn: **18 alpha turns all point at run
   30434155001.**

Neither fault raised an error. Cron was green, the queue drained cleanly, zero
failures were recorded, and the stall watchdog saw constant progress.

## Evidence used

Run titles on these repos carry no turn_id, so the runs themselves cannot be
attributed to turns retrospectively. The only surviving per-turn evidence is
the commit message the workflow writes: `Build turn <turn_id>`, which embeds
the exact id.

| | alpha | beta |
|---|---|---|
| Total runs | 176 | 176 |
| Cancelled | 173 | 172 |
| Successful | 2 | 3 |
| Turns with commits | turn1, turn2 | turn1, turn2 (turn2 twice) |

Alpha reconciles exactly: 2 successful runs, 2 committing turns. Beta has 3
successful runs producing 3 commits across 2 distinct turn ids — consistent
with turn 2 being dispatched more than once during the runaway.

## What changed

- **35 rows** recorded as `success` whose turn_id appears in no commit →
  `conclusion = 'cancelled'`, with `run_id`/`run_url` cleared. The run link was
  false; keeping it would invite someone to "verify" against a run that turn
  never caused.
- **Alpha turn 2** → `run_id` corrected to 30631195060. Unambiguous: that run
  started 12:35:47 and the turn2 commit landed 12:37:36.

Three rows keep `success`: alpha turn1, alpha turn2, beta turn2 — each backed
by a commit.

## What was deliberately NOT changed

- **Beta's turn 1 has a commit but no `build_turns` row at all.** Its first
  turn was never recorded. Inserting one now would be inventing a record rather
  than correcting one, and the gap is itself a finding worth leaving visible.
- **Beta's third successful run is not attributed to any turn.** Two of its
  commits carry the same turn2 id; guessing which run belongs to which dispatch
  would be fabrication.
- **The cancelled runs are not deleted.** They happened, they consumed CI, and
  the record of a 170-run runaway is worth keeping.

## Effect on judging

This event is judged on 2–3 real build turns rather than 38. That is the
honest outcome and it lowers both teams' apparent output.

Worth noting the judge was never fully misled: N-4's `collectBuildEvidence`
counts product files from the actual diff, independently of CI conclusions, and
flags a repo whose only content is scaffold and turn logs. The diff-based half
of the evidence was accurate throughout; the conclusion-based half was not.
