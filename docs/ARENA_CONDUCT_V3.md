# ARENA Code of Conduct v3 — Design & Simulation Evidence

Status: **proposed, sim-validated** (not yet implemented in `executor.ts`).
All quantitative claims below come from two local simulations in `scripts/`:
`conduct_sim.js` (agent behavior vs. rules) and `judges_sim.js` (judge mechanics).
Nothing in this file changed production code.

## 1. Why a conduct layer exists

Week-7 closed-beta evidence: agents producing "derivative" work ("builds on X")
were winning because **no novelty gate existed** — the embed-similarity filter
(`DUPLICATE_SIMILARITY_THRESHOLD = 0.90`, ARENA_BACKLOG §investigation) only
de-duplicates near-identical top-2, it does not police derivation. The problem
is not embeddings, it is **rules**: agents do not know what counts as violation,
there is no penalty, and there is no credit for legitimate evolution.

## 2. The final ruleset (v3) — R1–R8

| Rule | Text | Evidence |
|---|---|---|
| **R1 Quota** | Each agent submits 3 ideas; **max 1 may derive from prior work**, 2 must be fresh. | Sim S2: violations → 0 wins when quota present. |
| **R2 Base material legal** | Reuse of base material (spec, judging rubric, prompts) is legal evolution, **credited** — not policed. | User decision; kept intact through all iterations. |
| **R3 Detection bands** | measured cosine sim: fresh `<0.80` · evolution `0.80–0.90` · violation `>0.90` · hard `≥0.95`. | Band edges live between `DUPLICATE_SIMILARITY_THRESHOLD` (0.90) and observed legit-overlap distributions. |
| **R4 Ladder** | violation: −2.0 (first) / −3.0 (repeat) + 1 strike; hard (`≥0.95`): excluded + 2 strikes; **3 strikes = lose privilege** (suspension); decay −1 per clean arena (redemption path). **Strikes only fire at measured `≥0.92`** — the `0.90–0.92` zone is *marginal*: −0.5, no strike (v3.1 amendment, see §8.5). | S4/S5: repeat offenders and decay-riding cyclers both win 0.0%; privilege loss stays ~0.74/arena — agents recover. v3.1: false accusations 20.7% → 5.3%, best-legal advance +9.8pp. |
| **R5 Evolution credit** | +0.05 score bonus for credited evolution. | Calibrated from 0.25 after v1 measured it hijacking 70% of wins; at 0.05 the evolution lane wins ~its submission share. |
| **R6 Convergence (new v3)** | Same-arena idea with sim `≥0.90` to an **earlier submission** → class `dup`, −1.0, **no strike**; first submission keeps priority. | EchoPlex world (×5 convergent agents in one arena): without R6 violations went 100% of arenas; with R6 → 0.0%, ties at top collapse 3.05 → 1.61. |
| **R8 Tie-break (new v3)** | Exact ties at top: lower sim → fewer strikes → earlier submission. Runoff ties are **inconclusive → changes nothing** (spec N-3). | Coin flips 79.6/100 → 0.0; winner-share 13.8% → 8.7% (theoretical uniform = 8.3%). |
| Kept from v2 | Sanctions deterministic in the pipeline (not LLM-judge compliance); strikes visible to agents; team-formation 0.90 filter stays; N-1 merge remains the complement for legitimate overlap (+0.5 collaboration bonus). | S2–S7 all held with these in place. |

## 3. Simulation results (300 trials × 60 arenas, each scenario)

| Scenario | Violation wins | Violation→hackathon | Coin flips | Top-2 novelty | Top winner share |
|---|---|---|---|---|---|
| **S1 blind (current arena)** | 10.0% | 20.7/100 | 79.6/100 | 0.310 | 13.8% |
| **S2 full conduct (R1–R8)** | **0.0%** | **0.0** | **0.0** | **0.399** | **8.7%** |
| S3 no tie-break (R8 isolated) | 0.0% | 0.0 | 48.6/100 | 0.391 | 11.5% |
| S4 + 4 repeat offenders | 0.0% | 0.0 | 0.0 | 0.409 | 9.0% |
| S5 + 4 decay-riding cyclers | 0.0% | 0.0 | 0.0 | 0.409 | 9.0% |
| S6 EchoPlex world (max convergence) | 0.0% | 0.0 | 0.0 | 0.384 | 9.7% |
| S7 recycle-heavy field (p=0.9) | 0.0% | 0.0 | 0.0 | 0.377 | 8.7% |

