# Investigation — 2026-08-15 build turns hang with zero output

## Symptom

From turn 15 onward (alpha), every build turn burned the full 120-minute job
`timeout-minutes` cap in "Phase A — agent work" and was cancelled by the cap,
producing:

- a 0-byte `opencode-turn.log`
- a 0-byte `opencode-turn.err.log`
- no commits, no artifact, no diagnostic

The one prior success (alpha turn 14, `run_id` 31852246148) proved the
pipeline works when the model responds: 123 JSON events over 170s, max gap
between events 17.6s, 110,702 bytes of log, and a real commit at 00:04:25Z.

The dispatch cadence made it self-reinforcing: each hung turn burned exactly
the 120-min cap before reconcile dispatched the next one ~2h05m later.

## Method

- Pulled the full job log for the hung turn 17 (`run_id` 31863960220) from the
  GitHub Actions API: the shim started cleanly
  (`workers-ai shim listening on 3129 -> api.cloudflare.com/...`), no crash
  signature, then nothing for 1h59m before the job was cancelled at the cap.
- Pulled both the hung turn's artifact (0-byte logs) and the successful
  turn's artifact (dense event stream) via the artifacts API and compared.
- Read `scripts/workers_ai_shim.js`: the shim's upstream
  `https.request(...)` to `api.cloudflare.com` had **no timeout** and the shim
  logged only its startup line — no per-request telemetry.

## Root cause

The shim is a pass-through to `https://api.cloudflare.com` for opencode's
first (and every) model call. If Cloudflare stalls — model cold start, queue,
or an API-side hang — the shim waits forever, opencode waits forever, and
because opencode had not yet emitted even its first `step_start` event, both
logs stayed at 0 bytes. Only the job's hard `timeout-minutes` cap ended the
turn, and a job killed by its timeout reconciles as a **cancelled** run —
"produced nothing verifiable" — instead of an honest failure.

The successful turn 14 at 00:00Z (right after the daily reset) and every later
turn hanging fits the stall theory: whatever state the model was in, the shim
had no way to surface it, so the turn degraded to a silent 2-hour wait.

## Fix (self-healing, two layers)

1. **Root cause** — `scripts/workers_ai_shim.js` now sets an upstream timeout
   (`SHIM_UPSTREAM_TIMEOUT_MS`, default 180s) that destroys the stalled
   `https.request` and returns a `502 shim upstream error: ... timed out`
   JSON error to opencode. opencode sees a real, diagnosable failure within
   minutes instead of hanging forever. The shim also logs every request
   (`START`, upstream status, errors, duration) to `shim.log`, so a future
   incident can answer "did opencode reach the shim at all?" from the log
   alone.

2. **Belt-and-suspenders** — `.github/workflows/team-build-turn.yml` Phase A
   now runs the container in the background behind a silence watchdog. If
   neither the turn logs nor the working tree's changed-file count moves for
   `WATCHDOG_SILENCE_MINUTES` (default 10), it kills the container and the
   turn records a real **failure** minutes after the stall instead of a
   cancelled run 120 minutes later. The scheduler then dispatches the next
   turn minutes later instead of hours later.

## Why the timeout is safe

The successful turn's worst inter-event gap was 17.6s. A healthy agent emits
a JSON event every few seconds, so a 10-minute silence across both the log
bytes and the working tree is unambiguously a hang, not a slow-but-working
agent. The 180s upstream timeout is well above normal first-token latency but
far below the old 120-minute silent failure.
