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
   joined to `research_calls` on `call_id`. Selection is relevance-based, not
   recency:
   - take the best result from each call (`source_id = S1`);
   - drop duplicate URLs (Tavily repeats results across calls);
   - rank remaining calls by **simple keyword overlap** between the call's
     `research_calls.query` and the agent's lens/name tokens (lowercased,
     stopword-free, count shared words); no embedding call and no LLM call —
     Workers AI quota and the 50-subrequest cap have both bitten before;
   - show up to **8** sources, with ties broken by `call_id` ascending.
   An idea about an earlier research topic must still be able to cite its own
   source, so "newest 5" is explicitly rejected.
2. Give each selected row a prompt-local label `SRC-1 … SRC-n`. The label is
   unique within this one prompt and is **not** the stored `source_id` or the
   row id.
3. Show a short numbered list, e.g.:

   ```
   Sources from your research this event (cite one by label):
   SRC-1 [call 41, S2] "Logistics bottlenecks in EU cold chains" — https://example.test/a
   SRC-2 [call 43, S1] "SME cold-storage cost survey (2025)" — https://example.test/b
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
  source_url TEXT,                      -- copied from that row for public display
  source_title TEXT,                    -- copied from that row for public display
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
and backfilled with `idea_id` immediately after insertion. **A retry reuses
the stored mapping** — it must not re-query sources, because a new query could
return different rows from those the model actually saw. The UNIQUE key makes
that reuse automatic.

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
| `match_rate` | `anchor_matched=1` / `source_rows_available` — **formatting compliance only** |
| `no_sources_rate` | `anchor_matched IS NULL` / submitted ideas |
| `identifiable_rate` | existing `anchor_verifiability.mjs` rate, tracked separately |
| `citation_concentration` | citations per `research_results.id`, plus the share of an agent's ideas that reuse one source |
| `support_rate` | human/second-model sample: of ~10 anchors per event, how many have a claim that follows from the cited source |

There is **no support baseline**: the old anchors carry no source, so whether
their claims follow from a source cannot be assessed. The decision bar must be
fixed **before the cycle runs**, not chosen after seeing results:

- sample 10 anchors per event with a human or second-model reviewer;
- **pass bar**: at least **7 of 10** claims are supported by the cited source,
  and **no more than 1** is fabricated (a source that does not say what the
  anchor claims);
- report the two numbers separately; do not average them into a score.

`identifiable_rate` from 0/23 in the two earlier events is a coverage baseline
only, not a support baseline.

`match_rate` will be close to 100% once the prompt requires a label; it proves
the format is followed, **not** that grounding improved. The required input
for the Step 4 decision is `support_rate` from the human or second-model
sample, not `match_rate`. Also report `citation_concentration`: if every idea
from an agent cites the same source, originality is at risk even with a high
match rate.

Report the first full cycle after Step 3 ships, then the next one. No gate,
no score change, no rejection.

Quality guardrails for the decision after one cycle:

- **Revert Step 3** if `match_rate` < ~50% — models are ignoring the format.
- **Revert Step 3** if the sampled support bar is missed (fewer than 7/10
  supported, or more than 1 fabricated), or if idea quality drops: compare
  near-duplicate pairs and judge score spread against the last three events.
  Anchoring many ideas to the same source is the main risk.
- **Stop** if the added D1 reads/writes cause queue failures or subrequest
  errors.

## 5. Public visibility (the product win)

A raw `SRC-2:` label means nothing to a reader. Resolve it through
`idea_sources` to the copied `source_title` and `source_url`, and return those
with the idea (e.g. in `/ideas` and the Archive) so the Observatory can show
a real, clickable citation. The mapping row is the single source of truth for
what was shown; do not re-derive the URL from `research_results` at read time.

If no mapping exists (ideas from before Step 3), the UI shows the legacy
`research_anchor` text exactly as it does today.

## 6. Order and approvals

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
