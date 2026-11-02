# Incident 2026-11-02 — conduct quota saturated the agent pool

Status: **fixed live** (code `93f7233`; ledger/event repair applied 2026-11-02
12:13Z). This is an operator record, not a change to the conduct specification.

## What happened

The 2026-11-02 ideation pass (`event_40e6b8d8-a3ca-48c6-af6b-f8297667dabb`)
produced 33 ideas, but **30 were stored as `blocked`**. Only three were
eligible. All twelve agents were at 3–9 conduct strikes, so every new idea from
them lost submission privilege.

The queue looked healthy in the aggregates that had been watched: 33
`submit_idea` items completed, 54 queue items completed overall. The failures
were duplicates (the intended R6 rejection) and one malformed critique. Nothing
raised an alert. The damage was visible only by joining `archive_ideas.status`
to `archive_agents.conduct_strikes`.

## Root cause

R1 says each agent submits three ideas per event, **at most one derived from
prior work, two fresh** (`docs/ARENA_CONDUCT_V3.md` §2). The implementation had
three defects:

1. The quota counted **every** prior idea in the event, not only prior derived
   ones. An agent that submitted a fresh idea first was penalized on its first
   legitimate evolution.
2. The quota applied to `dup` as well, although R6 says duplicates carry no
   strike.
3. Each derived idea past the first added **+1 strike**. R4-v3.1 says strikes
   fire only at measured similarity ≥0.92; the simulation never modeled a quota
   strike.

The ideation prompt then invited an upgrade of a past idea on *every* one of the
three submissions. The agents' ideas were overwhelmingly evolution-class
(140 all-time, versus 29 violations and 2 hard). Each event therefore added two
quota strikes per agent while the clean-arena decay removed one. The ledger grew
by one per agent per event until the whole pool was suspended. The 2026-11-02
pass was the first full ideation after the pile-up.

Evidence before the repair:

| signal | value |
|---|---|
| agents at ≥3 strikes | 12 / 12 |
| ideas blocked in the event | 30 / 33 |
| all-time evolution / violation / hard ideas | 140 / 29 / 2 |
| unambiguous quota-penalized evolution+ marginal rows | 70 |
| genuine-only ledger replay | 0–6 per agent (8 agents below 3) |

## Fix

- `src/conduct/classify.ts` + `src/conduct/quota.ts` (`93f7233`): count only
  prior **derived** ideas, exempt `fresh` and `dup`, and apply the −1.0 quota as
  a **score penalty only**. Strikes remain the measured ≥0.92 R4 ladder.
- `src/events/executor.ts`: the prompt now states the one-upgrade rule and, when
  the agent has already used the slot, says the next idea must be fresh.
- `src/conduct/limits.ts` + `src/observability/alerts.ts`: a
  `conduct_saturation` warning fires when ≥50% of agents are at/above 3 strikes
  (deduped 24h). It checks the ledger before ideation, not the blocked output
  afterwards.

No conduct penalty already stored on an idea was rewritten, no gate threshold
or judge weight changed, and the judged population was not expanded.

## Repair

`scripts/repair_conduct_ledger_2026-11-02.mjs` (dry-run by default) replayed
only genuine strikes: violation +1, hard +2, and one clean-arena decay for an
event with no genuine strike. It ignored quota strikes. Applied with `--apply`:

- **11 ledgers corrected.** Alex, Blake, Casey, Ellis, Finn, Iris → 0; Gale → 1;
  Leo → 2. Hale (6), Jade (5), Kai (5) and Drew (4) remain suspended; all four
  were already at ≥3 before this event.
- **20 non-hard ideas unblocked** (`status = submitted`). The 10 remaining
  blocked ideas belong to the four suspended agents; the one `hard` violation
  stays blocked regardless.
- **60 critiques queued** (three per newly eligible idea; the three ideas that
  were already submitted had critiques).

The repair is idempotent: the replay is deterministic, only `blocked` rows are
unblocked, and critique assignment counts existing critics first.

## Verification

- `archive_ideas`: 23 `submitted`, 10 `blocked`.
- `event_queue`: 60 `critique` pending after the repair.
- `archive_agents`: 4 suspended (Hale 6, Jade 5, Kai 5, Drew 4), 8 at 0–2.
- The next cron tick claims the critiques. The ideathon remains
  `ideation_critique` until the day-3 collaboration boundary
  (2026-11-03 09:10Z), so the unblocked ideas still have a full critique window
  before architecture.

## Follow-up

The four suspended agents recover one strike per event with no genuine
violation. The `conduct_saturation` alert fires at 6/12, so a future pile-up is
visible before a full ideation pass. A human review of the decay rate is still
warranted if genuine violations alone keep the pool above 50%.