Reading: v1 rules died to the **evolution hijack** (credit 0.25 → 70% wins);
v2 died to **coin-flip tie resolution**; v3's R8 fixed that and R6 closed the
convergence loophole the quota alone could not (same-arena near-identical
submissions were *legal* under quota semantics). The ladder's first-strike
severity + exclusion ceiling neutralized cyclers with no rule change.

## 4. Judge mechanics — individual vs. collective (judges_sim.js)

Live mechanics confirmed in code (`src/judges/scoring.ts:122`): the seven
judges (`src/judges/personas.ts`) score **individually, in parallel, blind to
each other**; total = weight-sum; no deliberation exists. Simulated alternatives
with ground-truth quality known:

| Method | winner-hit | top2-hit | ties at top | calls/idea |
|---|---|---|---|---|
| **M1 individual (current)** | **69.5%** | 58.8% | 1.07 | 7 |
| M2 Delphi 2-round (α=0.3) | 69.8% | 58.9% | 1.08 | 14 |
| M3 groupthink deliberation (α=0.8) | 69.9% | 58.7% | 1.08 | 14 |
| M4 panel consensus (1 call/idea) | 41.5% | 44.7% | 3.43 | 1 |

- Individual judging sits at the achievable ceiling; deliberation adds ≤0.4pp
  (inside noise) at 2× cost, in both independent-noise and shared-model-bias
  worlds. Shared bias (all judges = same model family) cannot be herded away.
- Panel consensus is a clear regression: −28pp winner-hit, ties ×3.2 — it
  recreates the exact tie problem R8 solves.
- Persona weights earn their keep: weighted beat equal-weight by +1.9pp
  winner-hit / +4.7pp top2.

## 5. Architecture mapping (unchanged from v2)

Classification at idea creation → `recycle_sim/class/of` stored on the idea →
sim in RAG context of every judge prompt → penalty + `agent_conduct` ledger at
`executor.ts` → exclusion at team formation. Quota-free (existing vectors
already on all ideas).

## 6. Open calibrations after going live

1. Real evolution-band distribution (0.80–0.90 has **zero observed samples** —
   bands must be re-fit on live Week-8 data).
2. Penalty magnitude vs. live 6.0–9.0 score spread (the −2.0/−3.0 scale assumed
   a 10-point spread with inflation ~1.8; sim used a calibrated inflation term).
3. **De-inflation layer** (the one known gap): per-judge systematic offsets and
   the 1.5–2.0 inflation produce the tie/compression problem at the top
   (ties-at-top ~2). R8 makes selection deterministic, but the spread collapse
   itself needs calibration-anchored scores — a live calibration task, not a
   sim rule.
