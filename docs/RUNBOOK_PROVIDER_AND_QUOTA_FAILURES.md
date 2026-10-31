# Provider, quota and queue-failure runbook

Forward-looking triage for the failure shapes that can stop the Arena without a
code deploy. The dated `INCIDENT_*` docs are the history; this is the next-time
checklist. Nothing here requires a paid plan.

## 0. Fast triage (read-only)

```bash
curl -s https://arena-api.sadi21863.workers.dev/health
curl -s https://arena-api.sadi21863.workers.dev/headroom
curl -s https://arena-api.sadi21863.workers.dev/alerts
```

Then, for the active event id:

```sql
-- queue shape: what is failing, and with what error
SELECT task_type, status, COUNT(*) AS n
FROM event_queue WHERE event_id = ? GROUP BY task_type, status;

-- last real failures
SELECT task_type, error_message, completed_at
FROM event_queue WHERE event_id = ? AND status = 'failed'
ORDER BY completed_at DESC LIMIT 10;

-- measured subrequest cost (failed runs record too)
SELECT task_type, github_calls, main_repo_fetches, db_statements, total, cap, outcome, created_at
FROM worker_subrequest_log ORDER BY created_at DESC LIMIT 10;

-- did any turn actually reach Actions?
SELECT turn_number, status, conclusion, run_id, dispatched_at
FROM build_turns WHERE event_id = ? ORDER BY dispatched_at;

-- did team formation produce repos?
SELECT team_name, repo_url, status FROM hackathon_teams WHERE event_id = ?;
```

`cron.last_success_at` older than ~15 minutes, or any `last_error`, is the
first thing to explain.

## A. `team_formation` is failing (`Too many subrequests`)

Symptom: repeated `Too many subrequests by single Worker invocation`, both
teams `forming` with `repo_url` NULL.

1. Check `worker_subrequest_log.total` against `cap`. If it is near 50, do not
   just retry — every retry repeats the cost.
2. Current scaffold path: first file seeds the branch via Contents, the other
   19 land in one Git tree commit, secrets are listed first. Expected ~38
   fresh / ~10 retry (2026-10-31 fix).
3. If a new harness/scaffold file pushed it back over 45, batch more of the
   work (or split secret provisioning into a continuation item) before
   re-running. Adding a file costs one fetch + one tree entry, not one commit.
4. Recovery: fix, deploy, then either let the day-gated revival re-arm the
   event (`team_formation` is revivable) or, if it was abandoned in
   `building`/`ready_for_judging`, close it `complete` and let the next cycle
   start. Do not hand-write a `repo_url` for a repo that was never scaffolded.

## B. OpenRouter 429 / quota exhaustion

Symptom: `429` with `temporarily rate-limited upstream`, or the workflow's
quota probe kills the container before a model call.

1. Read `/headroom` for the current remaining budget and reset time.
2. 429 upstream is weather, not a dead model. Wait for the UTC reset; the
   `build-quota.ts` probe already holds dispatches. Do not rotate keys blindly.
3. Two keys on one OpenRouter account do **not** double the cap; a second
   independent account does, at the cost of a second credential surface. That
   is an owner decision, not an automatic fix.
4. If dispatches are held, verify the queue has no `pending` items that will
   burn the next day's budget on stale work.

## C. Dead build model (404 / provider error)

Symptom: `404` / `Provider returned error` / `Function ... Not found for
account` before any tool call, while the model is still catalog-listed.

1. Probe the catalog: `GET /api/v1/models` — is the id present, non-deprecated,
   and `tools`-capable?
2. Probe the model directly with a forced tool call on **both** keys. A prose
   answer is not a pass; the turn needs `tool_calls`.
3. Pin a passing primary and a different-upstream fallback in
   `.github/workflows/team-build-turn.yml` (`MODEL`, `FALLBACK_MODEL`) and
   declare it in `docker/opencode.json`. Update the comments in the workflow
   and Dockerfile at the same time.
