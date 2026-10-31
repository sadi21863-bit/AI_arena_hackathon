# Changelog

Recent operator-visible changes. `git log` is the full record; this file
notes what changed behavior in production and why.

## 2026-10-31

- **Judged-population decision recorded.** The Arena will not automatically
  expand small-event judging populations. The retrospective shows population
  size alone does not predict agreement (31 targets → 0.554, 12 → 0.717), and a
  full Workers AI pass cannot fit the 9.5k/day neuron cap. Small populations
  stay labelled low-confidence; a manual re-score needs a recorded reason.
  Decision and triggers: `docs/JUDGED_POPULATION_DECISION_2026-10-31.md`.
- **Quality snapshots and a semantic-lite audit layer.** `recordEventQuality`
  writes `event_quality_snapshots` when an event reaches terminal judging, and
  `scripts/snapshot_event_quality.mjs` backfills/refreshes every terminal event
  from the live API. `/headroom.ranking_quality` shows the recent labels
  (event, level, population, retrospective r/band). The artifact audit now also
  checks semantic-lite shapes — near-duplicate ideas (Jaccard ≥0.82 on
  title+one-liner), orphan critiques, generic phrases, thin builds (<30
  nonblank lines across sampled product files) and tests without assertions.
  These are warnings, never `--strict` failures; `event_2eaf0bb2` flags the
  historical duplicate shape (`Facilify` ×2, `ForensicsHub` ×3, `ESIGN
  Compliance Toolkit` ×2) while the current baseline stays at 0. The first
  single-reviewer sample (`docs/SEMANTIC_SAMPLE_REVIEW_2026-10-31.md`) found
  **0/34 ideas with a `research_anchor`** and assessed 0 clear pass / 6 weak /
  4 fail, with build-scope over-reach as the recurring problem. The ideation
  prompt now requests a research anchor; the audit flags unanchored finalists.
- **Durable ops alerts and a public ranking-confidence label.** The scheduled
  tick now writes `ops_alerts` for `worker_subrequest_log.total >= 45/50`, an
  event paused on capacity for over an hour, 3+ `team_formation` failures in
  the current incarnation, a build turn with no `run_id` 30 minutes after
  dispatch, and an OpenRouter probe hold (`quota_hold`). `GET /headroom` and
  `GET /alerts` surface them, and `ALERT_WEBHOOK_URL` optionally pushes
  (`text`/`content` + counts only).
  `/headroom.cron.stale` computes the 15-minute heartbeat check. Without the
  secret, alerts are still durable and visible rather than silent. `GET
  /events`, `/events/summary` and `/events/:id` now carry a `quality` object
  computed live from the pre-event gate and the post-event leave-one-out
  agreement; the Archive/Live views label low-confidence rankings as
  provisional (fewer than 10 judged targets, a failed gate, or agreement
  outside 0.60–0.95). No gate threshold or judge weight changed. Recorded in
  `docs/QUOTA_POSTURE_2026-10-31.md` that one OpenRouter account is the
  operating default and a second account needs explicit owner approval.
- **Artifact audit now runs daily and persists per event.** `--persist` writes
  a compact result to `event_quality`; `GET /events/:id` returns the failures
  and the Archive shows an audit chip. `.github/workflows/artifact-audit.yml`
  runs daily with `--strict --persist`, so a missing contract turns the
  workflow red instead of leaving a dated baseline as the only check.
  `MAINTAINERS.md` + `.github/CODEOWNERS` make the single-maintainer bus factor
  explicit; adding a second maintainer is backlog R-6.
- **Hackathon `event_382ab43e` failed before any build turn — 53 subrequests
  against a cap of 50, then a cadence wedge.** `team_formation` failed 288
  times from Oct 28 09:41Z to Oct 29 09:36Z; both team rows stayed `forming`
  with `repo_url = NULL`, and 12 dispatch attempts (turns 2-7 per team) died on
  `Cannot read properties of null (reading 'split')`. The measured cost was 30
  GitHub calls + 19 template fetches + 4 DB statements; the 20 per-file
  Contents PUTs were the bulk. The watchdog abandoned the event on Oct 30
  10:45Z, and the cadence guard then treated the abandoned `building` event as
  still-running even though revival only handles day-gated statuses — so no
  future ideathon could start. Fixed: the scaffold seeds the empty repo with
  one Contents PUT and writes the other 19 files in one Git tree commit (~38
  fresh, ~10 retry), secret provisioning lists and sets only missing names,
  dispatch throws a named error on a null repo, and the cadence guard only
  blocks for statuses revival can restore. The event is closed `complete`
  with no winner; the next ideathon auto-started on 2026-10-31 09:10Z
  (`event_40e6b8d8`) on the already-open 10-day slot. Evidence:
  `worker_subrequest_log` 53/50 and
  `docs/INCIDENT_2026-10-31_SUBREQUEST_STALL.md`.
- **Calibration retrospective added; the 3-anchor gate is a warning, not a
  certificate.** `scripts/calibration_retrospective.mjs` applies the gate's
  judge-level Pearson metric to the existing `judge_scores` (leave-one-out
  panel means) and prints the pre-event result beside it. Across 10 judged
  ideathons, every low-side and high-side gate failure was corroborated by
  low real-population agreement (`0.483→-0.180`, `0.955→0.086`), but three
  passes were not: `0.933→0.427`, `0.751→0.435`, `0.902→0.554`. Only
  `0.937→0.717` and `0.994→0.918` landed inside the band. The 36-target event
  measured 0.918; 6-target events are noisy. Full table and caveats:
  `docs/CALIBRATION_RETROSPECTIVE_2026-10-31.md`. No threshold or judge-weight
  change was made from this pass.
- **Artifact audit added (read-only).** `scripts/artifact_audit.mjs` checks
  ideas (fields/lengths/placeholders and finalist `build_scope`), critiques
  (JSON strength/weakness/suggestion), and build repos (real turns, product
  files, a test, and a `VERIFICATION_REPORT.md` Verdict). Baseline on
  `event_dc3df601`: 34/34 ideas pass (1 note: a blocked idea has no
  `build_scope`), 21/21 critiques pass, and 2/2 builds pass — alpha's report
  is honestly NOT READY, beta's is READY. The selected ideathon's hackathon
  child produced no repos, so the build sample falls back to `event_693bc79b`;
  `--hackathon=event_382ab43e --strict` correctly fails both teams and names
  every missing contract. Full report:
  `docs/ARTIFACT_AUDIT_2026-10-31.md`. Persistence/automation remains R-3.
