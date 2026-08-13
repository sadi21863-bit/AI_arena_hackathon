/**
 * Player — shared playback primitives for the observatory's animated views.
 *
 * The Arena view (Constellation + Replay) and the Live turn machine both
 * re-animate REAL recorded data — never fabricated activity. What they share
 * is this module: a single source of truth for task-type labels, and a live
 * cron-aligned tick clock. The Arena's data can only change on the Worker's
 * 5-minute cron boundary (store.js aligns its polls to the same boundary),
 * so every animated view should say when the next tick arrives instead of
 * pretending data streams in continuously.
 *
 * TASK_LABELS mirrors the enqueue() task types in src/events/scheduler.ts
 * and executor.ts — if a new task type appears there, it should be added
 * here so every view names it the same way.
 */

const TICK_MS = 300_000;   // cron period — keep in sync with store.js
const JITTER_MS = 6_000;   // spread clients so they don't stampede

export const TASK_LABELS = {
  research: "Research",
  submit_idea: "Submit idea",
  revise_idea: "Revise idea",
  critique: "Critique",
  propose_collaboration: "Propose collab",
  architecture: "Architecture",
  team_formation: "Team formation",
  dispatch_build_turn: "Dispatch build turn",
  judge_idea: "Judge idea",
  judge_team: "Judge team",
  tribunal_reflect: "Tribunal reflect",
  tribunal_cross_examine: "Cross-examine",
  tribunal_synthesize: "Synthesize",
  chronicle: "Chronicle",
};

export function taskLabel(type) {
  return TASK_LABELS[type] || type.replace(/_/g, " ");
}

/** ms until just after the next cron boundary — same math as store.js. */
export function msUntilNextTick() {
  return TICK_MS - (Date.now() % TICK_MS) + 1_000 + Math.random() * JITTER_MS;
}

function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Mount a live "next cron tick in m:ss" countdown onto `host`. Re-renders
 * every second; updates immediately after a tick boundary. Returns a
 * teardown that MUST be called on view unmount — on the old page-per-view
 * site the browser killed the interval for free; in one shell it would keep
 * ticking behind whatever view you navigated to.
 */
export function mountTickClock(host) {
  if (!host) return () => {};
  let timer = null;

  function draw() {
    host.textContent = `next tick in ${formatCountdown(msUntilNextTick())}`;
    timer = setTimeout(draw, 1000);
  }

  draw();
  return () => { clearTimeout(timer); timer = null; };
}

/** UTC "HH:MM" from a D1 timestamp ("YYYY-MM-DD HH:MM:SS" or ISO). */
export function utcTime(ts) {
  if (!ts) return "";
  const t = String(ts).includes("T") ? String(ts) : String(ts) + "Z";
  return t.slice(11, 16);
}