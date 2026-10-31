# Artifact audit — 2026-10-31

Purpose: check the artifacts themselves, not whether a queue row exists. This
is the R-3 follow-up to the current-state review: the pipeline can "complete"
while an idea, critique or team repo is empty or structurally unusable.

Tool: `scripts/artifact_audit.mjs` (read-only by default; D1 via the Cloudflare
HTTP API, public GitHub repos via the GitHub API; `--persist` writes the compact
result to `event_quality`). Defaults to all rows for the selected event —
current events are small; `--n=N` samples when needed.

## Contracts

**Idea** — `title` ≥3, `one_liner` ≥40, `problem` ≥60, `solution` ≥80
characters; no `TBD`/`TODO`/`lorem ipsum`/`placeholder`; `problem` is not
identical to `solution`. Finalists (`judged`, `architecture_complete`) also
need `build_scope` ≥80. A blocked idea without `build_scope` is a note, not a
failure: it never reached architecture.

**Critique** — `content` parses as JSON with `strength`, `weakness` and
`suggestion`, each ≥40 characters and not identical to each other.

**Build repo** — repo present; ≥1 turn with both `run_id` and `head_sha`; ≥1
product file outside the scaffold/harness (`README`, `AGENTS`, `BACKLOG`,
`arena.config.json`, `.gitignore`, `.env.example`, `.github/`, `docker/`, turn
logs and the verification report are not product work); ≥1 test file; a
`VERIFICATION_REPORT.md` with a parseable `Verdict` line. A `NOT READY`
verdict is recorded as a note, not a contract failure — an honest failed
security check is still an honest report.

## Baseline — 2026-10-31

Default ideathon: `event_dc3df601` (judged 2026-10-28). Build cycle:
`event_693bc79b` (complete) because the selected ideathon's own hackathon
child, `event_382ab43e`, produced no repos.

| artifact set | result |
|---|---|
| Ideas | **34/34 pass**, 1 note — `idea_5563dccb` (blocked) has no `build_scope`; expected for a non-finalist. 27 blocked + 7 judged in the population. |
| Critiques | **21/21 pass** — all JSON with substantive strength/weakness/suggestion. |
| Builds | **2/2 pass** — alpha: 9 turns, 9 product files, 3 test files, verdict **NOT READY** (honest security note); beta: 7 turns, 4 product files, 1 test file, verdict **READY**. |
| Total | **57 artifacts, 0 contract failures, 1 note.** |

The prior cycle, `event_485dd577`, audits cleanly too: 34/34 ideas, 23/23
critiques, 2/2 builds — the same two repos, same verdicts.

### The failure shape the audit is meant to catch

Running against the failed hackathon is a direct test:

```bash
node scripts/artifact_audit.mjs --hackathon=event_382ab43e-adc1-42de-bfb1-0ccc4a930969 --strict
```

Both teams fail `repo_present`, `turns_ran`, `product_work`, `has_test`,
`has_verification_report` and `report_has_verdict`; the command exits 1. That
is the correct report for an event where team formation never produced a repo
— the audit names the missing contract instead of treating the event as done.

## Caveats

- The length thresholds are heuristics, not a semantic quality judgement. They
  catch empty/placeholder artifacts, not a plausible-but-bad idea.
- Product-file detection is an allowlist. A new scaffold file must be added to
  `NON_PRODUCT` (and to `HARNESS_FILES`/`SCAFFOLD_FILES` in
  `src/github/repos.ts`) or it will be counted as product work.
- A test file's presence is not proof that it passes; the per-turn
  `VERIFICATION_REPORT.md` is the evidence for that.
- The audit defaults to all rows at current scale. Use `--n` on a larger event;
  a random sample can miss a single bad artifact.
- The build sample follows the latest complete hackathon with repos. When the
  current ideathon's child has none, the report names the fallback — do not
  read it as a build result for the failed child.

## Persistence and schedule

`--persist` writes a compact result to `event_quality` (one row per event):
summary counts, failure names, note count and `audited_at`. `GET /events/:id`
returns it under `quality.audit.details`; `/events` and `/events/summary` carry
the failure/warning counts, and the Observatory Archive renders an audit chip.
The baseline above is recorded for `event_dc3df601` and `event_693bc79b`.

`.github/workflows/artifact-audit.yml` runs daily (06:17 UTC) with
`--persist --strict`, so the audit is no longer a manual point-in-time check.
A missing contract turns the workflow red; a healthy audit leaves a green run
and a job summary. The workflow reads the same Cloudflare and GitHub secrets as
the deploy workflows.

## Reproduce

```bash
node scripts/artifact_audit.mjs
node scripts/artifact_audit.mjs --json
node scripts/artifact_audit.mjs --persist
node scripts/artifact_audit.mjs --event=event_485dd577-dc3b-46eb-8b75-96eb79679044
node scripts/artifact_audit.mjs --hackathon=event_382ab43e-adc1-42de-bfb1-0ccc4a930969 --strict
```

Still open (backlog R-3): a semantic sample on top of these structural checks.
The thresholds catch empty/placeholder artifacts, not a plausible-but-bad idea,
and a new scaffold file must be added to both allowlists or it counts as
product work.