- **Provider/quota failure runbook and review follow-ups recorded.** Added
  `docs/RUNBOOK_PROVIDER_AND_QUOTA_FAILURES.md` (triage queries, dead-model
  playbook, abandoned-event recovery, alert thresholds) and scoped the
  post-event calibration and sampled artifact-audit work in
  `docs/ARENA_BACKLOG.md`. The public repo description was corrected from
  "monthly" to the continuous ideathon/hackathon cadence.

## 2026-10-27

- **Live browser-turn spike PASSED — `agent_power` pending item resolved.**
  Run 40205698968 in alpha's terminal repo (`arena-team-alpha-d28b420c`, model
  `openrouter/recursive/flint-v1.0:free`) logged `browser_navigate` ×6,
  `browser_snapshot` ×11, `browser_take_screenshot` ×5 and zero P0-0a crash
  signatures. The turn built a tap-counter page, tested it, committed 7 files
  (`5c0746b`), and was then killed by the free-tier daily cap — the expected
  quota-bounded shape. This is the live proof of the Alpine chromium image
  build and Playwright MCP path that the empowerment spec could not verify
  without real infra. Runbook/evidence table:
  `docs/SPIKE_BROWSER_TURN_2026-10-22.md`.
- **Production build-model pin replaced: super-120b died upstream.** The
  2026-10-18 pin `nvidia/nemotron-3-super-120b-a12b:free` returned provider
  404 ("Function ... Not found for account") on both pools before any tool
  call, while still appearing in the OpenRouter catalog. The pin is now
  `recursive/flint-v1.0:free` (verified by direct tool-call probe and the
  passing spike), with `nemotron-3-ultra-550b-a55b:free` as the attempt-3
  fallback; the old dots-3 fallback is retired from that slot because it is
  known to fail closed on hidden reasoning
  (`docs/INCIDENT_2026-10-17_DEAD_PIN.md` §11). `provider_error()` now treats
  the generic `Provider returned error` / `"statusCode":404` signatures as
  failover triggers, and `scripts/spike_browser_turn.mjs` gained `--model`
  plus REST artifact download.

## 2026-10-22

- **Event `event_693bc79b` completed autonomously — winner: alpha,
  "Friction-Track: Internal UX Auditing for Teams".** 16 build turns under the
  daily-quota model (0 successes; every turn was a quota-bounded handoff that
  still committed), 4 chronicler entries, 36 tribunal reflections, ratings
  applied 07:35Z; judging ran on groq qwen3.8-27b (14 judge scores). The next
  ideathon (event_dc3df601) auto-started at 08:46Z and finished its 12
  deep-research items by 09:16Z — no human in the loop.
- **Project gate advanced: `post_beta_hardening` closed, `current_gate` is now
  `agent_power`.** The gate's one open item — live verification of Part 2, the
  P0-0a shim and the rebuilt Office — is satisfied by production cycles since
  2026-08-06 (event_49862627 complete 2026-09-09 with a winner; event_7308f1fe
  complete 2026-10-02 with 13/34 successful turns and a winner; event_41cbabb7
  complete 2026-10-11; and event_693bc79b, which ran its full endgame —
  judging, tribunal, ratings, winner — unattended on 2026-10-22). Agent-
  empowerment verification that is still outstanding (live browser-turn spike,
  team-vs-single comparison) is carried into the new `agent_power` gate with
  its evidence criteria recorded in `.arena/state.json`.

## 2026-10-20

- **First 48h of autonomous building turns: quota-bounded partial turns
  confirmed; turn prompt now requires clean-install verification.** Alpha ran
  turns 2-5 and beta turns 2-3 (alpha on the 00:00Z tick, beta the next one),
  all terminated by their 50 req/day/key pool, all preserved and committed
  except alpha t4 (a ~1-minute remainder slice, no changes). Alpha t2 broke
  dependencies (jest@25 vs ts-jest@29 peer) while its own `npm test` passed on
  a stale node_modules; Phase B's clean install caught it and t3 repaired it.
  SELF-VERIFY now demands a clean dependency install (and lockfile commit)
  before a turn may claim green. D1 reconciled all 8 rows; no duplicate
  dispatches, no stuck turns; both keys end the UTC day at used 56/limit 50.
  Details: docs/REHEARSAL_2026-10-18_BETA_T1.md (Outcome section).

## 2026-10-18

- **Roster split repaired live; formation now assigns all teams in ONE call.**
  On event_693bc79b both teams held all 12 agents (12+12 instead of 6+6).
  Root cause: runTeamFormation called assignTeamMembers once per team with a
  single-element array, and the round-robin `i % teams.length` inside then
  sent every non-lead agent to that one team, twice over. Formation now
  stages a row for every team first (building teams still join the roster
  read; leads stay deterministic on resume) and makes one assign call for
  all teams, while repo creation still runs one repo per Worker invocation —
  the shape the 50-subrequest cap killed twice on 2026-10-17. Live rosters
  repaired with delete-only, re-runnable SQL (turns_taken = 0 guard; 12+12
  -> 6+6, all turn counts preserved), verified on D1: 6/6, overlap 0, leads
  alpha->alex / beta->ellis. Pinned by scripts/check_team_roster_split.cjs
  (17 checks; 6 of them fail on pre-fix HEAD).
- **Pinned build model swapped: nemotron-3.5-lightning -> super-120b (both
  OpenRouter free), ahead of the first building-phase dispatch (~07:20Z).**
  Lightning went upstream-dead during 2026-10-17 — empty 200s, then 90s
  timeouts, then 109s finish=length with zero content — the same class that
  killed run 39020759917's attempts 1-2 and would have failed both teams'
  first building turns at attempt 1. The replacement,
  nvidia/nemotron-3-super-120b-a12b:free, passed a direct agentic probe
  before being pinned (correct write_file tool call, then a coherent
  follow-up turn) in the workflow model defaults and the baked
  docker/opencode.json. dots-3-note-preview stays as the attempt-3 net; it
  can burn its budget on hidden reasoning, so the net is best-effort, not
  guaranteed.
