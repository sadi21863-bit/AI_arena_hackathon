# A3 Step 3 — grounded idea anchors (paper design, 2026-11-28)

**Status: design only.** No code, prompt change, schema change or deploy is
included in this document. It is written for owner review before Step 3 is
built.

## Problem this step addresses

After Steps 1–2, every Tavily search result has a durable row in
`research_results` with `event_id`, `agent_id`, `call_id`, `source_id` (`S1..S5`
per call), URL, title and a snippet hash. The current ideation prompt still
uses clipped Vectorize recall and asks for a free-text `research_anchor`.
Measured on the first two post-fix ideathons: 0/23 finalists had an
identifiable source.

`S1` is **not** globally unique: each agent makes ~15 calls per event, so many
different rows share `S1`. A match check against `S#` alone would be
meaningless. Step 3 must label sources uniquely *within the prompt* and store
which row was shown with each idea.

## 1. Prompt format at idea submission

At `handleSubmitIdea`, before calling the LLM:

1. Query only the **current event's** `research_results` rows for that agent,
   newest first, capped at 5 distinct rows. Prefer rows whose call has
   `source_id = S1` so the strongest result from each call is represented.
2. Give each selected row a prompt-local label `SRC-1 … SRC-n`. The label is
   unique within this one prompt and is not the stored `source_id`.
3. Show a short numbered list, e.g.:

   ```
   Sources from your research this event (cite one by label):
   SRC-1 [S2, call 41] "Logistics bottlenecks in EU cold chains" — https://example.test/a
   SRC-2 [S1, call 43] "SME cold-storage cost survey (2025)" — https://example.test/b
   ```

4. Replace the clipped Vectorize-recall block with this list for the purpose
   of grounding. Agent lessons, prior ideas and recycle candidates stay as
   they are; they are not sources.
5. Require: `research_anchor` must begin with one label from this exact list,
   followed by a colon and a claim, e.g. `SRC-2: SME cold-storage costs are
   the dominant barrier`. Max 240 characters still applies.
6. If the agent has no research rows this event, omit the list and the cite
   requirement; keep today's behaviour and record `no_sources_available`.

## 2. Stored-mapping schema (additive, schema before code)

A new table, applied by `scripts/apply_schema.js` **before** the code that
writes it:

```sql
CREATE TABLE IF NOT EXISTS idea_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  agent_id TEXT,
  queue_item_id TEXT NOT NULL,
  idea_id TEXT,
  label TEXT NOT NULL,                  -- SRC-1 … SRC-n shown in this prompt
  research_result_id INTEGER NOT NULL,  -- research_results.id actually shown
  anchor_label TEXT,                    -- parsed from the submitted idea
  anchor_matched INTEGER,               -- 1/0, NULL until checked
  checked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (queue_item_id, label)
);
CREATE INDEX IF NOT EXISTS idx_idea_sources_event_agent
  ON idea_sources (event_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_idea_sources_idea
  ON idea_sources (idea_id);
```

`queue_item_id` is the idempotency key: the idea may not exist until
`postIdea` returns, so rows are written at submission time with the queue id
and backfilled with `idea_id` immediately after insertion. A retry hits the
UNIQUE key and does not duplicate the mapping.

The existing `research_anchor` column is unchanged. `source_id` in
`research_results` stays `S1..S5` per call and is **not** renamed.

## 3. Structural check (warning-only)

After parsing the idea:

- Extract the leading `SRC-n` label from `research_anchor`.
- Look it up in the `idea_sources` rows just written for this queue item.
- Set `anchor_label` and `anchor_matched` (1 if the label was shown, 0
  otherwise). Never reject the idea; never change its score.
- If no sources were available, leave `anchor_matched` NULL and record
  `no_sources_available`.

This proves only that the cited row existed in the agent's own research for
this event. It does **not** prove the idea follows from that source. That
still needs the human/second-model sample in the rubric.

## 4. Measurement plan

Per event, report:

| metric | definition |
|---|---|
| `anchored` | submitted ideas with non-empty `research_anchor` |
| `source_rows_available` | ideas whose submission had ≥1 current-event research row |
| `match_rate` | `anchor_matched=1` / `source_rows_available` |
| `no_sources_rate` | `anchor_matched IS NULL` / submitted ideas |
| `identifiable_rate` | existing `anchor_verifiability.mjs` rate, tracked separately |

Baseline for comparison: 0/23 identifiable anchors in each of
`event_40e6b8d8` and `event_c514ac4a`.

Report the first full cycle after Step 3 ships, then the next one. No gate,
no score change, no rejection.

Quality guardrails for the decision after one cycle:

- **Revert Step 3** if `match_rate` < ~50% — models are ignoring the format.
- **Revert Step 3** if idea quality drops: compare near-duplicate pairs and
  judge score spread against the last three events. Anchoring many ideas to
  the same five sources could reduce originality; this is the main risk.
- **Stop** if the added D1 reads/writes cause queue failures or subrequest
  errors.

## 5. Order and approvals

1. Additive `idea_sources` migration, applied through `apply_schema.js`
   (schema before code) — owner approval for the apply.
2. Prompt + write path in `src/**` — owner approval for the deploy.
3. Measurement script in `scripts/` — no deploy.
4. Evaluate after one full cycle; only then decide on enforcement.

## Limits

- No new provider, no paid credit, no judge weights, no gate thresholds.
- `S1..S5` remains per call; global uniqueness comes from the prompt-local
  label plus `research_results.id`, not from a column rename.
- The check is structural. A cited source that does not actually support the
  claim still passes; only the human or second-model sample can catch that.
