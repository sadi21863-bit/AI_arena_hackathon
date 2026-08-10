/**
 * Arena strip — the "what you're looking at" line shared by Live/Office/Graph.
 *
 * One aggregated /events/summary fetch (the Archive page's payload) feeds a
 * compact readout of the current arena: phase, next day-gated phase boundary
 * as a live countdown, and the counts that tell you whether the arena is
 * actually moving — ideas, critiques, judge scores, chronicle lines, queue
 * failures. Kept as a component so "show more info about the arena" lands in
 * every view rather than being re-invented per page.
 */

import { fetchJson } from "./api.js";
import { html, render } from "./html.js";
import { parseUtc } from "./fmt.js";
import { typeLabel, phaseLabel, phasesFor } from "./model.js";

/* Mirrors DAY_GATED_PHASE_STARTS_AT_DAY in src/events/scheduler.ts — the
   day (from start_date) at which the NEXT phase of the current one begins.
   Phases absent here (building, ready_for_judging, terminals) are driven
   continuously, so no day-boundary countdown applies. */
const DAY_GATED_STARTS_AT_DAY = {
  deep_research: 2, ideation_critique: 3, collaboration: 4, architecture: 6, team_formation: 1,
};

function nextBoundary(event) {
  const day = DAY_GATED_STARTS_AT_DAY[event.status];
  if (day == null) return null;
  const start = parseUtc(event.start_date);
  if (!start) return null;
  const ms = start.getTime() + day * 86_400_000 - Date.now();
  if (ms <= 0) return null; // boundary passed — phase is running now
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

function nextPhaseLabel(event) {
  const phases = phasesFor(event.type);
  const idx = phases.findIndex((p) => p.id === event.status);
  return idx >= 0 && idx + 1 < phases.length ? phases[idx + 1].label : null;
}

function stat(name, value, warn = false) {
  return html`<span class="arena-strip__stat" data-name="${name}">
    <b${warn ? ` class="arena-strip__warn"` : ""}>${value}</b> ${name}
  </span>`;
}

export function renderStrip(el, event) {
  const c = event.counts || {};
  const boundary = nextBoundary(event);
  const next = nextPhaseLabel(event);
  const terminal = event.status === "judged" || event.status === "complete" || event.status === "failed" || event.status === "abandoned";

  render(el, html`
    <div class="arena-strip">
      <span class="arena-pill ${terminal ? "arena-pill--muted" : "arena-pill--live"}">${typeLabel(event.type)} · ${phaseLabel(event)}</span>
      ${boundary && next
        ? html`<span class="arena-strip__boundary">${next} starts ${boundary}</span>`
        : event.status === "abandoned"
          ? html`<span class="arena-strip__boundary arena-strip__warn">abandoned</span>`
          : ""}
      ${stat("ideas", c.ideas ?? 0)}
      ${stat("critiques", c.critiques ?? 0)}
      ${stat("judge scores", c.judgeScores ?? 0)}
      ${event.type === "hackathon" ? stat("build turns", c.buildTurns ?? 0, (c.buildFailures ?? 0) > 0) : ""}
      ${stat("chronicle", c.chronicle ?? 0, (c.chronicle ?? 0) === 0 && !terminal)}
      ${stat("queue failed", c.queueFailed ?? 0, (c.queueFailed ?? 0) > 0)}
      ${event.calibration && !event.calibration.passed
        ? html`<span class="arena-strip__stat arena-strip__warn">calibration ${(event.calibration.correlation * 100).toFixed(0)}% ⚠</span>`
        : ""}
      ${event.revival_count > 0
        ? html`<span class="arena-strip__stat arena-strip__warn">revived ×${event.revival_count}</span>`
        : ""}
    </div>`);
}

/**
 * Loads /events/summary and keeps one arena's strip fresh on a poll.
 *
 * @param el            container
 * @param opts.eventId  specific event; without it, the newest event (the
 *                      live arena) is used
 * @param opts.pollMs   refresh interval for the countdown (default 60s)
 */
export function mountArenaStrip(el, opts = {}) {
  const { eventId, pollMs = 60_000 } = opts;
  let disposed = false;
  let timer = null;

  async function load() {
    const summary = await fetchJson("/events/summary", { ttl: pollMs, optional: true });
    if (disposed || !summary || !summary.length) return;
    const event = eventId
      ? summary.find((s) => s.id === eventId)
      : [...summary].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    if (!event) return;
    renderStrip(el, event);
  }

  load();
  timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, pollMs);
  return () => { disposed = true; clearInterval(timer); };
}