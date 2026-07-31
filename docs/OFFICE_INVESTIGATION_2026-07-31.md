# Agent Office — gap investigation & improvement proposals

Investigation only. Nothing here is built; the point is to decide what's worth
building. Current implementation: `public/js/views/office.js` (330 lines),
`public/css/views/office.css` (181), fed by `GET /events/:id/agent-activity`.

---

## 1. What it does today

Twelve agents as pixel characters in one room. Six zones (Research Nook, Idea
Desk, Critique Corner, Architecture Table, Tribunal Circle, Break Area). Each
agent's position is derived from one representative `event_queue` row; they
walk when the zone changes, show a static emoji, and can be clicked for an
inspector panel. Redraws off the shared store tick.

The choreography is genuinely good — the walk-cycle timing, z-ordering by
depth, the wall clamp computed from real element dimensions rather than a
percentage, and the "don't replay a walk on a zero delta" fix are all correct
and hand-tuned. **None of the proposals below touch that.**

Two things I assumed were gaps and verified are not:
- **Reduced motion is handled** (`office.css:177` kills both the transition and
  the working animation; `arena.css:125` covers the shell).
- **Accessibility basics exist** — `tabindex`, `role="button"`, `aria-label`,
  Enter/Space activation.

---

## 2. Prior art (what the field does that we don't)

