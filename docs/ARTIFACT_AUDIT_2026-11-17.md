# Artifact audit — 2026-11-17 (daily red, two causes)

Status: the false positive is fixed; one genuine historical contract gap
remains and is intentionally still red.

## What was red

The daily `Artifact audit` workflow failed on every run from 2026-11-06
through 2026-11-17. The audit was doing its job; two different causes were
mixed together in the same red signal.

| dates | selected ideathon | failure | type |
|---|---|---|---|
| Nov 6–10 | `event_40e6b8d8` | `idea_c5b89dfb` ("SilverCare Dashboard") failed `no_placeholder` on "placeholder rules" in `build_scope` | false positive |
| Nov 11–17 | `event_c514ac4a` | beta repo `arena-team-beta-d6c87ec8` has no `VERIFICATION_REPORT.md` (`has_verification_report`, `report_has_verdict`) | genuine contract gap |

## Cause 1 — the placeholder check was too broad

`PLACEHOLDER_RE` matched the bare word "placeholder" anywhere in an idea. The
failed idea's `build_scope` says "an AI risk-flagging module with placeholder
rules" — stub/mock rules are a legitimate build instruction, not unfinished
content. The old rule would also have failed an idea whose product is a
"TODO app", because it matched the standalone word with no marker context.

Fix: `PLACEHOLDER_RE` now matches marker-shaped text only — `TBD`, `TODO`
followed by a colon/dash or the end of the field, `lorem ipsum`, `[insert …]`,
`<placeholder>`, `{{insert …}}`. A bare "placeholder rules" or "TODO app" no
longer fails the contract.

Verified against the live data:

- `event_40e6b8d8`: 33/33 ideas pass (was 32/33 before the fix).
- `event_c514ac4a`: 36/36 ideas pass.
- `--strict` still exits 1, now only because of the genuine build gap below.

## Cause 2 — beta has no verification report

The latest complete build cycle is `event_3b985ab5` (parent
`event_40e6b8d8`). Its two team repos differ:

| team | repo | product files | test files | nonblank lines | report |
|---|---|---|---|---|---|
| alpha | `arena-team-alpha-d6c87ec8` | 10 | 3 | 3,273 | `READY` |
| beta | `arena-team-beta-d6c87ec8` | 23 | 1 | 415 | **missing** |

Beta has commits through turn 6 (last `3a33bf2`, 2026-11-11T00:18Z) and 68
tracked paths, but no `VERIFICATION_REPORT.md` on `main` or on any other
branch. `.gitignore` does not exclude it. The audit's two failures are
therefore real.

**Decision: do not backfill a report the agents did not produce.** The audit
records what the pipeline actually emitted; writing a post-hoc report would
turn a measured gap into a fabricated artifact. The daily workflow stays red
on this cycle, and that red is honest. This note is the record, so the red is
not mistaken for a new outage or an audit bug.

## Why it should clear

The audit selects the newest judged ideathon and its complete child. The next
hackathon, `event_b7474b18`, started 2026-11-17 14:45Z; both teams formed and
are building (`arena-team-alpha-6ee918ee`, `arena-team-beta-6ee918ee`). When
it completes it becomes the selected build cycle. Confirm both repos contain
a `VERIFICATION_REPORT.md` with a parseable `Verdict` before judging. If
either is missing, the gap is in the build-turn prompt/harness compliance,
not in the audit — do not add an exception.

## Follow-up

- [ ] On `event_b7474b18` completion, confirm both repos have
  `VERIFICATION_REPORT.md` with a parseable `Verdict`.
- [ ] If either is missing, treat it as a harness/prompt compliance gap (the
  verification skill is baked and the turn prompt demands the report), not an
  audit exception.
- [ ] Keep `--strict`; do not add a baseline that silences a missing report.