- **First building turn rehearsed post-swap: real code committed, then
  quota-killed by design (beta turn 1, run 39101835248).** Re-dispatched
  beta's turn 1 manually after the swap. super-120b behaved: the agent
  explored the repo, wrote `src/commitmentsync/main.py` (+83) and
  `tests/test_main.py` (+58), ran its own lint/tests (pytest 3 passed), and
  the pipeline committed everything as bdda3f6e (+208/-16) before the in-run
  quota probe killed the container at free-tier remaining=0 (KEY_2 used
  54/50). Only "Report agent crash" exited 1 — Enforce, Phase B
  install/verification, and Commit progress all passed; the D1 row
  reconciled completed/failure. New operating shape: a 50 req/day/key pool
  drains in ~5 minutes of agent work at this model's speed, so building
  turns are quota-bounded partial turns with committed work as the handoff
  (alpha still fresh on KEY_1 for its ~07:20Z turn 2; beta held until the
  2026-10-19 UTC reset). See docs/REHEARSAL_2026-10-18_BETA_T1.md.

## 2026-10-17

- **First fully-autonomous free-tier spawn.** Ideathon event_485dd577 was
  judged (top ideas: "Friction-Track: Internal UX Auditing for Teams" 6.825 ->
  team alpha, "CommitmentSync" 6.65 -> team beta; judgedIdeas 8, queueFailed
  35 - the top-2 selection ran on what completed). Child hackathon
  event_693bc79b formed both teams and created both team repos
  (arena-team-{alpha,beta}-d3e2e7be) with day-0 turns dispatched to each.
- **Team formation hit the 50-subrequest cap twice; beta's first turn was
  stranded until repaired by hand.** Queue items 1 and 3 died with "Too many
  subrequests by single Worker invocation". Item 1 was recovered by the next
  cron tick (the re-queue guard at scheduler.ts:610 saw zero non-failed
  team_formation rows at that moment); item 3 was not - there is no retry path
  for continuation items, and the same guard can never fire again once both
  hackathon_teams rows exist (`existing === 0 && formedTeams < 2`). Beta's
  turn row was stamped dispatched_at before the dispatch call that the cap
  killed, so it sat "dispatched" with no run and would have been
  staleness-swept to failed at +2h. Repaired by dispatching turn 1 manually
  with the exact formation prompt (extracted from executor.ts:725-733,
  attributed to the roster member whose take was already recorded - Ellis).
  reconcileBuildTurns linked the manual run to the stranded row by run-name on
  the next tick (reconciled_at 09:20:54, run_id 39020759917) - correlation by
  run-name works as designed.
- **Both strand causes fixed same-day (worker 45bc8e02; workflow fix staged
  for push).** (a) The scheduler's re-arm guard now counts only pending/claimed
  team_formation items as in flight and re-fires while any team row sits at
  'forming' (scheduler.ts) - the exact live state (completed continuation +
  stuck team) now re-queues, resumes the idempotent handler, and stops once
  the team flips to 'building'; a failing resume retries at cron cadence,
  the watchdog this strand never had. (b) Both dispatch handlers now bank the
  rotation take AFTER the dispatch, gated on (fresh turn row || actually
  dispatched): a resume either performs the missing dispatch itself (exactly
  one take, same attribution) or finds the run already exists (no take) -
  never the double-count + wrong-persona prompt the old pre-dispatch write
  allowed. (c) team-build-turn.yml kill sites now export a disposition
  (silence|budget|quota) and the failed-turn report names the real kill
  instead of assuming the silence watchdog (found when run 39013607598's
  60-min budget kill was reported as a watchdog kill). Pinned by 12 new
  check cases in scripts/check_team_formation_split.cjs (including a
  reproduction of the old guard stranding the team) and re-verified by the
  probe-kill rehearsal 16/16 against the refreshed machinery; tsc and the
  full checker suite pass. The workflow edit reaches team repos only once
  pushed to main (harness sync pulls from there).
- **Alpha's failed day-0 turn exercised the pool failover live.** Attempt 1
  (pinned pool) died after ~44 min with "Upstream idle timeout exceeded" - a
  provider flake, correctly matched by the provider-signature grep - and the
  failover ran attempt 2 on the OTHER pool (the KEY_2 account) until the
  60-minute shared turn budget killed it at 08:27. No QUOTA_DEATH kill fired;
  both pools had fresh daily budgets. Work produced before the kill was
  committed and pushed (4956778c); VERIFICATION_FAILURE.log honestly records
  the day-0 state (TS18003 - tsconfig includes src/**/* before src/ exists).
- **Beta's repaired turn-1 run failed on its own, then was rerun.** The manual
  run 39020759917 failed in two distinct ways: attempts 1 and 2 (nemotron, on
  both pools) died on "Upstream idle timeout exceeded" - the same flake that
  hit alpha's attempt 1, now on both accounts, which is exactly the case the
  attempt-3 model failover exists for - and attempt 3 (dots-3-note-preview)
  connected but burned 19.8K reasoning tokens with ZERO output and ended on a
  length cut, writing nothing. The "Enforce real build output" gate failed the
  job honestly (no commits, no false success) and reconcileBuildTurns recorded
  completed/failure at 09:45:53.
- **The rerun died at the quota probe - correctly, and the first diagnosis was
  wrong.** Rerunning run 39020759917 (09:47Z) ended in 5m46s with the first
  live probe kill: "free-tier daily request cap exhausted (probe:
  remaining=0)", disposition=quota, and the QUOTA_DEATH veto held pool
  failover back as designed. The probe was reading the truth: the first theory
  said beta's secret slot held a stale value, but the re-seal (10:08Z) and a
  fresh dispatch (run 39024406693, 10:18Z) killed identically, and a
  purpose-built canary (runs 39026940745, 39028544497) read both beta repo
  secrets directly: slot 1 = fp be6196518490bb5e (0 free - the key alpha's
  day-0 burned to the cap), slot 2 = fp e02afc8d6d3df473 (43 free). Both
  values match .env exactly, so the secrets were never stale - beta was
  reading the WRONG SLOT.
