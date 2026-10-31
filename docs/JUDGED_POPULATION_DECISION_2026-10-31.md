# Judged-population decision — 2026-10-31

Status: **decided for the current free-tier regime.** Revisit only under the
triggers at the bottom.

## Question

For small events, should the Arena automatically judge a larger population
(the review's 15–20 suggestion) so the ranking is more stable?

## Evidence

The 2026-10-31 retrospective applies the same leave-one-out Pearson metric to
every judged ideathon. Population size alone does **not** predict stable
agreement:

| event | n | pre-event gate | post-event r | band |
|---|---:|---|---:|---|
| event_dc3df6 | 7 | pass 0.933 | 0.427 | below |
| event_485dd5 | 8 | fail 0.955 | 0.086 | below |
| event_284f54 | 12 | pass 0.937 | 0.717 | inside |
| event_d9d7a3 | 18 | fail 0.959 | 0.578 | below |
| event_520bc0 | 6 | pass 0.751 | 0.435 | below |
| event_75ab27 | 31 | pass 0.902 | 0.554 | below |
| event_c35a04 | 36 | pass 0.994 | 0.918 | inside |
| event_bba980 | 6 | fail 0.534 | 0.469 | below |
| event_e5415c | 6 | fail 0.483 | -0.180 | below |
| event_2eaf0b | 6 | fail 0.573 | 0.053 | below |

A 31-target event still fell below the band; a 12-target event landed inside.
The four 6-target events range from -0.180 to 0.469. There is no population
threshold in this data that guarantees a trustworthy ranking.

## Decision

**Do not automatically expand the judged population.** Keep the existing gate:

- Groq-pinned events already score every eligible idea (`scoreAllIdeas`).
- Workers-AI-pinned events keep the finalist-only pass, because scoring all
  ideas costs roughly 25–30k neurons against a measured 9.5k/day cap — it
  cannot finish inside the event's judging window.
- A small judged population is labelled **low confidence** in the public
  `quality` object and in the Archive/Live views. That is the product response
  to instability, not a bigger, more expensive sample.
- If an operator manually expands or re-scores a specific event, record the
  reason and expect the extra judge traffic; it is not a default path.

This is a deliberate acceptance of a weaker ranking on some events in exchange
for finishing the cycle inside a free-tier budget. The confidence label makes
that weakness visible instead of hiding it behind a precise-looking score.

## Revisit triggers

1. Two consecutive events with `n >= 20` fall below the 0.60 band.
2. A low-confidence event's ranking is contested by a concrete alternative
   (for example, a manual re-score changes the top two).
3. The provider budget changes (second independent account approved, paid tier,
   or a cheaper judging model) enough to make a full pass fit.
4. The gate itself is replaced by a better pre-event predictor.

Until then, the correct next step is not a bigger gate — it is keeping the
gate a warning, persisting the retrospective, and flagging low-confidence
events in public. Those are implemented in `src/judges/confidence.ts`,
`event_quality_snapshots`, and the Observatory.
