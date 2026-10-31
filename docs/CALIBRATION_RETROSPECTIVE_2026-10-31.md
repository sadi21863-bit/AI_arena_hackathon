# Calibration retrospective — 2026-10-31

Purpose: test whether the pre-event 3-anchor calibration gate predicts judge
agreement on the **actual judged population**. The gate is a fast sanity check
on three deliberately far-apart anchors; the review's concern was that Pearson
on n=3 cannot certify ranking stability.

Tool: `scripts/calibration_retrospective.mjs` (same judge-level Pearson metric,
each judge's per-target score against the leave-one-out panel mean, with the
pre-event result alongside). Run `node scripts/calibration_retrospective.mjs
--all` to regenerate this table.

## Results — 10 judged ideathons

| event | start | judged targets | pre-event r | gate | retrospective mean r | pairwise mean r | band |
|---|---|---:|---:|---|---:|---:|---|
| `event_dc3df601` | 2026-10-22 | 7 | 0.933 | pass | **0.427** | 0.250 | below |
| `event_485dd577` | 2026-10-11 | 8 | 0.955 | FAIL (high) | **0.086** | 0.018 | below |
| `event_284f548c` | 2026-10-02 | 12 | 0.937 | pass | 0.717 | 0.572 | inside |
| `event_d9d7a33f` | 2026-09-23 | 18 | 0.959 | FAIL (high) | **0.578** | 0.414 | below |
| `event_520bc073` | 2026-09-12 | 6 | 0.751 | pass | **0.435** | 0.259 | below |
| `event_75ab27ea` | 2026-08-31 | 31 | 0.902 | pass | **0.554** | 0.388 | below |
| `event_c35a0401` | 2026-08-06 | 36 | 0.994 | pass | 0.918 | 0.864 | inside |
| `event_bba98005` | 2026-07-22 | 6 | 0.534 | FAIL (low) | **0.469** | 0.267 | below |
| `event_e5415c58` | 2026-07-21 | 6 | 0.483 | FAIL (low) | **-0.180** | -0.081 | below |
| `event_2eaf0bb2` | 2026-07-15 | 6 | 0.573 | FAIL (low) | **0.053** | -0.020 | below |

## What this says

1. **The gate is useful as a warning, not a certificate.** Every low-side
   failure (0.534, 0.483, 0.573) was corroborated by poor real-population
   agreement (0.469, -0.180, 0.053). Both high-side failures (0.955, 0.959)
   were also corroborated (0.086, 0.578): the overfit warning is real.
2. **A pass does not mean stable rankings.** Of the five passing gates, only
   two landed inside the 0.6–0.95 band on real ideas (0.937→0.717,
   0.994→0.918). Three passed the anchors and then fell below it
   (0.933→0.427, 0.751→0.435, 0.902→0.554).
3. **Sample size dominates the retrospective.** The four 6-target events
   range from -0.180 to 0.469; the 36-target event is 0.918. The retrospective
   is directional, not precise, when the judged population is small. The
   review's 15–20 suggestion is directionally right, but the 31-target event
   still measured 0.554, so population size alone is not the whole story.
4. **No judge is consistently broken.** The low correlations move between
   events: on `event_dc3df601`, Nora (-0.144), Mason (0.161) and Sage (0.197)
   are low while Piper (0.904) is high; on `event_485dd577`, Piper (-0.525)
   and Quinn (0.013) are low while Owen (0.388) leads. Do not reweight a judge
   from one event.

## Caveats

- Each judge scores one specialty criterion (Technical Feasibility, Market
  Viability, Novelty, Ethics & Impact, Narrative Clarity, Code Quality, UX &
  Accessibility). Cross-criterion correlation can be low because the criteria
  genuinely rank ideas differently, not only because judges are noisy. This is
  the same cross-criterion metric the pre-event gate uses, so the comparison
  is consistent, but it is not an inter-rater reliability study.
- The judged set is not a random sample; it is the top of the ideathon. Range
  restriction lowers Pearson correlation.
- The three anchors are deliberately far apart (strong / medium / weak), which
  inflates their correlation relative to real ideas.
- Pearson assumes a linear relationship; a monotonic rank measure (Spearman)
  would be a useful companion before changing weights.

## From retrospective to public label

The retrospective is no longer only a script. `src/judges/confidence.ts` and
`src/judges/quality.ts` compute the same leave-one-out metric in the Worker
and expose a `quality` object on `GET /events`, `/events/summary` and
`/events/:id`:

- fewer than 10 judged targets → **low** (the 6-target range above is the
  evidence);
- ≥20 targets with post-event agreement inside 0.60–0.95 → **high**;
- gate passed but the population is small or agreement is unmeasured →
  **medium**;
- failed gate or agreement outside the band → **low**.

A hackathon inherits its parent ideathon's gate and is **low** at the usual
two-team final. The Archive and Live views show the label and the reason; a
low-confidence ranking is marked provisional. This does not gate judging,
change scores, or change weights — it makes the limit visible in the product.

## Recommendation

- Keep the 3-anchor gate for speed. Treat its **failures** as real warnings
  and its **pass** as permission to proceed, not as evidence of ranking
  quality.
- Run the retrospective after each event. The Worker now computes it live and
  labels the event; persisting the computed values per event remains backlog
  R-2.
- For small events, consider expanding the judged set or a sampled re-score.
  For all events, track per-judge correlation across several events before
  changing weights or removing a judge.
- Do not change the gate thresholds or judge weights from this single pass.
  This is a diagnostic baseline, not a verdict.
