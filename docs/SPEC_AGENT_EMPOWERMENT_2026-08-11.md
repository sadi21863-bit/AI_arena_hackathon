# Build Agent Empowerment — Phase 2 Spec (2026-08-11)

**Status:** P1 + P2 implemented 2026-08-11, P3 prep (opt-in marker + arena-team
skill) implemented 2026-08-11 — see Implementation log §4a. Pending: the
live spike verification (image build + browser turn, needs the runner) and
the team-vs-single comparison the spec defers to after the spike.

---

## 1. Current state (verified facts)

- **Harness:** opencode `v1.18.8` pinned, baked into `docker/Dockerfile.arena-team-base`
  (node:20-alpine). Turn invocation (`.github/workflows/team-build-turn.yml`
  Phase A, ~line 227):
  `opencode run "$task_prompt" --model workers-ai/@cf/openai/gpt-oss-120b --auto --format json`
  → `opencode-turn.log` (+`.err`), which `src/events/build-turns.ts` records for
  the Observatory.
- **Config:** `docker/opencode.json` — one provider (Workers AI via
  `@ai-sdk/openai-compatible`, env-sourced baseURL/key), `skills.paths` →
  `/opt/opencode/skills`.
- **Skills baked:** 4 of addyosmani/agent-skills (commit f03b4a84): TDD,
  code-review-and-quality, security-and-hardening, debugging-and-error-recovery.
- **Turn prompts:** `src/events/executor.ts` (~lines 535–630) — plan →
  implement → self-verify → update BACKLOG shape, first-turn and continuation.
- **Team repo conventions:** `repo-scaffold/AGENTS.md` — build-green rules,
  VERIFICATION_FAILURE/NOTE.log obligations, BACKLOG.md protocol, harness files
  are off-limits and re-synced via `HARNESS_FILES` (`src/github/repos.ts:134`,
  includes `docker/opencode.json` and AGENTS.md).
- **Sandbox:** container runs `--read-only`, `--cap-drop=ALL`, non-root,
  `--pids-limit=100`, 2 CPU / 4 GB; egress only to api.cloudflare.com +
  registry.npmjs.org via Squid proxy + iptables; verification phase is
  `--network=none`. Image rebuilt **every turn**.
- **Gates:** `post_beta_hardening` is current and in_progress; autonomous cycle
  live as event_c35a0401. Deferred items G6 (Office parallelism invisible) and
  G7 (journal-backed replay) are relevant to §6 below but not this spec's scope.
- **Phase 1 (Context Bar):** shipped and browser-verified (`core/arena-context.js`,
  pickers removed from graph/ideas/replay, office→graph cross-link). Complete.

## 2. What was researched after Phase 1 (compiled)

1. **Skills ecosystem** — SKILL.md is a supported standard (opencode loads them;
   anthropics/skills, SkillMD, TrueFoundry registry). Discovery patterns: JSON
   index fetch, flat catalog, or local dirs. self-authored skills are proven.
   → Feed-in: D3.
2. **MCP server catalog** — MCP directories exist (official registry, Glama,
   Smithery, PulseMCP) but are mostly unmaintained; the maintained shortlist for
   this sandbox is tiny. Playwright MCP (Microsoft, official, accessibility-tree
   based — works with text-only models, runs fully local, zero egress) is the
   standout. Penpot MCP (official, open-source, free, self-hostable) is the
   design resource; Figma is not viable (paywalled Dev seats). → Feed-in: D2, D8.
3. **Turn-based vs parallel teams** — Parallel agent work is mature (worktrees
   per agent is the universal rule; in-container subagent teams vs matrix
   fan-out vs task queues vs managed platforms). The arena's fairness/
   observability/replay needs say: keep the turn as the atomic unit and
   parallelize *inside* it via subagents. → Feed-in: D1, D4.
4. **opencode full potential** — the harness supports agents (primary +
   subagents, per-agent model/permissions/steps), MCP local/remote, permission
   rules (allow/ask/deny incl. bash globs and `task` globs), custom tools,
   plugins, LSP, formatters, network config, SDK/server. Current usage touches
   none of this beyond the 4 skills. → Feed-in: D2–D5.