- **ROOT CAUSE (2026-10-17): TEAM_KEY_PIN was never set on the runner, so
  every beta run silently used slot 1 - alpha's key.** `TEAM_KEY_PIN` existed
  only as a docker `-e` flag (workflow L396, which feeds the container) and
  never as a step env var, so the shell's pin test read empty, fell to the
  else-branch, and set PRIMARY_KEY="$OR_KEY_1" on every run. Beta probed and
  burned alpha's key (already at 0 after alpha's day-0) while beta's own key
  sat in slot 2 as the unreachable fallback - QUOTA_DEATH correctly vetoes
  cross-pool failover, so the exhaustion never triggered a switch. Alpha was
  unaffected by luck: its intended slot IS slot 1, so a dead pin and a live
  pin select the same key. Fixed by adding
  `TEAM_KEY_PIN: ${{ contains(github.repository, 'beta') && 'KEY_2' || 'KEY_1' }}`
  to the Phase A step env block. Verified live: run 39028199597 cleared the
  probe on its first attempt, and the canary showed slot 2's counter climb
  7 -> 10 used while slot 1 stayed at 0/51. WHY IT HID FOR SO LONG: the
  probe-kill rehearsal was 16/16 green because the sim harness exported
  TEAM_KEY_PIN itself - it tested the key-selection logic while standing in
  for the very wiring that was missing (same failure class as the stale
  run.log and the Write-Output tally: a green harness testing the wrong
  thing). The fix is applied to the beta/alpha repo copies directly (pushed
  1f8a3f19 / 75e1c7c6) but MUST also be committed and pushed here:
  syncTeamHarness re-fetches every harness file from raw.githubusercontent
  master at each dispatch, so the next Worker-dispatched turn would overwrite
  the team-repo fix with the still-broken committed copy. Pinned by
  scripts/check_team_key_pin.cjs - fails against the pre-fix workflow (0
  active TEAM_KEY_PIN assignments) and passes on the fix.
- **The daily-cap counter is eventually-consistent, not real-time.** During
  monitoring, free_model_daily_requests lagged 20+ minutes behind known calls
  (a key showed 0 used long after two calls; another climbed with no new
  traffic). Any gate or probe that reads it must treat a fresh reading as
  stale-by-an-unknown-amount; the hard enforcement is the provider's 429.
  Counter lag alone did NOT explain the beta quota kill - the probe's 0 was
  real: the dead pin made it read the other team's already-exhausted slot
  (see the ROOT CAUSE bullet above).
- **The pinned free model degraded upstream; beta turn 1 still unbuilt at end
  of day.** With the pin live, run 39028199597 cleared the probe and ran on
  KEY_2 for ~12 min (3 requests burned; canary counter 7 -> 10), but attempt 1
  died on "Upstream idle timeout exceeded" mid-discovery, and the pool
  failover then hit the remaining wall: the other pool is alpha's account,
  already spent to 0, so its probe killed the retry - QUOTA_DEATH veto and the
  spent pool both did their jobs. A second dispatch, run 39029396656, died at
  the FIRST model request with the same idle timeout (480-byte turn log, zero
  work): provider weather, not harness wiring. Retries stopped to preserve
  KEY_2's ~35 remaining requests. The same signature hit alpha day-0 attempt 1
  and beta's original attempts 1-2, so it predates the pin fix. The Worker
  side never had the dead-pin bug: openRouterKeyForTeam
  (src/events/build-quota.ts:70) already mirrors the pin (beta -> key 2),
  which is why the dispatch gate kept allowing beta turns while the runner
  kept probing key 1. Day-1 note: there is no turn-1 retry path - the next
  dispatch is turn 2 (MAX+1, src/events/executor.ts:818-821), so beta starts
  its product under the turn-2 label unless turn 1 is re-run manually first.
  The temporary secret-probe canary was removed from the beta repo (commit
  12d0b2fd) after its usage read confirmed the fix.

## 2026-10-15

- **Correction to 2026-10-11: the Zen pool keys were never dead.** They
  authenticate — `GET /v1/models` with the same values returns 200. Build turns
  failed on Zen's *free-tier entitlement*: the provider refuses headless/CI
  clients (upstream 403 `FreeTierError`, surfaced to the CLI as a generic
  `401 Invalid credential`, which is what made it look like expiry). Rotating
  the keys would have changed nothing. The standing "Zen pool keys are dead,
  replace them" action item is **withdrawn**; the migration below is the fix.
  The credential guard's advice was rewritten to match — it now reads PROVIDER
  ACCESS FAILURE and explicitly "Do NOT rotate the keys".
- **Build turns now run on OpenRouter**
  (`openrouter/nvidia/nemotron-3.5-lightning:free`, fallback
  `openrouter/dots-studio/dots-3-note-preview:free`), replacing Zen (free tier
  refuses headless clients) and Groq (measured 2026-10-13: its ~4,000-token
  practical per-request ceiling cannot carry the ~13.5K-token opening request,
  so trimming could never close the gap). `ZEN_*` identifiers are gone from the
  workflow; `OPEN_ROUTER_API_KEY`/`_2` are the pool.
- **Found live (verification turn 001): a loud retry loop burns the whole job
  timeout.** After a provider error the agent re-compacted and retried for the
  full 120-minute job cap — emitting a JSON event every few seconds, so the
  silence watchdog never fired. It recorded as a 'cancelled' run, and the
  compaction eventually summarised the task away entirely ("no specific user
  intent or coding task has been established"). Two guards added to
  `team-build-turn.yml`: `WATCHDOG_MAX_MINUTES` (default 60 — caps total
  Phase-A wall time across ALL attempts, with `budget_left()` refusing new
  failover attempts a spent budget cannot pay for) and
  `ContextOverflowError`/`context_length_exceeded`/`Request too large` in both
  the provider-error and debug signature greps.
- **One build turn consumed ~110 free-model requests and exhausted the free
  daily cap (50).** Measured via `GET /api/v1/key` (`free_model_daily_requests`,
  which moved 18 → 128 during the turn); a 429 does *not* increment that
  counter, so those were successful requests, not retries. The free tier
  therefore cannot sustain even one turn/day at this consumption. The
  provider's own 429 text confirms the unlock: 10 credits → 1,000 free model
  requests/day. Reset is UTC midnight, not a rolling window.
- **Dispatch now self-heals a repo missing credentials.** `setTeamRepoSecrets`
  ran only at `createTeamRepo`, so a repo created before a provider switch
  never gained the new key — the live shape on 2026-10-13, when existing team
  repos lacked `OPEN_ROUTER_API_KEY` until a human set it by hand. The drift
  was already *reported* on `/headroom`; nothing repaired it. The pre-dispatch
  path now lists the repo's secret names (one subrequest in the steady state —
  dispatch sits near the free-plan cap of 50 — and the `!justCreated` skip the
  formation path relies on is preserved) and re-seals only the missing names,
  leaving present values untouched. Name-only by design: GitHub never returns
  values, so a rotated value under an unchanged name stays a manual operation
  (`scripts/set_repo_secret.mjs`). Provisioning and the `/headroom` reporting
  lists now derive from one `BUILD_SECRET_SPEC`, so they cannot disagree again
  (they did once: the `_2` failover keys were provisioned but unreported).
  Locked by `scripts/check_credential_repair.mjs` (12 cases).
