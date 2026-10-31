# Semantic sample review — 2026-10-31

Raw sample: [`SEMANTIC_SAMPLE_2026-10-31.md`](SEMANTIC_SAMPLE_2026-10-31.md)
(event `event_dc3df601`, 10 ideas: 7 judged + 3 blocked).

Reviewer: one AI agent, one pass, no inter-rater calibration. This is a
tripwire for plausible-but-bad output, **not** a score and not a gate. No D1
score was changed.

## Systemic finding first

**Every idea in this sample has an empty `research_anchor` — and so does every
idea in every archived event** (0/34 here, 0 across all events). The Deep
Research phase produced material, but ideation never stored which finding an
idea was grounded in. The prompt asked for six fields and never requested the
anchor; `postIdea` already supported it, but no caller supplied it.

That is a real product gap: a reader cannot tell whether an idea used the
research phase or was generated cold. It also means the "Research evidence"
column below is **fail for every historical idea**, not because the agents
necessarily ignored research, but because the artifact does not show it.

Fixed on 2026-10-31: `handleSubmitIdea` now requests `research_anchor` (a short
quote/source from the recalled context, max 240 chars) and passes it to
`postIdea`. The artifact audit now flags unanchored finalists as a semantic
warning. The next ideathon is the live acceptance test.

## Per-idea assessment

Legend: **pass** = specific/credible as written; **weak** = partly there but
needs a narrower claim; **fail** = not credible for a 4–5 day build or not
differentiated.

| idea | specific problem | differentiated | realistic build | research evidence | overall | strongest concern |
|---|---|---|---|---|---|---|
| Community Health Hub | pass | weak | fail | fail | weak | Offline app + FHIR/EHR integration + fine-tuned model + on-site training is far beyond a 4–5 day build. |
| LogIntegrity AI-Assisted Forensics | pass | weak | fail | fail | fail | Kubernetes + Hyperledger Fabric + GPU TensorFlow + multi-jurisdiction key policy is an enterprise platform, not an event MVP. |
| Friction-Toggle Dashboard | pass | weak | weak | fail | weak | Slack/Trello/Jira integrations and adaptive monitoring are plausible only as a manual, single-integration demo. |
| Manual-Copy Focus Assistant | weak | weak | pass | fail | weak | The core value ("copy deliberately") is asserted, not evidenced; the extension itself is buildable. |
| Localized Climate-Risk Analytics SaaS | pass | weak | fail | fail | weak | Climate data + regulation NLP + ERP connectors + spatial DB is too broad; the Kenya focus is the strongest part. |
| Community-Curated Green-Swap Marketplace | weak | fail | fail | fail | fail | Generic swapping app with on-device AI, courier API, reputation, subscriptions and carbon accounting. |
| Friction-Fit Task Scheduler | pass | weak | fail | fail | fail | A cross-OS Rust daemon, wearable bridge, OAuth integrations and scheduling engine cannot ship in the event window. |
| CulturalSync AI Subtitler | pass | weak | fail | fail | weak | Whisper + GPT-4 + MT + brand-tone fine-tune + dubbing is a 30-day product; "30 days" is written into the scope. |
| CommitMate | pass | weak | fail | fail | weak | Multi-cloud commitment ordering is real FinOps complexity; the AWS-only MVP is still beyond a 4–5 day build. |
| Local Culture Curator | fail | fail | fail | fail | fail | Identity-tagged event discovery is a generic idea; the proposed 14-day MVP is still over-scoped. |

Totals: **0 clear pass, 6 weak, 4 fail** on the overall column.

## What this changes

1. **Research grounding is now part of the ideation contract.** The next event
   should show non-empty anchors for its finalists. The audit will flag
   `UNANCHORED` if not.
2. **The judged scores are not a quality certificate.** The top-scored idea
   (Community Health Hub, 7.50) is weak on buildability; a 7.50 means "better
   than the other ideas in this event," not "shippable in the window." The
   confidence label already says the ranking is low-confidence at n=7; this
   sample explains one reason why.
3. **Build scope is the recurring failure.** Six of ten are conceptually
   coherent but would need a month or a team; that is the same over-scoping
   pattern the architecture stage is supposed to catch and the build turn then
   discovers by running out of quota.

## Reproduce

```bash
node scripts/semantic_sample.mjs --n=10 --out=docs/SEMANTIC_SAMPLE_2026-10-31.md
node scripts/artifact_audit.mjs
```

The first command writes the raw sheet; the second should now report
`unanchored finalist(s)` for historical events until the new prompt has run.
