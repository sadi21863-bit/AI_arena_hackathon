# Part 2 (N-2 … N-7) — what was built, and what wasn't

Companion to `docs/ARENA_BACKLOG.md`, whose Part 2 is explicitly *"proposals,
not defects. Discuss before building."* This records the decision on each.

Built: **N-2, N-3, N-4, N-5, N-7**. Declined: **N-6**, with reasoning below.

Everything here is committed but **not deployed** — see "Verification status".

---

## N-2 — Feed the archive back into research ✅

`deepResearch` now queries the Vectorize archive alongside Tavily, and
`handleCritique` recalls against the specific idea it is critiquing instead of
a fixed generic lens string.

Two exclusions keep this a feedback loop rather than an echo chamber, and both
are load-bearing:

- **The current event is excluded.** Pulling in ideas being written right now
  would amplify whatever this event has already converged on — which is the
  duplicate-idea failure (NEW-2) arriving by a new route.
- **`type='research'` is excluded.** `deepResearch` writes its own summaries
  back into the same index, so recycling them would compound each event's
  digest into the next one's indefinitely. Only genuine agent output — ideas,
  critiques, reflections — feeds back.

Cost is one extra embedding per research call, not a Tavily credit, so the
budget math in `research.ts`'s header is unaffected.

## N-3 — Pairwise runoff for close calls ✅

`src/judges/runoff.ts`. Runs only when the 2nd and 3rd candidates are within
`RUNOFF_MARGIN` (0.35) — the real event that motivated this advanced 7.05 over
6.90, a gap inside judge noise that nonetheless decided which idea got built.

Independent scoring stays exactly as it is; it is the correct structure and the
standard position-bias mitigation. It simply cannot resolve a tie, because two
independent scores 0.15 apart carry no information about which is better.

Comparing entries head-to-head reintroduces the position bias independent
scoring avoids, so the comparison runs in **both orderings** and counts only
when the same entry wins twice. A judge that picks "whichever is first" both
times contradicts itself and is discarded.

**Inconclusive is a real outcome, not a failure.** The caller keeps the
existing score order, so a runoff can only ever promote on positive evidence —
never a coin flip. The challenger is drawn from the distinctness-filtered pool
so a promotion cannot undo P0-0b and rebuild the same idea twice.

## N-4 — Ground the code-quality judge in real signal ✅

`collectBuildEvidence` in `src/events/build-turns.ts`. The judge now sees diff
size, commit count, product files (excluding scaffold and turn logs), and
whether a test suite exists — on top of the CI pass/fail counts it already had.

Bounded to **two GitHub calls per team** regardless of turn count (list
commits, then one `compare` of oldest against newest), because judging is
already the heaviest subrequest consumer in the queue.

It also names the P0-0a false-success shape directly: a team whose only
committed files are scaffold and its own turn log gets an explicit warning in
the judge's context, rather than appearing as "3 successful build turns."

## N-5 — Cross-event skill ratings ✅

Elo on `archive_agents`, applied once per hackathon when both sides have final
scores. Elo rather than TrueSkill because a hackathon is a two-sided match with
a definite winner — exactly Elo's design case. TrueSkill would be the better
choice if the Arena ever ran more than two teams per event.

Each agent is rated against the **opposing roster's mean**, not as an
interchangeable unit of its team, so a strong agent on a losing side loses less
than a weak one. That is what keeps the number about the agent rather than
about which team it happened to be assigned to.

**This is the one accumulating write in the system that is not safe to
replay.** Every other handler is written to be re-runnable because the
scheduler retries freely; Elo is a delta, so applying it twice permanently
inflates a winner with no way to detect it afterwards. Guarded by
`archive_events.ratings_applied_at`, stamped in the same D1 batch as the rating
writes so a retry landing between the two is impossible.

## N-6 — Cloudflare Workflows for orchestration ❌ Declined

The backlog already argued against this honestly ("Do this only if the
orchestration layer is going to keep growing — not as a rewrite for its own
sake"). Three things make the case weaker now than when it was written:

1. **Its premise has been overtaken.** The argument was that W5-7's bugs were
   overwhelmingly retry storms, stages stuck on stale failure counts, and
   backoff constants needing empirical tuning — precisely what durable
   execution solves. Those are now fixed *and* verified, and the last
   structural gap in that class (an item that fails permanently pinning its
   event below terminal status forever, silently halting all future cadence)
   was closed by `MAX_ITEM_ATTEMPTS` + `checkForStalledEvents` and verified
   against a live local D1. Migrating now would discard debugged, tested
   behaviour to re-acquire it.

2. **Workflows would not have caught this project's most expensive bugs.**
   P0-0a (build turns producing no code) and P0-0b (both teams building the
   same idea) are semantic — wrong *output* from steps that executed and exited
   zero. Durable execution would have retried the same wrong thing more
   reliably. The bugs that actually cost this project weeks are not in the
   class Workflows addresses.

3. **The timing is bad.** The autonomous cadence begins 2026-08-01. Rewriting
   the scheduler/executor/queue is the single highest-risk change available in
   this repo, and it would land immediately before the first unattended run.

**Revisit if** the orchestration layer starts growing again — genuinely
long-running waits, human-in-the-loop steps, or fan-out that the current
5-minute cron shape handles badly. Not before.

## N-7 — Chronicler / live commentary ✅

`src/agents/chronicle.ts` + `GET /events/:id/chronicle`. Narrates each phase as
it ends, queued on the transition so a slow summarize call can't delay the
transition it describes.

Facts are gathered from D1 **first** and handed to the model as material; the
model writes them up rather than recalling them, and the prompt forbids
inventing anything not in the material. That ordering is deliberate in a
project whose recent history is bugs where plausible text stood in for real
work — a Chronicler that invented events would be exactly that failure wearing
a friendlier face.

Idempotent via `UNIQUE(event_id, phase)` and `INSERT OR IGNORE`, since phase
transitions are detected by whichever cron tick notices them.

---

## Verification status — honest

**Verified:** typecheck clean across all of it. Pure logic is unit-tested
without network or API keys — `scripts/test_runoff.js` (8 checks, including
that a disagreement between orderings is *not* silently resolved in favour of
the first) and `scripts/test_ratings.js` (13 checks: complementary
expectations, zero-sum symmetry, beating a stronger opponent gaining more, and
an empty roster falling back to the default rather than poisoning the event
with `NaN`). Both migrations apply cleanly to a fresh local D1 through
`scripts/apply_schema.js`.

**Not verified:** none of this has run against a live event. The paths that
call an LLM — the runoff comparison, the Chronicler, archive-augmented research
— have never executed end to end, and the Elo pass has never rated a real
hackathon. Each is guarded so that failing degrades rather than blocking
(inconclusive runoffs keep the score order, a failed chronicle writes no row,
a failed archive lookup returns no priors), but "degrades safely when broken"
is a different claim from "works."

The first real exercise of all five will be the first autonomous cycle, which
is also the first cycle nobody is watching. That is worth weighing before
deploying them together.
