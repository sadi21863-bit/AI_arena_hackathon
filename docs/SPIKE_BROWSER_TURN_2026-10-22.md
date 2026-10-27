# Live browser-turn spike — runbook and result (2026-10-22, passed 2026-10-25)

**Status: PASSED 2026-10-25** — run
[40205698968](https://github.com/AI-arena-hackathon/arena-team-alpha-d28b420c/actions/runs/40205698968),
model `openrouter/recursive/flint-v1.0:free`. Evidence from
`opencode-turn.log`: `browser_navigate` ×6, `browser_snapshot` ×11,
`browser_take_screenshot` ×5, crash signatures 0. The turn committed 7 files
(`5c0746b`) and was then killed by the free-tier daily cap — the expected
quota-bounded turn shape, not a harness failure.

This was the `agent_power` gate's first pending item —
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
   the page in the browser.") and **explicitly pins** the model
   `openrouter/recursive/flint-v1.0:free` (override with `--model`; the
   workflow's own default now matches). The id MUST carry OpenCode's
   `openrouter/` provider prefix — a bare OpenRouter id fails as
   `UnknownError` before the model is ever reached (spike-ui-003, below).
3. Polls to completion (45 min cap), prints non-success steps, downloads the
   `build-turn-spike-ui-002` artifact, and greps the logs.

Re-check an existing run without dispatching: `--run <runId>`.
Show what would be sent without spending quota: `--dry-run`.

## Result (2026-10-25)

| Turn | Model | Result |
|---|---|---|
| `spike-ui-002` | `nvidia/nemotron-3-super-120b-a12b:free` | FAILED in 1.9m before any tool call: provider 404 "Function ... Not found for account". The pinned model was dead upstream (still catalog-listed). |
| `spike-ui-003` | `recursive/flint-v1.0:free` (bare) | FAILED in 1.8m: `UnknownError`. Dispatch bug — the workflow/OpenCode needs the `openrouter/` prefix. |
| `spike-ui-004` | `openrouter/recursive/flint-v1.0:free` | **PASS**: 6 navigate / 11 snapshot / 5 screenshot matches, 0 crash signatures, 7 files committed, quota-killed after the browser step. |

The tool names in the log are namespaced by the MCP server
(`playwright_browser_navigate`), so the counts above are substring matches;
that satisfies the spec's `browser_navigate|browser_snapshot` grep.

Spike-ui-004's committed work: `public/index.html`, `public/app.js`,
`public/favicon.svg`, `src/tapCounter.js`, `src/__tests__/tapCounter.test.js`,
plus edits to the repo's server entry point (7 files, +113/−5, commit
`5c0746b` in `arena-team-alpha-d28b420c`).

## Timing

The pool is 50 requests/day/key and hackathon build turns spend it by ~00:45Z.
`event_693bc79b` completed 2026-10-22; the next ideathon (`event_dc3df601`)
started the same morning and is day-gated: architecture on days 4-5,
ready_for_judging at day 6 (2026-10-28 08:46Z), hackathon team formation after
judging. No build turns run before then. Any UTC day after 00:00Z is free; do
not run this during a hackathon's build phase.

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
| Provider `404` / "Provider returned error" with no tool calls | Pinned model died upstream (NVIDIA "Function not found for account", 2026-10-25) | probe the catalog, pin a replacement that passes a tool-call probe, and let the workflow's attempt-3 fallback cover the gap |
| `UnknownError` ~2m in, before any model output | Bare OpenRouter id, or the model is missing from `docker/opencode.json` | dispatch the `openrouter/<id>` form and declare the model in the map |
| Artifact missing | `upload-artifact` step failed | inspect the run; download logs manually |

## On pass

Done 2026-10-27:

1. The spec's §4 status line records the run id and date and marks the image
   build + live browser spike verified.
2. `.arena/state.json` `gates.agent_power.details.pending[0]` is resolved with
   run 40205698968.
3. CHANGELOG entry added.

The remaining `agent_power` items — the team-vs-single turn comparison (P3/P4)
and any tier-2 allowlist proposal — stay pending after this spike.