- **The free tier becomes the schedule: daily sessions, quota-gated dispatch,
  an extended build window.** Measured 2026-10-15: one build turn consumes
  ~110 free-model requests against a hard 50/day/account cap that resets at
  UTC midnight (not rolling), so every turn past the first of a UTC day
  walked into a guaranteed 429 wall — and the scheduler, which has dispatched
  on turn COMPLETION rather than the calendar since 2026-08-01, kept feeding
  it. `MAX_BUILD_TURNS_PER_DAY` drops 6 → 2, the second dispatch is gated on
  a live quota probe (`src/events/build-quota.ts`: one `GET /api/v1/key`,
  fail-open, cached per pool — a spent pool holds until the UTC reset, sound
  because `remaining` only decreases within a day), and the hackathon's
  build window extends from days 1-2 to days 1-4 — a deliberate spec §3.2
  deviation, because ~50 requests/day funds one session per team per day and
  five sessions is what a team needs. The turn prompt now says so: one
  coherent milestone, commit each increment, last commit is tomorrow's
  handoff. `scripts/health_check.js` mirrors the new cap. Locked by
  `scripts/check_build_quota.mjs`.
- **A spent free pool fails fast in the workflow instead of burning 10
  minutes of silence.** `team-build-turn.yml` kills the turn's container the
  moment OpenRouter's `free-models-per-day` signature appears in its logs
  (the retry is unrecoverable until the UTC reset — previously the turn
  waited out the 10-min silence watchdog), and the signature now counts as a
  provider error so the pool/model failover chain fires on exactly the
  failure it exists for.
- **That kill was watching a signal that never appears — the probe replaced
  it before the next turn could trust it.** The verify-002 turn-log artifact
  was pulled and read before believing the grep: opencode's session log is a
  pure progress feed (`step_start`/`tool_use`/`text`/`step_finish`, zero
  error events) and the err log stayed empty while the turn sat ~13 minutes
  in opencode's internal 429 retry loop — the provider error body never
  reaches anything the harness can see. The watchdog now probes the
  attempt's own pool (`GET /api/v1/key`, every tick, `remaining <= 0` ->
  kill); the log-grep remains as a belt for providers that do surface the
  signature. Quota death is now explicitly vetoed from the failover chain
  (`attempt_failed`): `FALLBACK_KEY` is the *other team's* account, so
  retrying a spent cap there would spend that team's day — the scheduler's
  probe holds dispatches until the reset instead.

## 2026-10-11

- **`event_41cbabb7` produced nothing and is unrecoverable.** Two independent
  faults, one of them mine:
  - **Beta never formed.** The 2026-10-03 one-team-per-item split was
    insufficient. The continuation was enqueued with no `scheduledFor`, so
    `processQueue(limit=3)` claimed it in the SAME Worker invocation, which had
    already spent 53 subrequests. The cap is per invocation, not per item, so
    both teams shared one budget; beta starved and died with "Too many
    subrequests", leaving an empty repo with no commits, no files, no secrets
    and no team row. Fixed by scheduling the continuation 60s out so
    `claimNext` takes it in a fresh invocation.
  - **Alpha: 19 turns, 0 successful.** Every attempt died on `401 Upstream
    request failed: Invalid credential`. The harness reported each as "the
    agent emitted text without writing any files", which points at the prompt
    and the model; both were fine. The agent never made a single API call.
- **The instrumented subrequest counter earned its place immediately** — its
  first live rows caught the regression above within one formation, and
  corrected the cost model: a single team is **53** subrequests and completes,
  so the cap is above 53 and the earlier ~47 estimate was low. The failure was
  invocation-level budget sharing, which is why reducing per-item work alone
  could never have fixed it.
- **Two harness gaps made a credential outage look like an agent-discipline
  problem.** The crash/provider signature grep had no auth patterns, so the
  operator-facing signature line printed **empty** on the one error a human
  could act on; and the Enforce gate reported "no files written" as agent
  laziness, when it could equally mean the model was never reached. Auth
  signatures are now in the signature grep, and the no-file-changes branch
  checks for them first and exits with "the agent never reached the model... NOT
  an agent-discipline failure". Covered by
  `scripts/check_credential_guard.mjs` (10 cases).
- **The 2026-09-30 `createTeamRepo` credential fix is verified working for the
  first time**: alpha's repo carries all four secrets automatically. The
  provisioning was correct — the key **values** had expired underneath it,
  sometime between 2026-10-02 (last successful turn) and 2026-10-08.
- **BLOCKING, needs the user: the Zen pool keys in `.env` are dead** and must
  be replaced, or every future build turn fails the same way. This fix makes
  the failure *legible*; it does not self-heal it.

## 2026-10-03

- **`team_formation` now measures its own subrequest cost**, replacing the
  arithmetic the previous two fixes were derived from. `src/observability/subrequests.ts`
  counts the calls that draw on the per-invocation budget — GitHub requests
  (counted in `githubRequest`, the single boundary all GitHub calls pass
  through), main-repo harness/scaffold fetches, and the D1 statements in the
  formation path — and `handleTeamFormation` records the totals to a new
  `worker_subrequest_log` table from a `finally` block, so a *failed* run
  records its cost too. That is precisely the case worth knowing, and it is the
  one that produced every failure in this file.
  - Covers three failure modes that would make the measurement worthless:
    measurement windows must not bleed across invocations (Workers reuse
    isolates, so module state could inflate every total after the first); the
    counter must not silently become a no-op reporting a comfortable number;
    and the logging INSERT must not itself trip the cap it measures. All three
    asserted in `scripts/check_subrequest_counter.mjs` (11 cases).
  - Stated limits: it counts what the arena issues, so a total is a **lower
    bound** — it cannot see subrequests Cloudflare makes internally — and D1
    statements made by callees are not counted. Both err toward under-reporting,
    so an under-cap log that still hits the cap means something outside this
    module is issuing requests, which is the case worth catching.
  - **Already falsifies one of my own numbers:** the GitHub-only model said 40
    per team; adding the 6–7 direct D1 statements puts an item at ~47. Still
    under 50, but by ~3 rather than ~10. The fix was likely sufficient and is
    closer to the ceiling than previously admitted — established by counting,
    not by more arithmetic.
  - No live formation has run since (event_284f548c still in deep_research), so
    the first real number arrives with the next hackathon.