## 3. Design decisions

### D1 — The turn stays the atomic unit; parallelism moves inside it
Replay, verification isolation, fairness, and per-turn cost caps all depend on
the turn boundary. Parallelism is therefore implemented as **subagent fan-out
inside one `opencode run`** (a "team turn"), not as multiple concurrent jobs or
an external scheduler. Matrix fan-out and a task queue are documented as tier-3
(§7) but not built now.

### D2 — Playwright MCP for self-verification (the flagship change)
The agent's biggest gap is that it cannot see or verify what it built
(confirmed by the P0-0a/NEW-1 no-op-turn class of failures). Playwright MCP
gives it a browser whose interface is the **accessibility tree** — no vision
model needed, so it works with the text-only gpt-oss-120b.

- Package: `@playwright/mcp` (Microsoft, official, Apache-2.0). **Pinned** like
  `OPENCODE_VERSION`, and installed into the image at build time (`npm i -g` /
  `/opt/arena-mcp`), *never* via `npx` at runtime (no registry egress in the
  container).
- Browsers: installed at image build into `PLAYWRIGHT_BROWSERS_PATH` (e.g.
  `/opt/ms-playwright`); runtime needs zero network. The
  `browser_install` tool is useless here — bake, don't fetch.
- Flags for the sandbox: `--headless --browser=chromium --no-sandbox
  --image-responses omit --isolated --output-dir /tmp/playwright-artifacts`.
  `--no-sandbox` is required (container has no user-namespace sandboxing under
  cap-drop=ALL + no-new-privileges). `--image-responses omit` because the model
  is text-only — screenshots would be dead tokens; snapshots are the interface.
  `--isolated` for a clean context per turn (rootfs is `--read-only`, so no
  persistent profile anyway). Screenshots for debugging still land in
  `/tmp/playwright-artifacts` (tmpfs) via explicit `browser_take_screenshot`.
- **Base image decision:** playwright's bundled chromium is glibc; node:20-alpine
  is musl. Two options:
  - (a) Switch base to `mcr.microsoft.com/playwright:v1.x-jammy` (Node +
    chromium + system deps preinstalled). One image still serves both phases.
    Cost: larger image + longer per-turn build — mitigate with a runner-side
    Docker layer cache (actions/cache over docker save/load, or a GHCR-pushed
    prebuilt base) and measure before/after (P1/P4).
  - **(b) IMPLEMENTED 2026-08-11:** keep node:20-alpine, `apk add chromium
    chromium-swiftshader`, drive it via `launchOptions.executablePath` in
    `docker/playwright-mcp.json`. Chosen first for live-cycle safety: no base
    swap mid-autonomous-cycle, image stays small, Python/git/ripgrep wiring
    untouched. Risk: Alpine's chromium is older and rendered via SwiftShader.
  - Gate: the spike turn (§4a). If Alpine chromium proves unreliable, switch to
    (a) at P4 with the layer-cache mitigation; worst case, drop the browser
    entirely (the skill and prompts degrade to a curl smoke check).
- opencode.json wiring (verified shape for opencode):
  ```json
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["node", "/opt/arena-mcp/playwright-mcp/cli.js",
        "--headless", "--browser=chromium", "--no-sandbox",
        "--image-responses", "omit", "--isolated",
        "--output-dir", "/tmp/playwright-artifacts"]
    }
  }
  ```
- Safety: no `--allowed-origins` (the agent tests its own localhost dev server —
  the only origin it can reach; the Squid/iptables scope already blocks anything
  else). Playwright exists only in Phase A; the `--network=none` verification
  phase is untouched (standing rule).
- Dockerfile comment update: extend the binary whitelist note to include the
  chromium binary.

### D3 — Skills: creator + curated catalog + repo-local skills
- **skill-creator:** bake an arena-flavored skill-creator (SKILL.md format,
  validation checklist) that instructs agents to write authored skills into the
  **team repo's `.arena/skills/`** directory — git-persisted, so a skill an
  agent authors in turn N is available to every later turn, no runtime registry
  network needed. Update `repo-scaffold/AGENTS.md` to add: "check `.arena/skills/`
  before starting work."
