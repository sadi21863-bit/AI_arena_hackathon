# Completion tiers (A5) — 2026-11-27 draft

Completion tiers are **deterministic, read-only and structural**. They say
whether an artifact runs; they say nothing about whether the idea was good.
The word **substantial** is deliberately not emitted by the tier script: it is
reserved for a repo that is `complete` **and** passes the independent rubric in
`docs/PROJECT_QUALITY_RUBRIC.md`.

## Rules

| tier | rule (all numbers are already collected by `scripts/artifact_audit.mjs`) |
|---|---|
| `empty` | no product files after scaffold/harness paths are excluded |
| `scaffold` | product files exist, but < 30 nonblank sampled lines **or** no test file |
| `partial` | product files, tests with assertions, but build/verification/outcome is not green: no successful build turn, verdict missing or not `READY`, or any structural check failing |
| `complete` | product files ≥ 30 lines, test files with assertions, `VERIFICATION_REPORT.md` with `READY`, ≥ 1 successful build turn, and no failing structural checks |

Thresholds are proposals, pending calibration on a hand-checked sample. They
are not a quality gate and never alter `--strict`.

## Last six completed cycles (read-only)

Produced by `node scripts/completion_tiers.mjs --last=6`:

| event | team | tier | lines | tests | assertions | verdict | successful / failed turns |
|---|---|---|---:|---:|---:|---|---:|
| `event_b7474b18` | alpha | partial | 1,409 | 4 | 69 | (none) | 0 / 8 |
| `event_b7474b18` | beta | partial | 3,187 | 5 | 71 | READY | 0 / 9 |
| `event_3b985ab5` | alpha | complete | 3,273 | 3 | 61 | READY | 1 / 9 |
| `event_3b985ab5` | beta | partial | 415 | 1 | 85 | (none) | 0 / 6 |
| `event_693bc79b` | alpha | partial | 7,343 | 3 | 74 | NOT READY | 0 / 9 |
| `event_693bc79b` | beta | partial | 160 | 1 | 21 | READY | 0 / 7 |
| `event_41cbabb7` | alpha | partial | 6,049 | 8 | 13 | (none) | 0 / 19 |
| `event_7308f1fe` | alpha | complete | 359 | 25 | 251 | READY | 10 / 7 |
| `event_7308f1fe` | beta | complete | 572 | 18 | 534 | READY | 3 / 12 |
| `event_a988b3dd` | alpha | partial | 2,288 | 4 | 155 | (none) | 3 / 12 |
| `event_a988b3dd` | beta | partial | 1,234 | 2 | 102 | (none) | 2 / 11 |

Counts: 3 `complete`, 8 `partial`, 0 `empty`, 0 `scaffold` in this window.

### Hand-check of six repos — structure only

Tree check via the GitHub API (`git/trees/main?recursive=1`) on 2026-11-27.
This hand-check verified **structure only** — product/test file counts, report
presence and verdict shape. It did **not** assess code quality, relevance or
usability. The tier labels matched the audit's own structural inputs in these
six cases; that is a consistency check, not proof the repos are good or that
the thresholds are final.

| repo | report file | test files in tree | structural agreement |
|---|---|---:|---|
| `arena-team-alpha-d3e2e7be` | yes | 4 | `complete` (3,273 lines, READY, 1 success) |
| `arena-team-beta-d3e2e7be` | yes | 2 | `partial` (415 lines, verdict not parseable, 0 successes) |
| `arena-team-alpha-6ee918ee` | no | 5 | `partial` (no report, 0 successes) |
| `arena-team-beta-6ee918ee` | yes | 6 | `partial` (report present but 0 successes) |
| `arena-team-alpha-c5ad953c` | yes | 25 | `complete` |
| `arena-team-beta-c5ad953c` | yes | 18 | `complete` |

Note on outcomes: `complete` requires **at least one** successful build turn,
not a clean run. In `event_3b985ab5` alpha reached `complete` with **1 success
out of 10 turns** (9 failed). That is the intended floor for this tier; a high
success ratio belongs to the A5b quality rubric, not to completion.

## How to rerun

```bash
node scripts/completion_tiers.mjs --last=6
```

Read-only: the script imports the audit's own D1 and GitHub helpers and writes
nothing.
