# Semantic calibration — 2026-11-01

Follow-up to the first semantic sample
([`SEMANTIC_SAMPLE_REVIEW_2026-10-31.md`](SEMANTIC_SAMPLE_REVIEW_2026-10-31.md)).
The external review's fair criticism was: **one AI reviewer, one pass, no
inter-rater calibration.** This document tests that criticism instead of
restating it.

The per-idea verdicts in the original review are unchanged. This is a
reliability check on them, not a rewrite.

## Method

Same deterministic sample: 10 ideas from `event_dc3df601` (7 judged finalists,
3 blocked), selected judged-first by score. No D1 score was written.

| pass | reviewer | rubric | output |
|---|---|---|---|
| A | first agent review, 2026-10-31 | original | 0 pass / 6 weak / 4 fail |
| B | `nvidia/nemotron-3-ultra-550b-a55b:free`, independent | original | 0 pass / 1 weak / 9 fail |
| B2 | same model, same sample | sharpened weak/fail boundary | 0 pass / 0 weak / **10 fail** |

Reviewer B saw only the ideas and the rubric, not A's verdicts. The tooling is
`scripts/semantic_review_llm.mjs` and the comparison is
`scripts/semantic_agreement.mjs`; neither is in the event loop.

## Result — A vs B (original rubric)

Report: [`SEMANTIC_INTERRATER_2026-10-31.md`](SEMANTIC_INTERRATER_2026-10-31.md).

| criterion | exact | within one | Cohen's κ | band |
|---|---|---|---|---|
| Specific problem | 7/10 | 10/10 | 0.143 | slight |
| Differentiated solution | 0/10 | 8/10 | 0.000 | slight |
| Realistic build scope | 9/10 | 10/10 | 0.630 | substantial |
| Research evidence | 10/10 | 10/10 | — | undefined (both constant: fail) |
| **Overall** | **5/10** | **10/10** | **0.138** | **slight** |

Quadratic weighted κ for the overall verdict is also 0.138. Ten items is too
few for a stable kappa, but the shape is clear:

- **Both reviewers rank the ideas the same way.** Every disagreement is
  adjacent (`weak` vs `fail`), never `pass` vs `fail`; within-one agreement is
  100%.
- **The disagreement is the threshold, not the ordering.** A treated
  over-scoped-but-narrowable ideas as `weak`; B treated any idea that needs a
  cut as `fail`.
- **Build scope is the one criterion with substantial agreement** (κ=0.630) —
  and it is also the recurring failure. That is the signal worth keeping.
- **Research evidence was unanimous: 10/10 fail**, because every historical
  idea has an empty anchor. It is a systemic process gap, not a per-idea
  differentiator.

## Result — B vs B2 (sharpened rubric)

The obvious fix was to make the boundary explicit:

- `weak` = the core survives a cut to one repository and one mocked integration;
  only the ambition shrinks.
- `fail` = the core depends on excluded tech or multiple integrations, so a cut
  would change the idea.

B2 then failed **all ten**. The reason is visible in its notes: once the rubric
says a missing research anchor is a fail, the universal anchor gap forces every
overall verdict to fail, regardless of the idea. A rubric that returns one
category for every item has no discriminative value.

## Decision

1. **Stop treating the overall verdict as the semantic sample's headline.** It
   is not robust to rubric wording and it lets one universal criterion dominate
   the rest. Report per-criterion verdicts and the narrative notes.
2. **Treat research evidence as a process metric, not an idea score.** The
   historical 0/34 is a finding about the ideation contract, already fixed for
   the next event. It should not be averaged into an overall quality label.
3. **Use build scope as the discriminating criterion.** It has the best
   agreement and it matches the observed failure mode (over-scoping).
4. **Keep the sample warning-only and manual.** Low kappa is exactly why it
   must not become a gate, a score, or an automatic ranking input. Nothing was
   written to D1.
5. **Run two reviewers and an agreement check on the next sample.** The next
   ideathon is the live test that anchors populate; the sample after that
   judging pass is the first one where research evidence can discriminate.

## Caveat

Two AI reviewers are not a human panel. A low kappa on ten items is evidence of
ambiguity, not a precise reliability coefficient. If the sample is ever used for
more than triage, the next step is a third, human reviewer on the same sheet.
The tooling now makes that comparison cheap:

```bash
node scripts/semantic_sample.mjs --n=10 --json > sample.json
node scripts/semantic_review_llm.mjs --input=sample.json --out=review-b.json
node scripts/semantic_agreement.mjs --a=review-a.json --b=review-b.json --sample=sample.json
npm run test:ops   # pins the kappa math and the posture thresholds
```
