# 2026-10-17 — Dead pin: beta probed the wrong pool all day

Event context: the first fully-autonomous free-tier spawn. Ideathon
`event_485dd577` was judged; the two surviving ideas formed teams alpha and
beta; day-0 build turns were dispatched to the fresh repos
`arena-team-{alpha,beta}-d3e2e7be` (`event_693bc79b`). Alpha's day-0 turn ran,
failed on provider weather, and committed what it built. Beta's turn 1 never
produced a build: every attempt died on the harness's own quota probe, which
was reading an account beta does not own. One variable — `TEAM_KEY_PIN` — was
set where the container could see it and nowhere the runner's shell could.

## 1. What happened

Every killed beta run ended with the same line:

```
::error::OpenRouter free-tier daily request cap exhausted (probe: remaining=0) — killing container ... rather than retrying an unrecoverable wall.
```

The probe was truthful about what it read: the key it had been handed was at
0/50 free requests for the UTC day. The gap was upstream of the probe — the key
it had been handed was not beta's. Beta's own key had quota the whole time.

Blast radius: beta's day-0 turn never completed; its first build output of the
event slipped a day, and the turn-1 label is not recoverable without a manual
re-run (§13). Alpha was unaffected — by luck, not by design (§2).

## 2. Root cause: the pin lived on the container, not the runner