- **`team_formation` now fits the Worker subrequest cap: 78 → 40 per team.**
  Follow-through to the partial fix below, and the change that actually reaches
  the limit. `putFile`'s existence GET is skipped when `createTeamRepo`
  observed the repo being created (a retry takes the 422 branch and keeps every
  GET, so idempotency is intact), and `handleTeamFormation` now provisions one
  team per queue item with a continuation enqueued for the second — no new
  state needed, since the loop head already skips teams at status `building`,
  making termination structural. `scripts/check_team_formation_split.cjs` also
  asserts that removing that skip would be *caught*, so a future break fails a
  test instead of looping a live event.
- **Fixed a pre-existing churn loop this exposed:** with both teams `building`,
  the scheduler's `team_formation` queue count fell to 0, so every 5-minute tick
  enqueued a no-op item that formed nothing — one wasted item per tick for the
  rest of formation day. The guard now also checks that fewer than two team rows
  exist.
- **All four team repos now carry the `.gitignore` negations**, verified by
  driving the self-heal against `arena-team-alpha-75504818` and
  `arena-team-beta-75504818` — the only two with both the missing negations and
  an agent's own `/.pydeps/` entry. Both artifacts un-ignored, the agent's entry
  intact, and the `*.log` rule deliberately left in place (the negations are
  what make the harness's files win; dropping the blanket rule would start
  tracking every stray runtime log).
- **`.gitignore` negations now self-heal at every harness sync.**
  `ensureGitignoreTracksArtifacts` appends only the missing
  `!VERIFICATION_FAILURE.log` / `!VERIFICATION_NOTE.log` lines instead of
  overwriting the file, and runs first in `syncTeamHarness`. The 10-02 fix
  corrected `repo-scaffold/.gitignore`, but that file is a *scaffold* file —
  copied once at repo creation — so `arena-team-alpha-75504818` and
  `arena-team-beta-75504818` still carried the broken copy and would have
  swallowed every future verify report. Promoting `.gitignore` into
  `HARNESS_FILES` was considered and **rejected**: agents edit that file
  (alpha turn 1 appended `/.pydeps/`), and `syncTeamHarness` overwrites any
  file whose content differs from main's, so it would silently delete their
  additions. Verified on the real alpha file — the one repo with both the bug
  and an agent's own entry: both artifacts flipped ignored→tracked,
  `/.pydeps/` survived, `app.log` stayed ignored. 10 cases in
  `scripts/check_gitignore_patch.cjs`.
- **Reduced `team_formation` subrequest cost 156 → 122 (cap is 50).** 4 of 5
  items on `event_7308f1fe` died with "Too many subrequests by single Worker
  invocation". Two provably-redundant sources removed: the pre-dispatch harness
  sync no longer runs for a repo the same item just created (`createTeamRepo`
  already wrote all 14 harness files from the same source), and the four
  `setRepoSecret` calls share one `public-key` fetch. **Still 2.4× over the cap
  — this is a partial mitigation, not a fix**, and the incident record is
  explicit about what remains: skipping `putFile`'s existence GET for
  known-fresh repos (~40/team, under the cap), raising the Workers plan, or
  splitting the item per team. The event recovered on its own via per-team
  idempotency, so this never cost a live event anything. Full analysis in
  `docs/INCIDENT_2026-09-23_HARNESS.md` §10.
- **Hackathon `event_7308f1fe` completed. Alpha won: avg 8.0 (range 7–9) vs beta
  avg 6.0 (range 3–8).** 14 judge scores total. Alpha's turns succeeded
  consistently (t14–t17 all success); beta's turns failed on test errors
  (`src/app.test.ts`, `src/services/textract.test.ts`,
  `src/services/categorize.test.ts`) and the agent was repeatedly killed by the
  silence watchdog (exit 137). The `.gitignore` fix landed too late to help
  beta during this event (its last turn was 4h before the fix), but is in
  place for all future events.
- **New ideathon `event_284f548c` started** (deep_research phase, created
  2026-10-02 04:16 UTC). System healthy: cron fresh, `/health` ok, no team
  repos yet (expected for ideathon). The corrected `.gitignore` will be in
  every new team repo created from this point forward.

## 2026-09-30

- **Live incident: `event_7308f1fe` built nothing for ~27 hours because
  `createTeamRepo` never set the Zen pool keys.** All 14 build turns across both
  teams (2026-09-29 03:05 → 2026-09-30 05:51) failed on the workflow's own
  guard — `Neither Zen pool key is configured (OPENCODE_API_KEY and
  OPENCODE_API_KEY_2 are both empty)`. Both teams hit
  `MAX_BUILD_TURNS_PER_DAY = 6` with zero successful turns, so the event burned
  its entire daily build budget twice over. Root cause: `createTeamRepo`
  provisioned only `CF_ACCOUNT_ID`/`CF_API_TOKEN`, never the Zen keys the build
  workflow reads. The previous event's repos worked **only because an operator
  set those keys by hand afterwards** — the gap was in the data the whole time
  and was treated as a one-off instead of a missing code path.
- **Every safeguard was green and all of them were blind to this.** The queue
  recorded the failures faithfully but a fast-failing turn is indistinguishable
  from a provider flake; `/headroom` reported `harness.inSync: true` on both
  repos because it checks the workflow file's blob SHA, not whether the
  credentials that workflow reads exist. The missing invariant is "team repo
  exists" ⇒ "team repo can run its own workflow". Full write-up in
  `docs/INCIDENT_2026-09-23_HARNESS.md` §9.
- **Fixed:** `createTeamRepo` now provisions the Zen pool keys from the
  Worker's secrets like the `CF_*` pair (`repos.ts:432-441`). Both are optional
  in `Env`, so a Worker with only one pool still forms teams instead of
  throwing. `OPENCODE_API_KEY_2` added to the Worker's secrets so both pools
  are available to provision. The two live repos were also provisioned by hand
  to unblock the event.
- **Verified end-to-end before calling it fixed:** a dispatch on
  `arena-team-alpha-c5ad953c` cleared the credential guard, ran real inference,
  and produced 37 files / 4,796 lines / 14 test files in commit `bc60d7d`, with
  the locked-down verification container passing. It still exited 1 with an
  **empty** crash/provider signature (no 429, no provider error, no `expected
  'id'` regression), so this reads as a driver-level exit after the work was
  committed — the designed "preserved but failed" path.
- **ECC verification-loop proven absent, not just unproven.** With this turn
  being the first real product turn since the skill was wired in
  (2026-09-26), `VERIFICATION_REPORT.md` was **not** produced — the phase
  commands ran and passed because the workflow runs them, and the report is a
  request rather than a gate.
