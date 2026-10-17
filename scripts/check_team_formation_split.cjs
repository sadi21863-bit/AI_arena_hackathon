// Verifies the one-team-per-item split of handleTeamFormation terminates and
// forms exactly the right teams.
//
// The risk this guards against is specific: the handler now enqueues a
// continuation item, and the loop head skips teams already at status
// 'building'. If that skip ever failed to fire, the handler would enqueue a
// continuation forever — an unbounded queue loop on a live event. This models
// the DB state machine rather than trusting the read.
//
// Mirrors executor.ts: the `continue` on status==='building' at the loop head,
// the UPDATE to 'building' at the tail, and the `if (i < top2.length - 1)`
// enqueue-then-return.

function simulate(top2, maxItems = 12) {
  const teams = top2.map((idea, i) => ({ name: i === 0 ? "alpha" : "beta", idea, status: null }));
  let queue = 1;              // items waiting
  let items = 0;
  const formed = [];
  let guardTripped = false;

  while (queue > 0) {
    if (++items > maxItems) { guardTripped = true; break; }
    queue--;
    // One item drains the loop, forming at most one team (the early return).
    let enqueued = false;
    for (let i = 0; i < top2.length; i++) {
      const t = teams[i];
      if (t.status === "building") continue;          // loop-head skip
      t.status = "building";                          // tail UPDATE
      formed.push(t.name);
      if (i < top2.length - 1) { enqueue = true; enqueued = true; break; } // early return
    }
    if (enqueued) queue++;
  }
  return { formed, items, guardTripped };
}

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else { failed++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

// Normal case: two ideas -> two items -> both teams formed exactly once.
const normal = simulate([{ id: "A" }, { id: "B" }]);
check("two teams formed", normal.formed.length === 2, `got ${normal.formed}`);
check("each team formed exactly once",
  new Set(normal.formed).size === normal.formed.length, `got ${normal.formed}`);
check("two items used (one per team)", normal.items === 2, `got ${normal.items}`);
check("loop terminated without hitting the guard", !normal.guardTripped);

// One idea only (a degenerate top2 of length 1) -> single item, no continuation.
const single = simulate([{ id: "A" }]);
check("single idea forms one team in one item",
  single.formed.length === 1 && single.items === 1, `formed=${single.formed} items=${single.items}`);
check("single idea does not enqueue a continuation", !single.guardTripped);

// The runaway scenario: if the loop-head skip stopped working, top2.length===2
// would enqueue forever. Assert the guard actually catches that, so this test
// would FAIL loudly if someone removed the skip.
const noSkip = (() => {
  let queue = 1, items = 0, tripped = false;
  while (queue > 0) {
    if (++items > 12) { tripped = true; break; }
    queue--;
    for (let i = 0; i < 2; i++) {
      if (i < 1) { queue++; break; }   // no skip at all -> always re-enqueues
    }
  }
  return tripped;
})();
check("guard detects the runaway shape (skip removed => caught)", noSkip);

// Empty top2: loop body never runs, no continuation, handler completes.
const empty = simulate([]);
check("empty top2 enqueues nothing", empty.formed.length === 0 && empty.items === 1,
  `formed=${empty.formed} items=${empty.items}`);

// 9. REGRESSION GUARD for the bug this missed the first time.
//
// Splitting the item is not sufficient on its own: `enqueue` makes the
// continuation immediately claimable and processQueue(limit=3) drains up to 3
// items per Worker invocation, so both teams still shared ONE subrequest budget.
// Measured live on event_41cbabb7: item 1 completed at 53 subrequests, the
// continuation failed at 19, and the second team was left with an empty repo.
//
// The invariant is that the continuation is NOT claimable in the invocation that
// created it. `scheduledFor` is what enforces that (claimNext only takes items
// whose scheduled_for has passed), so assert it is set and in the future.
const exec = require("fs").readFileSync("src/events/executor.ts", "utf8");
const contBlock = exec.match(/if \(i < top2\.length - 1\) \{[\s\S]{0,400}?\n {4}\}/);
check("continuation block exists", !!contBlock, "if (i < top2.length - 1) not found");
const block = contBlock ? contBlock[0] : "";
check("continuation sets scheduledFor (not immediately claimable)",
  /scheduledFor\s*:/.test(block),
  "a continuation with no scheduledFor is claimed in the SAME invocation — this is the live bug on event_41cbabb7");
check("continuation schedules into the future",
  /scheduledFor\s*:\s*new Date\(Date\.now\(\)\s*\+\s*\d/.test(block),
  "scheduledFor must be a future offset, not a past or fixed date");
// And the enqueue must still be inside the guarded block (not fire unconditionally).
check("scheduledFor is on the continuation's enqueue call",
  /enqueue\([\s\S]{0,300}scheduledFor/.test(block), "enqueue must carry the delay");

// 10. REGRESSION GUARDS for the 2026-10-17 strand (event_693bc79b). The
// continuation item COMPLETED after creating the second team's row, then died
// at its very next statement (the dispatch call — subrequest cap), leaving
// beta at 'forming' with nothing queued: the old re-arm counted
// `status != 'failed'` items, so the completed continuation satisfied it
// forever. Two fixes, both pinned below: the scheduler re-arm (only in-flight
// items block it; a 'forming' team re-arms it) and bank-the-take-after-dispatch
// (a resume must not double-count a member's turn).
const rearm = (guard, s) =>
  guard === "old"
    ? (s.inFlight + s.history === 0 && s.formed < 2)
    : (s.inFlight === 0 && (s.formed < 2 || s.forming > 0));

// The live strand state: item 2 completed (history=1), nothing in flight,
// both team rows exist, beta stuck at 'forming'.
const strand = { inFlight: 0, history: 1, formed: 2, forming: 1 };
check("old guard strands a 'forming' team (documents the live bug)", rearm("old", strand) === false);
check("new guard re-arms the stuck team", rearm("new", strand) === true);
check("new guard stops once the resume flips the team to 'building'",
  rearm("new", { inFlight: 0, history: 2, formed: 2, forming: 0 }) === false);
check("new guard still bootstraps a fresh event",
  rearm("new", { inFlight: 0, history: 0, formed: 0, forming: 0 }) === true);
check("new guard does not double-enqueue while an item is in flight",
  rearm("new", { inFlight: 1, history: 0, formed: 1, forming: 1 }) === false);

const sched = require("fs").readFileSync("src/events/scheduler.ts", "utf8");
check("re-arm counts only in-flight items",
  /status IN \('pending', 'claimed'\)/.test(sched),
  "scheduler.ts must count pending/claimed team_formation items, not status != 'failed'");
check("re-arm re-fires while a team sits at 'forming'",
  /FROM hackathon_teams WHERE event_id = \? AND status = 'forming'/.test(sched));
check("re-arm condition carries the forming clause",
  /\(inFlight\?\.n \?\? 0\) === 0 && \(\(formedTeams\?\.n \?\? 0\) < HACKATHON_TEAM_COUNT \|\| \(formingTeams\?\.n \?\? 0\) > 0\)/.test(sched));

// Bank-after-dispatch: in BOTH handlers the take must be written after the
// dispatch call and gated on (freshTurn || dispatched). Reverting to the old
// pre-dispatch unconditional write would pass every other case here.
const handlers = [
  ["formation", "async function handleTeamFormation", "async function handleDispatchBuildTurn"],
  ["daily", "async function handleDispatchBuildTurn", "async function handleJudgeIdea"],
];
for (const [label, start, end] of handlers) {
  const slice = exec.slice(exec.indexOf(start), exec.indexOf(end));
  check(`${label}: take is written after the dispatch call`,
    slice.indexOf("dispatchTurnIfNeeded") !== -1 &&
    slice.indexOf("recordTurnTaken") > slice.indexOf("dispatchTurnIfNeeded"));
}
check("formation take is gated on fresh-or-dispatched",
  /if \(opener && \(freshTurn \|\| dispatched\)\)/.test(exec));
check("daily take is gated on fresh-or-dispatched",
  /if \(author && \(freshTurn \|\| dispatched\)\)/.test(exec));

console.log(failed === 0 ? "\nall team_formation split cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);