- **Catalog:** keep the existing 4 skills; add `skill-creator` (above) and
  `ui-verify` (a thin skill wrapping D2's Playwright loop: serve the build →
  snapshot → assert → screenshot to /tmp → report results). Optionally bake a
  static offline INDEX snapshot of SkillMD at image build time (fetch at build,
  browse at runtime, zero egress) — only if it proves useful; each skill is
  context surface, keep the catalog lean.
- Rationale preserved from the Dockerfile: skills with human review gates
  (spec-driven, planning) and unreachable flows (CI/CD, PRs) stay excluded.

### D4 — Agents and permission rules
Define in `docker/opencode.json` (grounded in opencode agent config: `mode`,
`model`, `prompt`, `permission`, `steps`, `hidden`):

> **As implemented (2026-08-11):** the `permission` rules below shipped in P1.
> Custom agent definitions are deferred to P3 — the built-in `explore` /
> `general` subagents are enough for fan-out, and shipping new agent
> descriptions mid-cycle would change the model's delegation behavior before
> anyone measured it. `small_model` is a valid top-level config key
> (schema-verified) if cheap-model routing is wanted later (§D5).

- **builder** (primary, default) — unchanged behavior.
- **explorer** (subagent, read-only) — codebase/repo survey for the builder;
  cheap model candidate (§D5).
- **reviewer** (subagent, `edit: deny`) — self-review pass before commit
  (generator/evaluator separation).
- **tester/verifier** (subagent) — runs the test suite + the Playwright verify
  loop; used by the builder at the end of every turn.
- `permission` rules (they hold under `--auto`: auto only auto-approves `ask`;
  `deny` stays denied) — deny what the sandbox already forbids, so the tool
  surface shrinks to what works: `webfetch`/`websearch` deny (no egress),
  `external_directory` deny (workspace-bound), `bash` glob-deny for
  privilege-adjacent patterns (belt and braces on top of cap-drop).
- `permission.task` globs: builder may spawn explorer/reviewer/tester;
  subagents cannot spawn each other (no delegation loops).

### D5 — Cost control (free-tier discipline)
- `--image-responses omit` (D2) — biggest per-call saving.
- Per-agent `steps` caps so a fan-out can't run away (builder cap > subagent
  caps).
- Cheap-model routing: opencode supports per-agent `model` overrides. Explore/
  review roles may run a cheaper Workers AI model (e.g.
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, already proven as a router
  fallback) while build stays on gpt-oss-120b. Confirm model availability on
  the account before shipping; default to same-model if cheaper tier is
  unreliable — cost is secondary to turn quality.
- Every turn's token spend stays visible: the shim + DAILY_CAPS accounting
  already record usage; fan-out multiplies it, so the team-turn should be
  opt-in, not the default, until measured (P3).

### D6 — Logging & replay
- The JSON log is the arena's record. Team-mode subagent activity appears as
  task-tool events / child sessions in the session transcript — verify the
  actual log shape on the first team turn (P3) before deciding whether replay
  shows the whole team or the lead only. This dovetails with deferred G7
  (journal-backed replay); do not build new replay infrastructure here.

### D7 — Harness sync
- All new image-side files (skills, agents, MCP) live in the image — no
  `HARNESS_FILES` changes needed except `repo-scaffold/AGENTS.md` (already in
  the sync list) and `docker/opencode.json` (already synced, line 137).
- Keep the version-pinning discipline: pin `@playwright/mcp`, the playwright
  browser build, and the base image tag with a comment naming the commit/date.

### D8 — Tier-2 resources (documented, allowlist-gated, NOT built now)
Each requires adding a domain to the Squid/iptables scope + a remote MCP entry
in opencode.json + an AGENTS.md note:

- **Penpot MCP** (`github.com/penpot/penpot-mcp`) — open-source design-to-code;
  self-hosted instance + plugin; CSS-native tokens; free, no paywalls.
- **Vela Sandbox** (vela.simplyblock.io) — serverless Postgres (2 vCPU/100 GB,
  branching) for teams whose build genuinely needs Postgres (stack default is
  D1/SQLite).