| Project | Ideas worth taking |
|---|---|
| [Stanford Generative Agents / Smallville](https://ar5iv.labs.arxiv.org/html/2304.03442) | Hierarchical world tree (world → area → object); observer can watch *and intervene* |
| [a16z AI Town](https://github.com/a16z-infra/ai-town) | A **journal of every event** as the backing store — makes replay/scrubbing fall out for free rather than being a separate view |
| [rafapetter/agent-town](https://github.com/rafapetter/agent-town) | **Six statuses** (typing / reading / thinking / waiting / success / error), **speech bubbles showing current work**, tasks as pixel objects, flying task animations between stages, colour-coded activity log, SSE/WebSocket transport |
| [pixel-agents](https://github.com/pablodelucca/pixel-agents) | Character **visibly flags when stuck waiting for input** — the "I need you" signal |
| [pixtuoid](https://www.pixtuoid.dev/) | Agent tree badged by tool and **colour-tinted by activity**; pets that roam and sleep near idle agents (pure charm, cheap) |
| [geezerrrr/agent-town](https://github.com/geezerrrr/agent-town) | Explicit task lifecycle `queued → sending → running → done/failed` rendered in-world; **idle workers roam** to whiteboards/printers/sofas instead of standing still |
| Agent observability practice ([Braintrust](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026), Datadog, Langfuse) | Traces, **handoffs**, retries, latency, and **cost per run** are the four things practitioners actually want; Datadog ships an execution-flow chart of inter-agent interaction |

The consistent theme: **everyone else shows failure and content; we show
neither.**

---

## 3. Verified gaps

### G1 — Failure is invisible (correctness, not cosmetics)
`failed` appears nowhere in `office.js`. The `RANK` table has no entry for it,
so a failed row scores 0 and is skipped, and the API now filters it in SQL too.
The original reasoning is sound and documented — a failed row would strand a
character at a dead task forever.

But "idle" now conflates three genuinely different states:
- never had work this phase (normal)
- finished its work (good)
- **failed repeatedly and was abandoned by `MAX_ITEM_ATTEMPTS`** (bad)

The stall watchdog shipped this week makes the third state real and permanent.
An agent the system has *given up on* renders identically to one relaxing on
the couch. This is the same looks-fine-isn't shape the backlog was written
about, in the one view whose entire job is showing what's happening.

### G2 — The room is empty for roughly half of every cycle
During the hackathon (3 of ~9 active days, plus judging/Tribunal) build work is
team-level GitHub Actions turns, not per-agent queue rows, so all twelve idle
at the break area. The code says so in a banner.

This was unavoidable when written. It isn't now: `hackathon_team_members` gives
roster, `membership` (lead/builder), `build_role`, and `turns_taken`;
`build_turns` gives per-turn status, conclusion and `head_sha`. Enough to show
two team areas, who currently holds the turn, and whether CI is green.

### G3 — No content, only a static emoji
The emote is one glyph per task type. The system *has* the actual material —
idea titles, critique text, judge rationales, and now the Chronicler's
per-phase narration. Every comparable project renders a speech bubble; we
render 💡.

### G4 — Collaboration is invisible
N-1 added a real `collaboration` phase, but `propose_collaboration` is an
event-level task with no `agent_id`, so no character moves and no zone exists.
The one phase that is explicitly *about* agents interacting is the one the
room cannot show. Kai's persona is Team Facilitator.

### G5 — The judges don't exist in the room
Seven judges score every idea and team, with per-criterion weights and now
recorded `provider`/`model_id`. They are a separate roster with no `agent_id`,
so the room shows nothing during judging — arguably the most consequential
phase, since it decides what advances.

### G6 — One task per agent hides real parallelism
`agent-activity` returns a single representative row per agent. An agent with
three queued critiques looks identical to one with a single task.

### G7 — Snapshot only; no sense of time
No trail, no history, no "what changed since I looked away". Replay exists as a
separate view over `archive_interactions`, disconnected from the room.

### G8 — Polling, not streaming
Redraws on the shared store tick. Fine, but movement lands in bursts rather
than as things happen.

### G9 — Cosmetic: 8 sprites for 12 agents
Four are hue-rotated twins of others, so a third of the cast are recolours —
noticeable when twins share a zone.

---

## 4. Proposals, ranked by value ÷ cost

### P1 — Make failure and abandonment visible *(small, correctness)*
Add `error` and `abandoned` states. Keep the current rule that a failed row
never *positions* a character — instead badge them in place: a red marker at
the break area, and a distinct treatment once `abandoned_at`/attempt-cap is
hit. Surface the error text in the inspector.
*Data: already in `event_queue.status` + `error_message`; needs the API to stop
filtering failures and return them as a separate field rather than as the
representative row.*

### P2 — A hackathon room, so the office isn't dead half the time *(medium, highest visible payoff)*
Replace the "everyone idles" banner with two team areas. Show each roster, the
member whose turn it is (`nextBuildAuthor` logic already exists), their
`build_role`, `turns_taken`, and the current turn's CI state from `build_turns`
(dispatched → running → success/failure). This converts the emptiest half of
the cycle into the most interesting.
*Data: `hackathon_team_members` + `build_turns`, both live in production.*

### P3 — Speech bubbles with real content *(small–medium, biggest legibility win)*
On hover/selection, show what the agent is actually producing: idea title while
at the Idea Desk, the critique's `weakness` at Critique Corner, the phase
Chronicle line during transitions. Turns the room from "who is where" into
"what is being made".
*Data: `archive_ideas`, `archive_interactions`, `event_chronicle` — all exist;
needs one endpoint returning the latest artefact per agent.*

### P4 — Collaboration zone *(small)*
A Merge Table zone. When a `propose_collaboration` pair is queued, walk both
authors there; on accept, show the merge; on refuse, walk them back. Gives Kai
something to facilitate and makes N-1 legible.
*Data: exists; the queue row would need to carry the two `agent_id`s or the
client would resolve them from the payload's idea ids.*

### P5 — Judges' bench *(medium)*
Seven judge figures visible during judging, lighting up as scores land, with
the pinned model shown. Makes the phase that decides outcomes observable, and
would have made P0-2's silent mid-event model swap visible on sight.

### P6 — Idle behaviour and charm *(small, do last)*
Idle agents roam between couch/cooler/plants instead of standing in a grid
(geezerrrr's pattern), plus optionally an office pet that naps near whoever's
been idle longest (pixtuoid). Cheap, and it makes a quiet room read as *calm*
rather than *broken* — which matters given how much of a real cycle is quiet.

### P7 — Deferred, deliberately
- **Streaming (SSE)** — the 5-minute cron means there is genuinely nothing new
  between ticks. Polling is honest here; streaming would be motion without
  information.
- **Journal-backed replay** — architecturally the right answer (AI Town's
  model) and the way to merge Office and Replay into one scrubable view, but
  it's a data-model change, not a view change. Not before the cadence is
  proven.
- **Canvas rewrite** — the DOM implementation is tuned and works at 12 agents.
  Only worth it past ~50 sprites, which this design never reaches.
- **New sprite art** — real fix for G9, but it's asset work, not engineering.

---

## 5. Recommendation

**P1 → P2 → P3** in that order. P1 because a view that hides failure is
actively misleading and the watchdog just made that state permanent; P2 because
it fixes the room being empty for half of every cycle and every input already
exists in production; P3 because it changes what the room is *for*.

P4–P6 are genuine but not urgent. P7 is where the tempting rewrites live, and
they should stay parked until the first autonomous cycles have run.