- Both new team repos confirmed `harness.inSync: true` at blob `1bea42c1`: the
  byte-exact sync (vs. the CRLF-broken manual path) held on first contact with
  a freshly created event's repos.
- **Fixed the root cause of every "reported honestly, acted on by nobody" case:
  `repo-scaffold/.gitignore` had `*.log` under `# Logs`, which silently
  ignored `VERIFICATION_FAILURE.log` and `VERIFICATION_NOTE.log`.** The verify
  container writes the report into the workspace, then `git add -A` skips it as
  ignored — so the file existed on the runner and vanished before the push.
  Verified across all four team repos (full history, two events): neither file
  has EVER been committed. Only `VERIFICATION_REPORT.md` (`.md`, not `.log`)
  appears. This is the mechanical cause of:
  - alpha's `TS2307` surviving 7 days and 10 consecutive red CI runs — the agent
    was never told `@aws-sdk/lib-dynamodb` was missing from `package.json`;
  - beta failing three consecutive turns on the same two test files
    (`src/app.test.ts`, `src/index.test.ts`) — same reason.
  Both were instructed (AGENTS.md rule 3, workflow error message) to read a
  file that could not exist in their repo. Fixed by negating both after the
  `*.log` rule; real runtime logs stay ignored. Covered by
  `scripts/check_gitignore_contract.sh` using `git check-ignore` (the same
  predicate `git add` uses), with a negative control against the pre-fix file.
  Pushed to both live team repos via `scripts/sync_gitignore.cjs` (uses
  `git update-index --cacheinfo` to set the exact blob, avoiding the CRLF trap).
- **`/headroom` now reports whether a team repo can actually run, not just
  whether it is current.** The harness probe compared the workflow file's blob
  SHA, so it reported `inSync: true` on two repos whose build turns could not
  authenticate — a green check for the wrong property, which actively confirmed
  the wrong conclusion during the incident above. Each `harness` row now also
  carries `runnable`, `missingCredentials`, and `optionalCredentialsMissing`
  (`checkTeamCredentials` in `repos.ts`), read name-only from
  `GET /repos/{repo}/actions/secrets` — GitHub never returns values, so it is
  safe on the cron tick. `OPENCODE_API_KEY_2` is reported as optional because a
  missing second pool means "no failover", not "cannot run"; a repo the token
  cannot read reports an error rather than reading as a pass.
- **`health_check.js` had a blind spot that suppressed the alarm.** In
  `checkTurnsProducedWork` a team with turns dispatched but none successful hit
  `if (!succeeded) continue`, so a team producing *nothing* was skipped — the
  check meant to catch "success without work" said nothing when there was
  neither success nor work. Now `>= 3` dispatched with `0` succeeded is a
  `FAIL`, and there is a new `harness` check wired into the run.
- **Both fixes verified against the real failure mode, not just the happy
  path.** With `OPENCODE_API_KEY` temporarily deleted from
  `arena-team-beta-c5ad953c` (safe: both teams are at their 6/6 daily cap, so
  no turn can dispatch), `/headroom` reported `inSync=True` **and**
  `runnable=False, missing=[OPENCODE_API_KEY]`, and `health_check` raised
  `FAIL harness ... cannot run build turns`. Secret restored, both green again.
  A check that has only ever passed is the thing this whole incident is about.
- Local `.env` has two Groq keys (`GROQ_API_KEY_1`, `GROQ_API_KEY_2`) —
  correcting an earlier note that claimed no spare existed. `OPENCODE_API_KEY_`
  is missing its trailing `1` relative to the `_1`/`_2` convention used by the
  other key sets in the same file.

## 2026-09-29

- **Ideathon `d9d7a33f` judged on `qwen/qwen3.8-27b` (Groq)** — the first
  production judging pass with no fallback to Workers AI. All 126 scores from
  the single model/pool, so this event's scores are internally comparable in a
  way the previous arena's were not. 18 ideas scored, range 1–9, mean 5.69, no
  saturation or all-7s collapse. Top two, both `fresh` recycle class:
  **NFT-KYC Hub (8.0)** and **Auto-Expense Capture Assistant (7.7)**.
- **Calibration failed for the first time ever: correlation 0.959 against a
  0.60–0.95 acceptance band, i.e. it broke the *upper* bound.** The anchor
  details show every judge separating the strong/mid/weak anchors almost
  perfectly, which is the over-discrimination signature the ceiling exists to
  catch. Judging proceeded regardless — **by design, not by oversight**
  (`src/events/scheduler.ts:417-425` reasons that a hard block risks
  permanently stalling an unattended event over one low-n dip; the soft flag
  was implemented 2026-07-28 per `docs/INVESTIGATION_2026-07-28.md:504`).
  **Suspected, not proven:** the strengthened weak-entry padding clause
  (2026-09-27) may be over-tightening judges into agreement. One sample
  cannot separate that from qwen3.8 simply being a consistent model; treat
  the causal link as an open hypothesis.
- **Fixed a real user-facing bug found by reading that first failure.** The
  Live view reported it as "correlation 0.96, **below the 0.6 threshold**" —
  the wrong side of a two-sided band, pointing an operator at the wrong remedy
  (loosen the anchors) for the one signal that had never fired before. The
  Office view and `scripts/health_check.js` compounded it by calling any
  failure "low-confidence", which is false for an over-correlation. Now the
  band is a single exported constant (`CALIBRATION_MIN`/`MAX`), the API
  returns `failedSide` and the `band` so no client restates the numbers, and
  every surface describes the side it actually breached. Covered by
  `scripts/calibration_verdict_test.mjs` (10 cases: live value, both
  boundaries, both failure sides, legacy payloads with no `band`).
- **Export bundles now carry calibration caveats in `manifest.json`.** P2-7's
  "Done when" — a failed calibration producing a visible consequence where a
  reader of the results would see it — was met in the Observatory but *not* in
  the frozen bundle, which shipped `passed: 0` as a bare row. Bundles now emit
  `caveats[]` with a direction-specific message. Also catches **band drift**:
  `event_c35a0401` stored `passed: 1` at correlation 0.994, above the ceiling
  that postdates it, so a bundle would otherwise claim "calibration passed".
  Verified against four real events (high fail, low fail, stored-pass drift,
  clean pass).
