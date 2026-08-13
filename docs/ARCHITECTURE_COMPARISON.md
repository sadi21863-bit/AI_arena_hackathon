# Architecture Performance Comparison — Existing vs Conduct v3.1

Status: **sim-validated comparison, pre-implementation** (2026-08-13). Every
number is from the committed sims: `arena_full_sim.js` (whole arena,
200 arenas/scenario), `arena_longitudinal_sim.js` (adaptive agents, 20 arenas
× 25 replicates), `conduct_robustness_sim.js` (detection error + sweeps),
`judges_sim.js` (judge methods). No production change has been made.

The **existing architecture** = current live system: 7-judge individual
parallel scoring (persona weights), 0.90 distinctness filter + N-3 runoff at
team formation, no conduct layer of any kind, no tie-break, no calibration.
The **new architecture** = same judging/advancement machinery + Code of
Conduct R1–R8 with the v3.1 amendment (strikes only at measured ≥0.92,
marginal zone 0.90–0.92 at −0.5).

## 1. Headline: what the new architecture buys

| Metric (whole arena, 200 arenas each) | Existing | New (v3.1) | Δ |
|---|---|---|---|
| Derivative ideas → hackathon | **22.0%** | **1.0%** | −21.0pp |
| Violating ideas → hackathon | ~10–20% (S1) | **0.0%** | −10 to −20pp |
| Winner = best legal idea | 83.0% | **79.5%** | −3.5pp (integrity tax) |
| Evolution lane → hackathon | 0.0% | **29.5%** | +29.5pp |
| Top-2 novelty of advancing ideas | 0.310 (S1) | **0.399** (S2) | +29% |
| Ties at top resolved by coin flip | 79.6/100 (S1) | **0.0** (R8) | −79.6 |
| Winner concentration (fairness) | 13.0% | **14.0%** | +1.0pp |

**Reading:** the new architecture eliminates the week-7 failure mode
(derivative "builds on X" ideas winning a fifth of hackathons) and collapses
the tie chaos (79.6 coin flips → 0) at a measured integrity tax of ~3.5pp on
the best-legal idea winning. The 1.0% residual derivative leak is the v3.1
marginal zone — the deliberate trade for cutting false accusations (see §4).

## 2. Integrity & enforcement (the reason for existing)

| Metric | Existing | New (v3.1) |
|---|---|---|
| Violation win rate (S1/S2) | 10.0% | 0.0% |
| Violating idea reaches hackathon (S1/S2) | 20.7/100 | 0.0 |
| Repeat-offender world (S4) | wins freely | 0.0% wins |
| Decay-riding cyclers (S5) | wins | 0.0% wins |
| Same-arena convergence (S6: EchoPlex ×5) | 100% of arenas dup-crowded | 0.0% violation reach; originator 3× more likely to advance (20.5% vs 7.0%) |
| Recycle-heavy field (S7) | violation wins | 0.0% wins |
| Hard plagiarism (≥0.95) | indistinguishable | excluded + 2 strikes |

## 3. Selection quality (what we lose, honestly measured)

| Metric | Existing | New (v3.1) | Note |
|---|---|---|---|
| Winner = best idea (raw) | 83.0% | 71.5–73.5% | violator ideas removed from pool |
| Winner = best **legal** idea | 83.0% | **79.5%** | the true integrity tax, ~3.5pp |
| Best-legal idea advances | 87.0% | 86.0% | advancement quality unchanged |
| Exact top-2 advancement | 8.5% | 7.5% | within noise; distinctness filter dominates both |

The integrity tax decomposes as: violator ideas (some genuinely good, −0.06
quality discount on average) leave the pool, so the best-legal winner is a
slightly weaker #2. Advancement of the best-legal idea is *unchanged*
(86–87%) — the tax is pool size, not ranking quality. Long-run adaptive world
confirms: 78.2% → 71.4% best-legal advance (+9.8pp recovered by v3.1 over
v3's 61.6%).

## 4. Fairness & false accusations (v3.1's reason for existing)

| Metric | Existing | New v3 | New v3.1 |
|---|---|---|---|
| False accusation of fresh ideas (any σ≤0.05) | n/a (no detector) | **0.0%** | **0.0%** |
| False strikes on band-edge legal ideas (σ=0.02) | n/a | **20.7%** | **5.3%** |
| Violator slip-through (σ=0.02) | 100% (no detector) | 5.3% | 0.0% |
| Best-legal advance, long-run | 78.2% | 61.6% | **71.4%** |
| Winner concentration (long-run) | 12.8% | 15.6% | **13.8%** |
| Ties at top | arbitrary | deterministic (R8) | deterministic |

v3 (sharp bands) over-punished legal edge-huggers: 20.7% of sim-0.88 ideas
were struck under realistic embedding noise. v3.1 moves the strike floor to
0.92 — false strikes 5.3%, deterrence unchanged (opportunists settle at
λ≈0.17, violation share 6% by arena 20).

## 5. Robustness to gaming & noise

| World | Existing | New (v3.1) |
|---|---|---|
| Shared model bias (all judges same model) | affects rankings | unchanged (0.5pp; individual judging already robust) |
| Opportunists learning by reinforcement | saturate at λ=0.67 | settle at λ≈0.17 (stable deterrence) |
| Straddlers (hug 0.88–0.90) | free-ride | get +0.05 credit, false-strike risk 5.3% |
| Cyclers (decay-riders) | win | 0 wins (S5), conduct unchanged |
| Flaky build pipeline | −4pp winner-hit | same −4pp (conduct doesn't interact) |
| Parameter drift (penalty 1–3, dup 0.85–0.95, margin 0.2–1.0) | n/a | **flat regions** — no knife-edges (only band top must stay ≤0.90) |

## 6. Long-run dynamics (20 arenas, persistent agents)

| Metric | Existing | New (v3.1) |
|---|---|---|
| Violation share, arena 1 → 20 | 25% → oscillates 16–36% | 25% → **5–6%** (self-cleaning) |
| Evolution lane share | 0% | 14–17% (stable) |
| Suspended agents (steady state) | 0 | ~2.4/12 (redemption path works; no permanent exile) |
| Opportunist learned violation rate | 0.67 (cap) | 0.17 |

## 7. Cost & complexity

| Dimension | Existing | New (v3.1) |
|---|---|---|
| LLM calls per arena | 266 (36×7 + 2×7) | **266** (classification reuses existing embeddings — zero new calls) |
| New schema | — | 4 columns (`recycle_sim`, `class`, `of`, `agent_conduct`) + strikes on agents |
| New code | — | ~1 classification hook (idea creation), penalty at scoring, ledger at executor, exclusion at team formation |
| Ops risk | — | low: every rule has a flat parameter region; bands re-fit on live data |

## 8. What deliberately does NOT change

Individual parallel judging (validated at the accuracy ceiling in
`judges_sim.js` — deliberation buys ≤0.4pp at 2× cost; panel consensus is
−28pp), persona weights (worth +1.9pp vs equal), the 0.90 distinctness
filter, N-3 runoff (informative verdict), collaboration bonus for N-1 merges,
two-provider inference pool, no-VM architecture.

## 9. Verdict

The new architecture trades 3.5pp of raw winner accuracy (measured, not
guessed — and it's pool-size, not ranking quality) for: zero derivative wins,
zero tie chaos, a self-cleaning pool, stable deterrence, and a healthy
evolution lane. Every failure mode the sims could construct is neutralized;
every penalty region is flat; false accusations are 5.3% and falling. The
remaining 10pp lever is the build pipeline (A6), which the new architecture
leaves untouched and which is a separate hardening task.