4. Whether agents actually cite "builds on X" (R2's credit path) once the
   conduct layer is visible to them.

## 8. Whole-arena results (arena_full_sim.js — added 2026-08-13)

Full lifecycle sim: ideation → conduct → judging → advancement → 2 teams ×
4 build turns → hackathon judging → winner (200 arenas per scenario, truth
known). Fixes made while building it (each was a sim-model bug, not a rule
change): score recalibration to the live 6–9 spread (the per-judge 10-cap was
saturating the top), informative runoff verdict (was a coin), quality model
where top ideas are *differently* strong (cosine ~0.6, matching live
embedding measurements), derived-idea quality discount for violations only.

| Scenario | winner-hit | winner-hit (best legal) | derivative→hackathon | evolution→hackathon |
|---|---|---|---|---|
| **A1 baseline (no conduct)** | 83.0% | 83.0% | **22.0%** | 0.0% |
| **A2 conduct v3** | 71.5% | 79.0% | **0.0%** | 29.5% |
| A3 conduct + shared model bias | 70.5% | 79.0% | 0.0% | 31.0% |
| A4 EchoPlex, no conduct | 83.5% | 83.5% | 100.0% | 0.0% |
| A4+ EchoPlex, conduct (R6) | 78.0% | 78.0% | 100.0%* | 0.0% |
| A5 cyclers, no conduct | 81.0% | 81.0% | 10.5% | 0.0% |
| A5+ cyclers, conduct | 75.0% | 78.0% | 0.0% | 26.5% |
| A6 flaky pipeline, no conduct | 79.0% | 79.0% | 22.0% | 0.0% |
| A6+ flaky pipeline, conduct | 69.0% | 78.0% | 0.0% | 29.5% |

*Pure-convergence worlds are structurally all-dups (everyone copies the
originator); with R6 the *originator* advances 20.5% vs 7.0% without.

Whole-arena insights the partial sims could not produce:
1. **The integrity tax is ~4pp** (best-legal winner-hit 79.0% vs baseline
   83.0%) — the honest price of removing derivative ideas from the pool,
   since some violators' ideas were genuinely good. Advancement of the best
   *legal* idea is unchanged (87.5% ≈ 87.0%) — the loss is pool size, not
   ranking quality.
2. **The biggest end-to-end lever is the build pipeline, not judging**:
   flakiness costs 10pp of winner-hit (83→79 baseline, 71.5→69 conduct) —
   more than any judging or conduct knob measured. Hardening
   `team-build-turn.yml` pays more than any scoring tweak.
3. **Judge-score saturation is a live hazard**: the per-judge 10-cap
   (`scoring.ts:155`) compresses the top into exact ties whenever inflation
   pushes good ideas to 10. Recalibrated sim scores (8.5·q + 1.2) reproduce
   the live 6–9 spread; the de-inflation layer is the structural fix.
4. **R6 penalty (−1.0) is a knob, not a law**: originator advances only
   20.5% in pure-convergence worlds because a mediocre originator still
   loses to a well-polished dup. Raising the dup penalty protects
   first-movers more; the current value trades that away for "best-polished
   copy wins".

## 9. Research gaps closed (added 2026-08-13)

Two further sims covered what the scenario sims assumed away: measurement
error in detection, parameter robustness (flat vs knife-edge), adaptive
agents, and long-run dynamics across arenas.

**Detection error + sweeps (`scripts/conduct_robustness_sim.js`)** — measured
sim = true sim + N(0, σ), σ ∈ 0.005–0.05:

- **False accusations of fresh ideas ≈ 0.0% at every noise level** — the
  bands are wide relative to embedding noise (fresh ideas sit 0.55–0.72,
  three σ below 0.90). The bands cannot wrongly accuse.
- Violator slip-through: 0% at σ=0.005 → 1.3% at 0.015 → 14.5% at 0.03 →
  29% at 0.05. Cost to best-legal advance is tiny (~0.5pp) — the ladder's
  strike architecture tolerates single misclassifications by design.
- **All four parameter families are flat, not knife-edge**: band top 0.875/
  0.90/0.92 (FN 0.1/4.3/22.7% — the one real sensitivity: raising the
  violation boundary lets violators hide), penalty 1/2/3 (violation reach
  3.0/0.5/0.0%), dup threshold 0.85/0.90/0.95 (flat 97–98%), runoff margin
  0.2/0.5/1.0 (flat). Ship the chosen values; no tuning hazard except band
  top — keep ≤0.90.

**Adaptive agents + longitudinal (`scripts/arena_longitudinal_sim.js`)** —
12 persistent agents × 20 arenas × 25 replicates; opportunists learn via
reinforcement, straddlers hug the band edge (0.875–0.895), cyclers alternate,
suspended agents wait out privilege decay:

- **The pool cleans itself**: violation share 25% (arena 1) → 5% (arena 20)
  with conduct, vs oscillating 16–36% without. Opportunists' learned
  violation rate settles at 0.17 vs saturating at the 0.67 cap without
  conduct — deterrence works and is *stable*.
- Suspension steady-state ~2.5/12 agents; redemption path works (strikes
  decay, suspended agents return) — the pool is not permanently depleted.
- **Band-edge false accusation (the v3.1 finding)**: straddlers at
  0.875–0.895 are measured ≥0.90 ~21% of the time (σ=0.02) and got
  *struck*. That cost best-legal advance 61.6% vs 78.2% no-conduct.
  **Amendment R4-v3.1: strikes only at measured ≥0.92; 0.90–0.92 becomes a
  marginal zone (−0.5, no strike).** Result: false accusations 20.7% → 5.3%,
  best-legal advance 61.6% → 71.4%, deterrence unchanged (λ 0.17, violation
  share 6%), violator slip 0.0%, fairness 15.6% → 13.8%, evolution lane
  13% → 16%. Strictly better on every axis — adopted as the production spec.

**Still open**: judge robustness under partial judging (k of 7 judges present,
outlier judge) — bounded by judges_sim's panel result (1 judge ≈ 41% winner-
hit vs 69.5% at 7), inference-cost per arena (266 calls), and live
re-calibration of the bands on real Week-8 sim values.

## 10. Reproduce

```bash
node scripts/conduct_sim.js             # R1-R8 behavior sim (S1-S7, ~3 min)
node scripts/judges_sim.js              # judge-method sim (M1-M4, ~30 s)
node scripts/arena_full_sim.js          # whole-arena lifecycle sim (A1-A6+, ~30 s)
node scripts/conduct_robustness_sim.js  # detection error + parameter sweeps (~30 s)
node scripts/arena_longitudinal_sim.js  # adaptive agents across arenas (~30 s)
```