- **Context7 / Grep by Vercel** remote MCP — live docs/code lookup.

Rationale for deferring: each is a network-scope expansion (a security
footprint change), none is needed for the P1–P3 goals, and the user's
"agents choose from resources" goal is already served by D3's local catalog +
repo-local skills.

### Tier-3 (documented, not built)
- **Matrix fan-out** (one Actions run, N worktree-isolated jobs + merge/verify)
  — the "round = build" mode; revisit if a turn's wall-clock becomes the
  bottleneck. Requires: green-baseline discipline, merge-conflict budget.
- **Arena-API task queue** (agents poll for work; runner fleet) — realistic
  engineering-org simulator; you become the scheduler; fairness must be
  engineered. Only as a new event phase type.
- **Managed platforms** (GitHub Agent HQ, Tembo, Codex Cloud) — external
  dependency + egress; not a fit for the scoped sandbox.

## 4. Implementation phases

Each phase is a gate-sized unit: code → local verify → live workflow_dispatch
spike → log inspection. All follow the arena loop (measure, don't assume).

### P1 — Browser self-verification (D2, D4 permissions, skill-creator + ui-verify)
Files: `docker/Dockerfile.arena-team-base`, `docker/opencode.json`,
`docker/skills/` (+2), Dockerfile whitelist comment.
- Base image change (option a) or alpine+chromium (option b); bake
  `@playwright/mcp` + browsers; add MCP entry; add permission rules; add skills.
- Verify: local build; a scratch `opencode run --auto "build a tiny page, verify
  with the browser, screenshot to /tmp"` against the shim — log must show
  `browser_navigate` / `browser_snapshot` events and a real screenshot; then one
  live spike turn on a test team repo; grep `opencode-turn.log` for playwright
  tool calls and for crash signatures (`expected 'id'`, `InvalidResponseData`).
- Measure: image build time before/after; add layer cache if it regresses.

### P2 — Prompts and conventions (D3, D7)
Files: `src/events/executor.ts` (turn prompts), `repo-scaffold/AGENTS.md`.
- Add self-verify step: "if the product has a UI, verify it in the browser
  (Playwright) before finishing; screenshot to /tmp/playwright-artifacts."
- Add `.arena/skills/` discovery rule; note that authored skills persist.
- Verify: one live turn; log shows the skill names and the verify step; agent
  actually exercises the browser on its own app.

### P3 — Team turn (D1, D4, D6) — opt-in
Files: `docker/opencode.json` (agents, task globs), `docker/skills/` (arena-team
orchestration skill), executor.ts prompt variant.
- Orchestration skill: explorer research → builder implementation →
  reviewer pass → tester/verify → builder integrates and commits. Worktree
  isolation is NOT needed at this tier (one container, sequential fan-out); the
  worktree rule applies to tier-3 matrix only.
- Verify: live turn vs a same-task single-agent turn — compare duration, token
  cost (shim accounting), and outcome quality (verify step + judging input);
  inspect JSON log for subagent events; then decide default vs opt-in.

### P4 — Measure, decide, tier-2 options
- Report build-time, token-cost, and quality deltas from P1–P3; decide whether
  any tier-2 allowlist (D8) is worth it; propose gate closure notes for
  `post_beta_hardening` → next gate (`agent_power` or per backlog convention).

## 4a. Implementation log (2026-08-11)

Landed in this session (all of P1 + P2; P3 is config-only prep, agents deferred):

- `docker/Dockerfile.arena-team-base` — `chromium chromium-swiftshader` added
  to the apk install; `ARG PLAYWRIGHT_MCP_VERSION=0.0.79` (npm-registry-verified
  latest) + pinned global `npm install -g "@playwright/mcp@..."` at build time;
  `COPY playwright-mcp.json` → `/opt/arena-mcp/`; binary-whitelist header
  comment updated; `chmod a+rX` covers `/opt/arena-mcp`.
- `docker/playwright-mcp.json` (new) — `browser.launchOptions`: executablePath
  `/usr/bin/chromium-browser`, args `--no-sandbox --disable-dev-shm-usage
  --disable-gpu` (sandbox needs: no userns under cap-drop, tiny /dev/shm).
- `docker/opencode.json` — `mcp.playwright` (local stdio via `node
  /usr/local/lib/node_modules/@playwright/mcp/cli.js`, `--headless
  --browser=chromium --isolated --image-responses omit --output-dir
  /tmp/playwright-artifacts --config /opt/arena-mcp/playwright-mcp.json`);
  `permission` denies: webfetch/websearch/external_directory + bash pattern
  denies (`su/sudo/mount/umount/chroot/nsenter/curl/wget *`) — belt-and-braces
  on top of the container caps; `deny` is respected under `--auto`.
- `docker/skills/ui-verify/SKILL.md` (new) — serve → navigate → snapshot →
  exercise → fix → screenshot → stop server; localhost-only rule; curl fallback.
- `docker/skills/skill-creator/SKILL.md` (new) — authors skills into the team
  repo's `.arena/skills/` (committed, so they persist across turns); catalog-
  first rule; the arena-native "agents create their own skills" mechanism.
- `repo-scaffold/AGENTS.md` — rule 9 (browser self-verify) + rule 10
  (`.arena/skills/` discovery before work).
- `src/events/executor.ts` — both turn prompts (first + continuation): the
  preamble now names `.arena/skills/`, and SELF-VERIFY step 3 now instructs
  browser verification with Playwright when the product has a UI.
- P3 prep (second commit, same day): `docker/skills/arena-team/SKILL.md` (new
  baked-in orchestration skill — build director + sequential fan-out over
  explore/general subagents, one container, no worktrees at this tier) and
  `applyTeamMode()` in `src/events/executor.ts` — a task_prompt containing
  the `[team]` marker (workflow-input prefix or dispatch-payload inline) runs
  the team variant: the PLAN/IMPLEMENT steps are replaced with PLAN+FAN-OUT /
  IMPLEMENT+INTEGRATE; SELF-VERIFY and BACKLOG steps are untouched. No marker
  = prompt byte-identical to before. Functionally tested (8/8 assertions,
  both prompt shapes, marker positions, no-op case). Custom subagent
  definitions stay deferred; the variant uses the built-in explore/general
  agents.
- Note: `git add -A` after a run — the repo had no commits before today;
  `d78b498` is the initial commit (platform + Phase 1 + P1/P2), P3 prep
  commits on top.

Validated locally:
- `npx tsc --noEmit` clean; all JSON parses.
- `docker/opencode.json` spot-checked against the live schema
  (https://opencode.ai/config.json): `mcp` McpLocalConfig keys, all
  `permission` keys (`webfetch`, `websearch`, `external_directory`, `bash`
  pattern-map), and `skills.paths` are all schema-valid.
- `@playwright/mcp` 0.0.79 pinned (registry-verified; depends on playwright
  1.63.0-alpha; node >= 18, image has node 20).

LIVE-tested against the real 0.0.79 server on Windows (Edge channel, same
flags as the container minus the chromium path — `--headless --isolated
--image-responses omit --output-dir`):
- Server boots clean, MCP handshake valid, 24 tools served. The P0-0a
  "expected 'id'"/`InvalidResponseData` crash signature does NOT reproduce.
- `browser_navigate` → `http://127.0.0.1:<port>` (the sandbox flow) succeeds;
  `browser_snapshot` returns the accessibility tree (heading + button found).
  This is the text-only-model proof: snapshot content, not images.
- `file://` navigation is blocked by default (filesystem guardrail) — good.
- Output-path behavior (source-verified in playwright-core bundle):
  `browser_take_screenshot` with NO `filename` → `--output-dir`
  (`page-<timestamp>.png`); with `filename` → the server cwd, i.e. the
  workspace. The skill now says: no filename (repo stays clean).
- CLI flags verified against 0.0.79 `--help`: `--output-dir`, `--config`,
  `--isolated`, `--image-responses omit`, `--headless` all present; config
  file schema (`config.d.ts`) confirms `browser.launchOptions`,
  `browserName: 'chromium'`, `imageResponses: 'omit'`, `outputDir`.

NOT yet verified (needs real infra — the gate):
- Image builds (apk chromium + global npm install + non-root chromium launch
  with the launch options).
- A live spike turn: `opencode-turn.log` should show `browser_navigate` /
  `browser_snapshot` events and none of the P0-0a crash signatures
  (`expected 'id'`, `InvalidResponseData`).
- Turn duration/cost delta vs the pre-change turns.

Spike run (user): `gh workflow run team-build-turn.yml -f team=alpha
-f turn_id=spike-ui-001 -f task_prompt="Build a tiny single-page web app with
one interactive button, add a test, and verify the page in the browser."`,
then grep the run's `opencode-turn.log` for `browser_navigate|browser_snapshot`
and for `expected 'id'|InvalidResponseData`. Docker is not available on the
development machine (verified 2026-08-11), so the image build + Alpine
chromium launch can only be verified via this spike.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Image build time/size grows (chromium ~700 MB) on every-turn rebuild | Layer cache; prebuilt GHCR base; measure in P1/P4; alpine fallback (b) |
| More tools (≈15 playwright tools) → more context per call with gpt-oss-120b | `--image-responses omit`; lean catalog; keep MCP server count at 1 |
| Tool-call reliability regressions on a new tool surface (P0-0a class) | Shim already normalizes tool_calls; per-turn log grep; version pins |
| Subagent fan-out multiplies token spend against ~9,500-neuron daily cap | steps caps; cheap-model read-only roles; team turn opt-in (P3) |
| Chromium under cap-drop=ALL / read-only rootfs | `--no-sandbox`, non-root, browsers+output on /opt and /tmp; test in P1 |
| Browser must never leak into the `--network=none` verify phase | Playwright config exists only in the image the verify step reuses — verify step takes its own command; standing rule re-checked in review |
| Skill catalog bloat = context bloat | Catalog review gate in P1/P4; skills are loadable tools, not forced commands |

## 6. Out of scope / aligned with existing deferrals
- G6/G7 (Office parallelism visibility, journal-backed replay) — unchanged;
  P3's log-shape finding feeds G7 later.
- Cold storage rollover (spec §15.1) — still untestable at current volume.
- Anything that reopens the no-VM history: no VM-based scheduling; tier-3 queue
  option would be container/worker based if ever built.

## 7. Open questions (need user decisions before P1/P3)
Provisional answers from the 2026-08-11 implementation pass are in brackets;
override any of them and the corresponding work follows.

1. **Base image:** accept the mcr.microsoft.com/playwright swap (bigger, robust)
   vs alpine+apk chromium (smaller, older)? **[Answered provisionally: alpine
   chromium implemented first — live-cycle safety; revisit at P4 if the spike
   shows it flaky.]**
2. **Team turn:** default mode or per-turn opt-in via a prompt flag/param?
   **[Answered 2026-08-11: opt-in via the `[team]` task_prompt marker —
   shipped in P3 prep. Default-vs-opt-in is decided by the P3 comparison
   turn after the spike.]**
3. **Tier-2 now?** Any of Penpot/Vela/Context7 worth a network-scope expansion
   before the next live cycle, or defer to P4? **[Deferred to P4 — no scope
   expansion mid-cycle.]**
4. **Cheap model for read-only subagent roles** — worth adding a second Workers
   AI model to the image, or keep everything on gpt-oss-120b for turn quality?
   **[Same model for now; `small_model` key exists if we change our minds.]**

## 8. Sources
- opencode docs (Aug 2026): intro, agents, mcp-servers, permissions, models —
  opencode.ai/docs
- Playwright MCP: github.com/microsoft/playwright-mcp; playwright.dev/mcp
- Skills: agentskills.io; anthropics/skills; SkillMD; TrueFoundry registry
- Parallel orchestration 2026: Composio Agent Orchestrator, Claude Code
  subagents/dynamic workflows, git-worktree isolation guides (see research
  thread notes 2026-08-11 in project memory)
- In-repo: `docs/ARENA_BACKLOG.md`, `.arena/state.json`,
  `docs/INVESTIGATION_2026-07-28.md`, `docs/CODE_REVIEW_2026-07-22.md`
