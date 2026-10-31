# 2026-10-31 — 53/50 subrequests wedged a hackathon, then the cadence guard wedged the arena

Event context: ideathon `event_dc3df601` was judged on 2026-10-28 09:30Z.
The auto-created hackathon `event_382ab43e` started at 09:35:55Z; its two team
rows (alpha, beta) were created at 09:41:00Z. No team ever got a repo, no
build turn ever reached GitHub Actions, and the event produced no winner.

## 1. What happened

- `team_formation` failed **288 times** between 2026-10-28 09:41:25Z and
  2026-10-29 09:36:04Z. Every failure was
  `Too many subrequests by single Worker invocation`.
- `hackathon_teams` held both rows with `repo_url = NULL` and
  `status = 'forming'`.
- 12 `dispatch_build_turn` items (turns 2-7 for each team) failed with
  `Cannot read properties of null (reading 'split')` because they were handed
  the null `repo_url`.
- `build_turns` had 12 rows, all `failed`, all with `run_id = NULL`; turn 1
  was never recorded because formation never reached it.
- `checkForStalledEvents` abandoned the event at **2026-10-30 10:45:55Z**
  (25h without progress).
- The abandoned event then blocked the next ideathon: it was abandoned in
  `building`, a status `reconcileAbandonedEvents` deliberately does not
  revive, while `ensureArenaCadence` counted every abandoned event with
  `revival_count < 3` as still-running. The result was a permanent wedge:
  revival skipped it, cadence waited for it forever.
- The event was closed `status = 'complete'` on 2026-10-31 09:07:45Z with
  `abandoned_reason` recording the cap. No winner. The next 10-day slot
  (2026-10-30 00:00Z) was already open; the next ideathon auto-started on
  2026-10-31 09:10:53Z as `event_40e6b8d8` (deep_research).

## 2. Root cause 1 — the scaffold outgrew the free-plan subrequest cap

`worker_subrequest_log` measured the last failed item exactly:

| component | count |
|---|---|
| GitHub API calls | 30 |
| main-repo template fetches | 19 |
| D1 statements | 4 |
| **total** | **53** (cap 50) |

The 30 GitHub calls were: create repo (1), README Contents PUT (1), 13 harness
Contents PUTs, 6 scaffold Contents PUTs, secrets public-key GET (1), and 8
secret PUTs. Each Contents PUT is a separate commit and a separate subrequest.

Incident §10's one-repo-per-invocation split was still working — the item was
creating one team, not two. The cost had simply grown past 50 as the harness
and scaffold file lists grew. Retries made it worse: the repo already existed,
so every retry took the 422 path, repeated 20 existence GETs and 19 template
fetches, and measured 53 again. The 288 failures are that loop at cron cadence.

## 3. Root cause 2 — a continuous-phase abandonment is not revivable

`reconcileAbandonedEvents` only revives statuses in
`DAY_GATED_PHASE_STARTS_AT_DAY` (`deep_research`, `ideation_critique`,
`collaboration`, `architecture`, `team_formation`). Its own comment says why:
continuous phases (`building`, `ready_for_judging`) are trusted, and their
abandonment means the work itself is stuck.

`ensureArenaCadence`'s `stillRunning` query contradicted that: it treated
**any** abandoned event with `revival_count < 3` as still-running. So an
abandoned `building` hackathon was simultaneously "not revivable" and "still
running" — a state from which the cadence could never recover.

## 4. Fix

1. **Scaffold in one tree commit** (`src/github/repos.ts`). A truly empty repo
   cannot take a Git tree (GitHub 409s "Git Repository is empty"), so the first
   file (README) seeds the branch through the Contents API. The response
   carries the new commit and tree SHAs; the other 19 files land in one
   `POST /git/trees` + one commit + one ref update. Fresh cost is ~38
   subrequests; a retry walks the tree and writes only missing paths (~10).
2. **Secret provisioning lists first** (`ensureTeamRepoSecrets`): one GET in
   the steady state, then a public-key GET plus one PUT per missing name.
   The old `setTeamRepoSecrets` blindly PUT all eight names on every call.
3. **Named dispatch error** (`src/github/dispatch.ts`): a null or malformed
   `repo_url` now throws
   `dispatchBuildTurn: <team> turn <id> has no repo_url; team formation did not finish`
   instead of a TypeError.
4. **Cadence guard uses the revival list** (`src/events/scheduler.ts`): an
   abandoned event blocks the next cycle only if its status is one revival can
   actually restore. An abandoned `building`/`ready_for_judging` event is
   terminal for cadence purposes.
5. Removed the now-dead per-file `putFile` and `setTeamRepoSecrets` helpers.

## 5. Verification

- The Git API sequence was exercised end-to-end against a throwaway org repo:
  seed README via Contents, create a tree with nested paths, commit, create the
  ref, read all files back; then a second tree with `base_tree` added one file,
  preserved the README, and updated the ref. The test repo was deleted.
- `npx tsc --noEmit` clean; Main Repo CI and Deploy Worker green for `3699b67`
  (runs 41187229109 and 41187229175).
- The failed event was marked `complete` with the cap in `abandoned_reason`.
  No pending/in_progress items remain; the next ideathon auto-started on
  2026-10-31 09:10:53Z (`event_40e6b8d8`, deep_research) on the open 10-day
  slot.

## 6. Guardrails for the next scaffold change

- Every file added to `HARNESS_FILES` or `SCAFFOLD_FILES` adds one fetch and
  one tree entry to the fresh path. Re-check the measured total before adding;
  the free-plan cap is 50.
- `worker_subrequest_log` is the source of truth, not the estimate. A failed
  run records its cost too.
- Team formation re-arms every cron tick while a team is `forming`; a
  deterministic failure therefore repeats at 5-minute cadence until the 25h
  watchdog. Alert after 3 consecutive failures rather than waiting for the
  watchdog.
- A continuous-phase event that cannot do its work needs an explicit terminal
  decision (complete/abandon) — the self-healing path will not revive it.
- A null `repo_url` is a team-formation failure, not a dispatcher bug; keep the
  error named.
