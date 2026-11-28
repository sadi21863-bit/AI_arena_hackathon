# Independent project quality rubric (A5b) — 2026-11-27 draft

**Status: draft, not automated.** This document defines what “substantial”
would mean if an independent reviewer agreed with the harness. Completion
(`docs/COMPLETION_TIERS.md`) is necessary but not sufficient. No score is
emitted by any script today.

Each dimension is scored **separately**. A single number that hides a weak
axis is not acceptable. Thresholds below are proposals to calibrate against a
human-scored set before any automated use.

| dimension | what the reviewer checks | independence | proposed threshold |
|---|---|---|---|
| Functional correctness | The harness re-runs build and tests in a clean container; a small acceptance script derived from the idea's `build_scope` checks the promised core behaviour | harness, not the agent that wrote the code | clean build + tests pass + acceptance script passes |
| Relevance to the original problem | Does the shipped behaviour address the `problem` text in the idea, not just the title? | reviewer model ≠ builder model, plus human sample | clearly addresses the stated problem |
| Architecture | Structure, separation of concerns, obvious dead scaffolding, hard-coded secrets | reviewer + human sample | no unresolved blocker |
| Usability | A fresh reader follows only the README to install and run in a clean container | harness | fresh-clone run succeeds |
| Test quality | Assertion count; a deliberate one-function break makes at least one test fail (mutation-lite spot check on 1–2 functions) | harness | assertions present; at least one mutation caught |
| Independent verification | `VERIFICATION_REPORT.md` verdict matches what the harness actually measured | harness vs agent report | no contradiction |

## Calibration protocol

1. The owner hand-scores **≥ 8 past repos blind**, one row per dimension,
   without seeing the audit tier or the agent's verdict.
2. An independent reviewer scores the same repos. Report agreement per
   dimension, not a single average. If a dimension's automated score does not
   track the human score, drop that dimension from automation and keep it as a
   human-sampled check.
3. Only after calibration may a repo be called **substantial**: it must be
   `complete` and clear every applicable dimension. Until then, the only
   emitted words are `empty`, `scaffold`, `partial` and `complete`.

## Constraints

- The seven-judge panel and idea scoring are unrelated to this rubric; do not
  fold a project-quality score into an idea score.
- Research evidence and judge agreement remain process metrics, never a
  quality certificate for a repo.
- No production change is implied by this draft.