- **Product code-quality review of both hackathon repos** (alpha
  `75504818`, beta `75504818`). Beta is clean: 8/8 CI green, 434 lines of real
  isolated tests, no secrets. Alpha has 2 green then **10 consecutive failures
  since 2026-09-21** — `src/services/storage.ts` imports
  `@aws-sdk/lib-dynamodb` at 12 sites, and that package is absent from
  `package.json`, so `tsc` fails with TS2307. The arena's own verify step
  *did* catch it (the turn is recorded failed) but the work was still committed
  by design, and nothing compels the next turn to read
  `VERIFICATION_FAILURE.log` — alpha's own BACKLOG still lists "keep ci.yml
  green" as an open TODO. Same shape as the missing dependency: reported
  honestly, acted on by nobody.
- Both team repos independently regenerated a copy of the dead
  `scripts/workers_ai_shim.js` (302 lines, removed from the harness
  2026-09-21). Harmless but dead weight, and a sign the scaffold misleads.
- Conduct finding recorded for post-event analysis: cumulative strikes blocked
  17/36 ideas and touched 8/12 agents, vs ~2.4/12 agents expected by simulation.
  Thresholds deliberately left unchanged mid-event.

## 2026-09-28

- `GET /headroom` now reports **harness drift**: each live event's team
  repos' build-workflow blob SHA vs main. Added after beta was found 7
  commits behind and one dispatch from running a pre-failover harness.
- Fixed a CRLF defect the probe caught within an hour: manual harness syncs
  were pushing the Windows working copy instead of git's committed blob, so
  both team repos carried 948 CRLF line endings — bash would have failed on
  the first line of tonight's build phase. Re-synced byte-exact.
- Lockfile churn no longer counts as build output. `npm`/`pip` rewrite
  lockfiles during the install phase, and that rewrite was satisfying the
  "Enforce real build output" gate — so a turn that wrote no product code
  could report success. Lockfiles are now excluded from the gate's
  change-detection and from the watchdog, and a commit-step guard restores
  them when they are the only change a turn produced. Package.json still
  counts, so genuine dependency work is unaffected. Verified in a scratch
  repo across 6 cases (churn-only, real work + churn, dependency change +
  churn, failure-log + churn, pure no-op, untracked new lockfile).
- Free-model evaluation completed across all 12 discovered Zen free-model
  entries: **3 work** (`nemotron-3-ultra-free`, `mimo-v2.5-free`,
  `big-pickle`), 7 dead, 1 is not a coding model (`jev-1.13-free`), 1 skipped
  on upstream evidence. (Corrected 2026-09-29 from "all 10 / 5 dead" — the
  original miscount; catalog contents were not re-measured.)
- Confirmed the Zen/Nvidia common-mode outage (2026-09-23 → 09-28, ~4d20h)
  resolved.

## 2026-09-26

- Adopted three discipline patterns from `affaan-m/ECC` (MIT): the
  `verification-loop` skill (6-phase ladder → `VERIFICATION_REPORT.md`,
  wired into both build-turn prompts and the team skill), a TDD evidence
  report (RED/GREEN/suite counts in the turn message) plus
  untrusted-plan rules in the TDD and scaffold skills, and a browser
  flake-triage table in `ui-verify`.
- `postIdea` coalesces agent-supplied fields to NULL (one submit died with
  an opaque `D1_TYPE_ERROR` on an undefined field, 2026-09-25).

## 2026-09-24

- Attempt-3 model failover: both pools failing the pinned model re-runs
  the turn once on `opencode/big-pickle` (default, dispatch-overridable).
  Proven live during the Nvidia outage — the turn that would have died
  now builds. Big Pickle runs clean through the storm (non-Nvidia
  upstream); remaining free-model evals stay suspended until it clears.
- Reverted a test turn's `package.json` churn on the management repo
  (agent ran `npm install` against a read-only prompt).

## 2026-09-23

- Build-turn prompt travels via environment, not inline interpolation —
  an agent-written BACKLOG row with backticks executed as shell and killed
  12 straight turns with exit 127 (`4a9d396`).
- One Zen key pinned per team (alpha→key 1, beta→key 2) with same-turn
  failover on provider-error signature; only the active key enters the
  sandbox; fail-fast guard when both keys are empty.
- Crash-grep covers dead/deprecated model IDs (Zen catalog churns).
- Manual test dispatches to the repo's default branch (was hardcoded
  `master`, 422 on team repos); Enforce/watchdog ignore failover
  `attempt1.*` diagnostics.
- Docs: providers deep-dive folded into budget research §9, architecture
  comparison folded into conduct spec §10, stale headers corrected
  (Office proposal, redesign plan), week-0 READMEs de-retired script refs.

## 2026-09-21

- Dead Workers AI shim removed from build turns (proven zero-traffic);
  prompt-injection-safe task passing; staggered team dispatches.
- `spike-turn.yml` renamed `manual-build-test.yml`; Week-0 gate scripts retired.

## 2026-09-20

- Observatory `?kiosk` query hides nav/context/footer for OBS capture.
- Office inspector shows cross-event Elo (N-5 ratings were computed but invisible).
- Ideas Board cards show harshest-judge rationale excerpt + conduct recycle chip.
- Nav dims phase-irrelevant instruments; arena switcher label deduped.
- Orphaned Graph/Replay views removed (live as Arena tabs); empty/error states carry retry/reason/link.
- New "What's new" delta view (`/events/:id/changes` + Live card).
- Office sprite-clump fix (group-shift spread math).

## 2026-09-19

- Predictive capacity pause (`paused_capacity`): parks events when both
  inference pools can't cover a phase, resumes after UTC reset. Caught and
  fixed its own permanent-park bug the next day via a live event.
- Orphaned hackathon `8d24ba01` (576 dead queue rows) deleted via admin cleanup route.
- Judging probe re-run on `qwen3.8-27b`; Mason outlier retested clean (8/9.5/9).

## 2026-09-17

- Groq judging moved `qwen3.6-27b` → `qwen3.8-27b` (both predecessors
  decommissioned; verified `model_not_found` live). Dead llama caps removed.
- Build turns: model via dispatch input, unused `GROQ_API_KEY` dropped,
  provider-error crash signatures, push-credential fallback documented.
- Main-repo CI, `.env.example`, headroom near-cap flags, CONTRIBUTING, MIT license, repo topics.

## 2026-09-16 and earlier

- See git history (`post_beta_hardening` era): revision gate, architecture
  recall grounding, superpowers skill adoptions, calibration overfit guard,
  same-SHA judging guard, intra-event dedupe, AGENTS.md doc reset.
