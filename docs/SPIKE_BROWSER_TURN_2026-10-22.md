# Live browser-turn spike — runbook (2026-10-22)

**Status: prepared, not yet run.** Blocked only by the build quota (see
*Timing*). This is the `agent_power` gate's first pending item —
`docs/SPEC_AGENT_EMPOWERMENT_2026-08-11.md` §4 lists two things P1 could not
verify without real infra: the Alpine image build with chromium, and a live
turn whose `opencode-turn.log` shows `browser_navigate` / `browser_snapshot`
tool calls with none of the P0-0a crash signatures (`expected 'id'`,
`InvalidResponseData`). Docker is unavailable on the dev machine, so a
dispatched turn is the only honest proof.

## Command

```powershell
node scripts/spike_browser_turn.mjs
```

One command, in this order:

1. **Syncs the harness** (`scripts/sync_team_harness.mjs`) into
   `AI-arena-hackathon/arena-team-alpha-d28b420c` — alpha's repo from terminal
   event_41cbabb7. The event is complete, so a burned turn cannot affect a live
   product. The sync is mandatory for a manual dispatch: the repo's own
   workflow was last synced before the model pin and still defaults to the dead
   `lightning:free` model; a stale harness proves nothing (the first OpenRouter
   verification attempt burned 120 minutes on a pre-switch workflow).
2. Dispatches turn `spike-ui-002` with the spec's own spike prompt ("Build a
   tiny single-page web app with one interactive button, add a test, and verify
   the page in the browser.") and **explicitly pins** the current model
   `openrouter/nvidia/nemotron-3-super-120b-a12b:free`.
3. Polls to completion (45 min cap), prints non-success steps, downloads the
   `build-turn-spike-ui-002` artifact, and greps the logs.

Re-check an existing run without dispatching: `--run <runId>`.
Show what would be sent without spending quota: `--dry-run`.

## Timing

The pool is 50 requests/day/key and hackathon build turns spend it by ~00:45Z.
`event_693bc79b` completed 2026-10-22; the next ideathon (`event_dc3df601`)
runs ideation from 2026-10-23 and dispatches **no build turns** until the next
hackathon's team formation (~2026-10-27). Any UTC day in that window, after
00:00Z, is free. Do not run this during a hackathon's build phase.

## Pass criteria

- `browser_navigate` > 0 **and** `browser_snapshot` > 0 in `opencode-turn.log`.
- `crash_signatures` = 0.
- A run that still concludes `failure` (quota kill *after* the browser step) is
  a PASS for this gate — that is the expected daily-quota turn shape, not a
  harness defect.

Screenshots: the MCP writes them to `/tmp/playwright-artifacts` inside the
container (`--image-responses omit`, no filename → `--output-dir`), and the
artifact upload is logs only. The screenshot bytes are deliberately not
retrievable; a `browser_take_screenshot` call in the log is the proxy. Do not
add repo-local screenshot output just to satisfy a check.

## Failure interpretation

| Result | Meaning | Next step |
|---|---|---|
| `browser_navigate`/`browser_snapshot` present, crash 0 | PASS | record run id (below) |
| No browser calls, no crash, no quota signature | MCP not wired into the live image | check the image build step and `docker/opencode.json`'s `mcp.playwright` entry |
| `expected 'id'` / `InvalidResponseData` | P0-0a shim regression | treat as a P0 bug; do not mark the gate |
| Quota signature before any browser call | Run spent its pool while still exploring | rerun after UTC midnight; not a harness failure |
| Artifact missing | `upload-artifact` step failed | inspect the run; download logs manually |

## On pass

1. Update the spec's status line (§4a / "NOT yet verified") with the run id and
   date.
2. Tick `pending[0]` in `.arena/state.json` → `gates.agent_power.details`.
3. CHANGELOG bullet under the day's section.

The remaining `agent_power` items — the team-vs-single turn comparison (P3/P4)
and any tier-2 allowlist proposal — stay pending after this spike.