Phase A needs the pin in two places: in the runner shell, where it routes
`PRIMARY_KEY` vs `FALLBACK_KEY`, and passed into the container as `-e`. Before
the fix, `TEAM_KEY_PIN` existed only as the docker `-e` flag inside the
`docker run` argument list (pre-fix ~L396 — the container's copy) and in
comments. The step's `env:` block never assigned it, and `${{ }}` does not
interpolate inside `run:` shells — the same interpolation rule that produced
the 2026-09-23 backtick incident (§1 there): runner values must arrive via
`env:`.

So the shell's routing test —

```bash
if [ "$TEAM_KEY_PIN" = "KEY_2" ] && [ -n "$OR_KEY_2" ]; then
  PRIMARY_KEY="$OR_KEY_2"
  ...
else
  PRIMARY_KEY="$OR_KEY_1"
```

— read EMPTY on every run, fell to the else-branch, and selected `OR_KEY_1`
as PRIMARY for both teams. For alpha that is the intended key (its pin is
KEY_1), so a dead pin and a live pin behave identically — alpha's normal day-0
is what camouflaged the defect. For beta it meant every probe, attempt, and
burned request spent slot 1: alpha's account, already at 0/50 after alpha's
day-0. Beta's own slot-2 key sat in `FALLBACK_KEY`, unreachable because the
pinned-pool quota death sets `QUOTA_DEATH=1`, and the failover gate
(workflow L550-560) correctly refuses a cross-pool failover after a quota
kill — that veto exists so a spent pool cannot burn the other team's account.
It did its job; it was vetoing a failover that a live pin would never have
needed.

The Worker side never had the bug: `openRouterKeyForTeam`
(`src/events/build-quota.ts:70`) already mirrored the pin (beta → key 2), so
the dispatch gate kept allowing beta's turns while the runner kept probing
key 1. Two halves of the harness disagreed about which key beta owns, and the
disagreement was silent at both ends — the dead pin produced no warning, just
a wrong-key run that looks exactly like a spent quota.

## 3. Detection: the stale-secret theory died first

The first theory was a stale repo secret: beta's slot 1 held an old value, so
re-seal and retry. Disproven in two steps:

- The re-seal (10:08Z) wrote `.env`'s value correctly, yet a fresh dispatch
  (run 39024406693, 10:18Z) died identically. A write that changes nothing
  changes nothing.
- A purpose-built canary workflow (runs 39026940745, 39028544497) read both
  beta repo secrets directly and printed fingerprints: slot 1 `be6196518490bb5e`
  (0 free), slot 2 `e02afc8d6d3df473` (43 free). Both match `.env` exactly.

The stored values were never wrong — the runner was reading the WRONG SLOT.
Slot 1 for beta, every run, is not something a stale value can cause; it is
key selection, and the only key-selection input that differed between design
and reality was the empty pin. (This record writes fingerprints only; no key
value appears in it or in its commits.)

## 4. Timeline (UTC)

| when | what |
|---|---|
| 09:20:37 | run 39020759917 created (beta turn-1 manual dispatch) |
| 09:45:53 | run reconciled **completed/failure**: attempts 1–2 (nemotron, both pools) died on "Upstream idle timeout exceeded"; attempt 3 (dots-3-note-preview) burned 19.8K reasoning tokens with zero output and a length cut; Enforce failed honestly — no commits, no false success |
| 10:08 | beta's two repo secrets re-sealed from `.env` |
| 10:18:37 | run 39024406693 created; killed at the quota probe — identical signature to before the re-seal, killing the stale-secret theory |
| 10:18 → 11:18 | canary runs 39026940745 / 39028544497 read both beta slots: slot 1 fp `be6196518490bb5e` (0 free), slot 2 fp `e02afc8d6d3df473` (43 free), both matching `.env` → wrong slot, not stale value |
| 11:18:33 | run 39028199597 created — the pin fix's first run |
| 11:31:43 | attempt 1 on KEY_2 dies: "Upstream idle timeout exceeded" |
| 11:32:15 | pool failover probes slot 1 → `remaining=0` → quota kill; the QUOTA_DEATH veto holds |
| 11:32:18 | run ends (failure); Enforce failed — nothing built |
| 11:37:16 | run 39029396656 created |
| 11:41:38 | run ends — died at its FIRST model request (480-byte turn log, §12) |
| 11:45:54 | beta's `build_turns` row `team_9af854a7-928d-4aaf-91f5-800575320050_turn1` reconciled **completed/failure** (run 39029396656) — no stranded "dispatched" row, no false success |
| 12:02 (17:32 +0530) | master commit `2618d39` pushed (`88454e9..2618d39`) — the durable fix |
| after push | CI run 39030986853 and Deploy Worker run 39030986784 green |
| after use | canary workflow deleted from the beta repo (commit `12d0b2fd`); the repo then carried only `ci.yml` and `team-build-turn.yml` |

## 5. Fix

Three deliveries, in order:

1. **The step env var, where the consumer lives.** Phase A's `env:` block now
   carries

   ```
   TEAM_KEY_PIN: ${{ contains(github.repository, 'beta') && 'KEY_2' || 'KEY_1' }}
   ```

   at ~L275, with a comment block above it naming this incident so the why
   survives future edits.
2. **Direct repo patches** so the live event could proceed without waiting for
   a master push: beta `1f8a3f19`, alpha `75e1c7c6` (the same change, pushed to
   both repo copies).
3. **The durable master commit `2618d39`.** Required, not bookkeeping:
   `syncTeamHarness` re-fetches every harness file — including this workflow —
   from `raw.githubusercontent` master at each dispatch, so a team-repo-only
   fix would be silently overwritten by the still-broken committed copy on the
   next Worker-dispatched turn. The commit bundles the day's other harness
   repairs (formation re-arm, rotation-take ordering, kill-disposition
   reporting) with the pin fix: 6 files, +335/−17.

## 6. Verification

- Run 39028199597 cleared the quota probe on its first attempt and ran ~12
  minutes on KEY_2 — the first beta run of the day that was actually spending
  beta's quota.
- The canary's counter read-back confirmed attribution: slot 2 climbed
  7 → 10 used across that run while slot 1 stayed at 0/51. (A used count above
  the limit is counter lag — §9 — not a second bug.)
- Post-push CI run 39030986853 and Deploy Worker run 39030986784 are green.
- `scripts/check_team_key_pin.cjs` (6 cases) passes on the fixed workflow and
  fails 3 of 6 against the pre-fix blob (`88454e9`) — verified by running it
  against that blob, not by assumption.

Verification proves the wiring, not a build: beta's turn still died on
provider weather (§12). The pin fix removed the wrong-key failure class; it
did not make the day succeed.

## 7. Why it hid: a 16/16 rehearsal that tested the wrong layer

The probe-kill rehearsal was 16/16 green before this incident. It tested the
key-selection logic — against a sim harness that exported `TEAM_KEY_PIN`
itself. The rehearsal therefore stood in for the exact wiring that was
missing: every branch of a decision that, in production, was never reached
because the variable was empty. This is the same failure class the record has
already paid for twice: the stale `run.log` read as current, and the tally
that counted a harness message as a result. A green harness testing a
different thing than the live path is worse than no harness, because it
issues confidence.

Guard: `scripts/check_team_key_pin.cjs` asserts the three ends stay connected
— the step env assignment, the shell's read of `$TEAM_KEY_PIN`, and the docker
`-e` pass-through — plus that the assignment precedes the consumer in the same
step, and that a comment keeps the why. It fails against the pre-fix workflow
(3 cases) and passes on the fix.

## 8. Secondary finding — the quota probe's fields: requests, not dollars

`GET https://openrouter.ai/api/v1/key` returns two budgets that read alike
and mean different things:

| field | what it is |
|---|---|
| `data.free_model_daily_requests.{used,limit,remaining}` | the free-tier REQUEST quota — what the harness probe and `build-quota.ts` read |
| top-level `usage` / `limit` | the key's USD budget — on these keys `usage: 0`, `limit: 100`, i.e. "100 remaining" of a $100 cap |

Reading `usage=0, limit=100, remaining=100` as fresh quota is wrong when the
request counter says `used=12/50`. The two counters are unrelated; a reviewer
who reads the USD fields will conclude the key is untouched while the request
budget is half spent. End-of-day UTC readings: slot 1 used 51/50 remaining 0;
slot 2 used 12/50 remaining 38.

## 9. Secondary finding — the daily counter is eventually-consistent

Observed lagging 20+ minutes behind known calls: a key read 0-used long after
two calls; the same counter climbed with no new traffic. Any gate or probe
that reads it must treat a reading as stale by an unknown amount. The hard
enforcement is the provider's 429 — the counter is an early warning that can
be early or late, never the authority.

## 10. Secondary finding — raw API probes must use the unprefixed model id

The `openrouter/` prefix in the workflow is the harness's provider
namespacing (`openrouter/nvidia/....:free` tells OpenCode which provider
serves the model). The provider's own API expects the bare id
(`nvidia/....:free`). A probe that sent
`openrouter/dots-studio/dots-3-note-preview:free` to the raw API got a 400
"is not a valid model ID" — malformed input, not a dead model. The unprefixed
id responds normally (~2.5s). Any direct probe harness must strip the prefix;
a prefixed-id 400 is a probe bug, never a model verdict.

## 11. Secondary finding — the dots-3 fallback burns its budget on hidden reasoning and emits nothing

`dots-studio/dots-3-note-preview:free` — attempt 3 of the failover chain —
responds but spends its whole budget before writing output. A direct probe
returned `finish=length` with 288 reasoning tokens and ZERO content. The same
mode was observed live: in run 39020759917 attempt 3 the model burned 19.8K
reasoning tokens, produced zero output, ended on a length cut, and wrote
nothing. The model-failover safety net, as configured, produces no output — it
consumes budget and hands the Enforce gate an empty turn. Flagged as a real
risk until the fallback is replaced or its reasoning budget is capped.

## 12. Secondary finding — the pinned primary was degraded upstream all day

`nvidia/nemotron-3.5-lightning:free` timed out repeatedly through the day:
run 39029396656 died at its FIRST model request (480-byte turn log; run ended
4m22s after dispatch), and a direct 16-token probe timed out after 90s at
~17:12Z. Same-hour alternatives were healthy:
`nvidia/nemotron-3-super-120b-a12b:free` responded in 4.4s
(`finish=stop`, content "ok"), and `nvidia/nemotron-3-ultra-550b-a55b:free`
is already present in `docker/opencode.json`'s model map. Provider weather,
not wiring — but with the pin fixed, this was the entire remaining beta
failure.

## 13. Secondary finding — there is no turn-1 retry path

The next dispatch for a team is always `COALESCE(MAX(turn_number), 1) + 1`
(`src/events/executor.ts:818-821`), i.e. turn 2 — even after a turn 1 that
built nothing. Beta's product therefore starts under the turn-2 label unless
turn 1 is re-run manually first. Recorded, not fixed: turn numbering is
load-bearing elsewhere, and the manual-dispatch workaround was already used
twice that day.

## 14. State at end of day

- Beta's turn-1 row is honestly reconciled completed/failure (run
  39029396656) — nothing stranded, nothing reported as success that wasn't.
- Retries were stopped deliberately to preserve KEY_2's ~38 remaining
  requests for day 1, rather than spend them re-testing a degraded model.
- The temporary canary was removed from the beta repo (commit `12d0b2fd`)
  after its final read confirmed the fix.
- Open for day 1: re-run beta's turn 1 manually before the normal dispatch,
  or accept the turn-2 label; and whether to keep the degraded primary
  pinned or move to a same-hour-healthy alternative (super / ultra, §12).

## 15. Commits (main repo, pushed)

`2618d39` set `TEAM_KEY_PIN` on the runner — the durable fix (6 files,
+335/−17, pushed `88454e9..2618d39`; bundles the day's other harness
repairs). Pre-fix tip for reference: `88454e9`. Team-repo patches (same
change): beta `1f8a3f19`, alpha `75e1c7c6`. Canary removal in the beta repo:
`12d0b2fd`.