4. Run the live spike (`docs/SPIKE_BROWSER_TURN_2026-10-22.md`) before the next
   hackathon. A model that only answers chat is not a build model.
5. History: `docs/INCIDENT_2026-10-17_DEAD_PIN.md`, `docs/SPIKE_BROWSER_TURN_2026-10-22.md`.

## D. Abandoned event / cadence blocked

`checkForStalledEvents` abandons an event after 25h without progress.
`reconcileAbandonedEvents` only revives day-gated statuses:
`deep_research`, `ideation_critique`, `collaboration`, `architecture`,
`team_formation`. Continuous phases (`building`, `ready_for_judging`) are not
revived; their abandonment means the work itself is stuck.

1. If the event is day-gated and the queue has no pending/in_progress items,
   clear `abandoned_at` and let revival re-arm it (it may reset `start_date` if
   the calendar drifted).
2. If it is `building`/`ready_for_judging`, close it explicitly:
   `status = 'complete'`, `end_date`, and an `abandoned_reason` naming the
   cause. The cadence guard ignores non-revivable abandoned statuses after the
   2026-10-31 fix, but a public archive should not show a half-live event.
3. Never leave an abandoned continuous-phase event as the only thing blocking
   the next cycle. Verify with the `stillRunning` query / the next ideathon
   slot (`computeNextArenaStart`).

## E. Alerts — durable, optionally pushed

The two highest-frequency branches are now automated on the scheduled tick and
written to `ops_alerts`:

- `worker_subrequest_log.total >= 45/50` (`subrequest_headroom`, warning at
  45-49, critical at >=50);
- an event in `paused_capacity` for more than an hour (`capacity_pause`).

Read them at `GET /alerts` or in the `/headroom` panel. Dedupe is one alert per
`(kind, event, task)` per 24h, not per tick. If `ALERT_WEBHOOK_URL` is set, the
same alert is POSTed (`text` + `content`, counts only) and `notified_at` records
delivery; without it the row is still durable and visible, but a human must
pull. Enable push with:

```bash
npx wrangler secret put ALERT_WEBHOOK_URL
```

`GET /headroom.subrequest_headroom` also shows the latest measured
`team_formation` cost against the 45 threshold, so the cap is visible before it
wedges a cycle.

The remaining thresholds are still manual:

| signal | threshold | why |
|---|---|---|
| `team_formation` consecutive failures | 3 | catches a deterministic cap/config bug in 15 min, not 25h |
| `worker_subrequest_log.total` | ≥ 45 / 50 | **automated** (above) |
| `build_turns.run_id IS NULL` after dispatch | ≥ 1 | dispatch never reached Actions |
| `cron.last_success_at` | > 15 min | silent Worker/cron failure |
| OpenRouter remaining | ≤ 5 requests | the day's build budget is gone |
| `hackathon_teams.repo_url IS NULL` while `building` | any | formation failed; dispatch cannot run |
| event `paused_capacity` | > 1h | **automated** (above) |

## F. Ranking confidence (post-event)

`GET /events`, `/events/summary` and `/events/:id` carry a `quality` object with
`level` (`high`/`medium`/`low`/`unrated`), the judged population, the pre-event
gate and the post-event agreement. The Archive and Live views show the label;
low-confidence rankings are explicitly provisional. This is a description of
how much the ranking can bear, not a gate and not a score change. See
`src/judges/confidence.ts` for the exact thresholds and the 2026-10-31
retrospective caveat.

The artifact audit is separate: `scripts/artifact_audit.mjs --persist` records
contract results in `event_quality`, and the daily `Artifact audit` workflow
runs it automatically. A red run means a missing output contract, not a low
score.

The larger hardening items are scoped in `docs/ARENA_BACKLOG.md`; the quota
posture decision is in `docs/QUOTA_POSTURE_2026-10-31.md`.
