# Agent Office — deep analysis 2026-08-06

> **STATUS 2026-08-06 — analysis complete, no code written.** Branch:
> `office-deep-analysis` (created off `395a7b2`). Combines code reading
> (`office.js`, backend endpoints, replay, store, observatory shell),
> live D1 measurements, and research (AI Town, OTel GenAI observability,
> Kaggle Kaggriculture). Companion docs: `OFFICE_ASSET_CATALOG_2026-08-06.md`
> (chimera sprites) and `KAGGRICULTURE_STUDY_2026-08-06.md`.

## 1. What the Office is today

`public/js/views/office.js` (~1300+ lines) renders 12 agent sprites in one
room with 6 zones (Research Nook, Idea Desk, Critique Corner, Architecture
Table, Tribunal Circle, Break Area). Every poll (300 s, cron-aligned via
`store.js`) it refetches `/events/:id/agent-activity` and positions each
sprite from **one representative `event_queue` row per agent**; zone
changes trigger walk animation; click opens an inspector panel; P4 merge
tables show pending/merged/refused; team build-turn holder + set name/
blurb for hackathons; `/agent-activity` missing → explicit error state
(Worker/Pages deploy skew).

Backend (all public GET, same trust tier): `/agent-activity` (~line 475),
`/teams` (594), `/roster` (611), `/chronicle` (640), `/agent-artifacts`
(663), `/build-turns` (728), `/collaborations` (752), `/judging` (815).
Admin: `/admin/events/:id/tick` (958) runs `ensurePhaseWorkQueued` +
`processQueue` only — **self-heal reconciliation runs only on the real
cron**. Auth: SHA-256 vs `admin_tokens.token_hash`.

## 2. What the live data says (measured 2026-08-06, D1 remote)

- **`archive_interactions`: 170 rows total, all `critique`** — 35/101/33
  across three ideathons + 1 test row. Research, submit, architecture,
  judging, tribunal produce **no** interaction rows. The timeline the
  Replay view scrubs is therefore thin and critiques-only; the office has
  no per-step history of anything else.
- **`event_queue` is the real activity record** (2,677+ rows scanned):
  ideathons ≈ 161-170 rows (12 research, 36 submit_idea, ~33-101 critique,
  6 architecture, 6 judge_idea + failures); hackathons dominated by
  tribunal work (12 each of cross_examine/reflect/synthesize) **plus retry
  storms**: `event_cd9644ef` alone has **676 failed tribunal_reflect** and
  228 failed tribunal_cross_examine; `event_8088ef16` 350 completed
  dispatch_build_turn (the capped-turns episode). Failed rows massively
  outnumber completed rows in hackathons.
- **Activity is bursty**: `event_bba98005`'s entire workload was created
  on a single day (2026-07-29). The office will sit still for days, then
  move in bursts — burst windows are the only times the view is alive.
- **`event_chronicle` is empty in production** despite the Chronicler
  (`src/agents/chronicle.ts` + `chronicleTransition` in scheduler.ts)
  being deployed since week 8. `/chronicle` returns `[]` for completed
  events. Either it never fired or the transitions predate it — either
  way, the narrative feature has produced zero rows live.
- **`/agent-activity` for the live event**: 12 rows, all `research
  completed`, `updated_at` 2026-08-01 (pre-revival work), `abandoned:
  false`. Confirms G6 (one representative row per agent — the critiques an
  agent did 5 of are invisible; the last one wins) and that during
  day-gated idle phases the office shows a frozen room.
- **Failed-row semantics**: `last_error` distinguishes real signals
  ("Malformed critique JSON…", "Inference exhausted for agent X"). P1
  fetches failed rows but they never position sprites — with retry-storm
  volumes, an ungrouped failure display would drown in noise.

## 3. Gaps, ranked

- **G7 — no history, snapshot only** (open since 07-31). Replay is a
  separate view over the thin `archive_interactions`; nothing journals
  state per tick. The office can only show "now". This is the deepest gap.
- **G6 — one row per agent hides parallelism** (open since 07-31). The
  office's raison d'être — seeing 12 agents work in parallel — is exactly
  what the endpoint suppresses.
- **NEW — Chronicler never produced output.** `/chronicle` empty in prod.
- **NEW — retry storms pollute failure surfacing** (676 failed rows for
  one event). Needs bucketing/capping, not raw display.
- **NEW — deploy-skew error state is permanent during events.** A Worker
  deploy wipes `/agent-activity` from the Pages perspective mid-event.
- Minor: sprites are static CSS (asset upgrade path exists — see catalog).

## 4. Research anchors

- **AI Town (a16z-infra)**: state evolves via processed *inputs*; an
  append-only journal of inputs is the source of truth, rooms are
  projections. Direct blueprint for G7.
- **OTel GenAI semconv (ratified 2026)**: `gen_ai.*` + `gen_ai.tool.*`
  attributes, `gen_ai.prompt.redact` — if the arena ever emits a journal,
  naming events along these conventions keeps it platform-portable and
  replayable anywhere. Replay + tracing is the accepted observability pair.
- **Kaggriculture (live Kaggle sim competition)**: replay-first — every
  episode stores per-step observations for both players + per-agent logs +
  a seed; HTML visualizer (`default/` replay renderer, `playable/` browser
  game) renders any episode. The strongest working example of the exact
  G7 shape the office wants. Study doc has the full spec.

## 5. Recommendations

1. **G7 — add an append-only journal** (data-model change, deferred by
   design): `event_journal(event_id, seq, tick_at, actor, action, payload)`
   written at every executor/scheduler mutation (mirrors event_queue
   writes, ~1 row per mutation — trivial volume vs today's 2.6k rows/
   event). Replay and the office become projections: `office.js` can scrub
   `tick_at` back in time; Replay stops being critiques-only. Name events
   OTel-gen_ai-style for portability. Do NOT snapshot full state per tick
   (Kaggriculture does because steps are batch-computed; the arena's
   mutations are sparse, deltas suffice).
2. **G6 — /agent-activity v2**: return the agent's last N (e.g. 5) recent
   items + counts per status/type, bounded by `event_queue.id` desc —
   exposes parallelism without unbounded payloads. Cheap: one indexed
   query, same trust tier.
3. **Chronicle**: verify `chronicleTransition` fires on the revived
   event's day-2 boundary (08-08 15:38). If empty again → bug, not timing.
4. **Failure surfacing**: bucket `failed` rows by `error_message` (malformed
   vs exhausted vs other) and cap shown count; stop painting retry storms
   as distinct failures.
5. **Assets (optional)**: swap CSS sprites for the 8 chimera characters
   (+4 sliced from the PIPOYA pack to cover all 12 agents) — catalog doc
   has the slice recipe; commit as static PNGs under `public/assets/agents/`.
6. **Deploy skew**: keep the office's error state but auto-retry with
   backoff instead of a dead-end panel.

## 6. Verification plan (ties to the live cycle)

- 08-08 15:38 — revived event day-2 boundary: ideation burst + recycle
  sweep + critique; watch: office movement, agent-activity parallelism,
  chronicle rows appearing, no watchdog re-abandonment (self-heal armed).
- 08-10 15:38 — critique day; revision round targeting at day 4.
- ~08-14 — first auto-created hackathon: full scaffold/verification gate/
  python3 roster path exercised live through the office for the first time.
- Re-run the D1 diagnostic queries from §2 at each boundary to measure
  journal/replay feasibility against real burst volumes.
