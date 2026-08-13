/**
 * Live — the hub.
 *
 * Presents an Arena as the thing it actually is: one ideathon plus the
 * hackathon that advanced from it. The old page showed "the most recent
 * event row", which meant that once a hackathon existed the ideathon that
 * produced it vanished from view, and the queue meter silently switched to
 * measuring the hackathon without saying so.
 *
 * Also the entry point to every other view, each pre-bound to the right
 * event — previously the secondary pages opened with an empty picker you had
 * to re-select before seeing anything.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { href } from "../core/router.js";
import * as store from "../core/store.js";
import { toCycles, findCycle, phasesFor, phaseLabel, isLive, isTerminal, typeLabel } from "../core/model.js";
import { dateRange, utcDate, shortId, score } from "../core/fmt.js";
import { renderStrip } from "../core/arena-strip.js";
import { taskLabel, mountTickClock, utcTime } from "../core/player.js";

/* One continuous track across both halves of the cycle, so the handoff is
   visible rather than implied. Phases come from model.js, which mirrors
   scheduler.ts — the old stepper had drifted and was missing `collaboration`
   entirely. */
function spine(cycle) {
  function half(event, phases) {
    const idx = event ? phases.findIndex((p) => p.id === event.status) : -1;
    return phases.map((p, i) => {
      const cls = !event ? "is-future" : i < idx ? "is-done" : i === idx ? "is-current" : "is-future";
      return html`<div class="v-live__step ${cls}"><span class="v-live__step-dot"></span>${p.short}</div>`;
    });
  }
  return html`
    <div class="v-live__spine">
      <div class="v-live__track">
        <div class="v-live__track-label">Ideathon</div>
        <div class="v-live__steps">${half(cycle.ideathon, phasesFor("ideathon"))}</div>
      </div>
      <div class="v-live__gate ${cycle.hackathon ? "is-open" : ""}" title="Top 2 ideas advance">
        <span class="v-live__gate-mark">▶</span>
        <span class="v-live__gate-text">top 2 advance</span>
      </div>
      <div class="v-live__track">
        <div class="v-live__track-label">Hackathon</div>
        <div class="v-live__steps">${half(cycle.hackathon, phasesFor("hackathon"))}</div>
      </div>
    </div>`;
}

function meter(counts) {
  const total = counts.pending + counts.in_progress + counts.completed + counts.failed;
  if (!total) return html`<div class="arena-state">No queue activity recorded for this event.</div>`;
  const pct = (n) => (n / total * 100).toFixed(1) + "%";
  return html`
    <div class="arena-meter">
      <div class="arena-meter__seg arena-meter__seg--done" style="width:${pct(counts.completed)}"></div>
      <div class="arena-meter__seg arena-meter__seg--progress" style="width:${pct(counts.in_progress)}"></div>
      <div class="arena-meter__seg arena-meter__seg--pending" style="width:${pct(counts.pending)}"></div>
      <div class="arena-meter__seg arena-meter__seg--failed" style="width:${pct(counts.failed)}"></div>
    </div>
    <div class="arena-meter-legend">
      <div class="arena-meter-legend__item"><span class="arena-meter-legend__swatch" style="background:var(--arena-success)"></span>${counts.completed} completed</div>
      <div class="arena-meter-legend__item"><span class="arena-meter-legend__swatch" style="background:var(--arena-gold)"></span>${counts.in_progress} running</div>
      <div class="arena-meter-legend__item"><span class="arena-meter-legend__swatch" style="background:var(--arena-line-strong)"></span>${counts.pending} pending</div>
      <div class="arena-meter-legend__item"><span class="arena-meter-legend__swatch" style="background:var(--arena-danger)"></span>${counts.failed} failed</div>
    </div>`;
}

/* Turn machine — the queue as a factory floor: tasks visibly sit in one of
   four lanes and move across on each cron tick. Real rows only (the last 60
   from /events/:id/queue-items); the tick clock in the corner is honest
   about when the data can next change. The pulsing track between lanes is
   decoration for a process that genuinely stops between ticks. */
function turnMachine(items) {
  const list = items || [];
  const lanes = { pending: [], in_progress: [], completed: [], failed: [] };
  for (const it of list) {
    if (!lanes[it.status]) lanes[it.status] = [];
    lanes[it.status].push(it);
  }
  const laneOrder = [
    { key: "pending", label: "Queued", cls: "v-live__lane--queued" },
    { key: "in_progress", label: "Working", cls: "v-live__lane--working" },
    { key: "completed", label: "Done", cls: "v-live__lane--done" },
    { key: "failed", label: "Failed", cls: "v-live__lane--failed" },
  ];
  const nowMs = Date.now();
  const age = (ts) => {
    if (!ts) return "";
    const m = Math.floor((nowMs - new Date(String(ts).replace(" ", "T") + "Z").getTime()) / 60000);
    return m < 1 ? "just now" : m < 90 ? `${m}m ago` : utcTime(ts);
  };

  return html`
    <div class="v-live__lanes">
      ${laneOrder.map((lane) => {
        const rows = lanes[lane.key] || [];
        // Newest first within a lane so fresh arrivals read top-down.
        const sorted = [...rows].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
        return html`
          <div class="v-live__lane ${lane.cls}">
            <div class="v-live__lane-head">
              <span>${lane.label}</span>
              <b>${sorted.length}</b>
            </div>
            <div class="v-live__lane-body">
              ${sorted.length ? sorted.map((it) => {
                const movedAt = it.status === "completed" ? it.completed_at : it.status === "in_progress" ? it.claimed_at : it.created_at;
                return html`
                  <div class="v-live__chip" title="${taskLabel(it.task_type)}${it.agent_id ? " · " + store.agentName(it.agent_id) : ""} · created ${it.created_at || "—"}">
                    <span class="v-live__chip-task">${taskLabel(it.task_type)}</span>
                    ${it.agent_id ? html`<span class="v-live__chip-agent">${store.agentName(it.agent_id)}</span>` : ""}
                    <span class="v-live__chip-time">${age(movedAt)}</span>
                  </div>`;
              }) : html`<div class="v-live__lane-empty">—</div>`}
            </div>
          </div>`;
      })}
    </div>
    <div class="v-live__track-flow" aria-hidden="true"></div>`;
}

function ideathonColumn(cycle, ideas) {
  const e = cycle.ideathon;
  const judged = (ideas || []).filter((i) => i.status === "judged");
  const top = [...judged].sort((a, b) => (b.ideathon_score || 0) - (a.ideathon_score || 0)).slice(0, 3);
  return html`
    <section class="arena-card v-live__col">
      <div class="v-live__col-head">
        <h2>Ideathon</h2>
        <span class="arena-pill ${isLive(e) ? "arena-pill--live" : ""}">${phaseLabel(e)}</span>
      </div>
      <div class="v-live__stats">
        <div><b>${(ideas || []).length}</b><span>ideas</span></div>
        <div><b>${judged.length}</b><span>judged</span></div>
        <div><b>${utcDate(e.start_date)}</b><span>started</span></div>
      </div>
      ${top.length ? html`
        <div class="arena-section-label">Leading ideas</div>
        ${top.map((i) => html`
          <a class="v-live__row" href="${href(`/ideas/${e.id}/${i.id}`)}">
            <span class="v-live__row-main">
              <b>${i.title}</b>
              <small>${store.agentName(i.agent_id)}${i.co_agent_id ? ` + ${store.agentName(i.co_agent_id)}` : ""}</small>
            </span>
            <span class="arena-pill arena-pill--score">${score(i.ideathon_score)}</span>
          </a>`)}
      ` : html`<div class="arena-state">No ideas judged yet.</div>`}
    </section>`;
}

function hackathonColumn(cycle, teams) {
  const e = cycle.hackathon;
  if (!e) {
    return html`
      <section class="arena-card v-live__col v-live__col--pending">
        <div class="v-live__col-head"><h2>Hackathon</h2><span class="arena-pill arena-pill--muted">not started</span></div>
        <div class="arena-state">Begins automatically once the ideathon is judged and the top two ideas are picked.</div>
      </section>`;
  }
  return html`
    <section class="arena-card v-live__col">
      <div class="v-live__col-head">
        <h2>Hackathon</h2>
        <span class="arena-pill ${isLive(e) ? "arena-pill--live" : ""}">${phaseLabel(e)}</span>
      </div>
      <div class="v-live__stats">
        <div><b>${(teams || []).length}</b><span>teams</span></div>
        <div><b>${utcDate(e.start_date)}</b><span>started</span></div>
      </div>
      ${(teams || []).length ? html`
        <div class="arena-section-label">Teams</div>
        ${teams.map((t) => html`
          <a class="v-live__row" href="${href(`/diff/${e.id}/${t.team_name}`)}">
            <span class="v-live__row-main">
              <b>${t.team_name}${e.winner_team_id === t.id ? " ★" : ""}</b>
              <small>${t.status}${t.repo_url ? ` · ${t.repo_url}` : ""}</small>
            </span>
            ${typeof t.final_score === "number"
              ? html`<span class="arena-pill arena-pill--score">${score(t.final_score)}</span>`
              : html`<span class="arena-pill arena-pill--muted">building</span>`}
          </a>`)}
      ` : html`<div class="arena-state">Teams form on day 0 of the hackathon.</div>`}
    </section>`;
}

/* Replaces six permanent nav links. Each carries a real number so it earns
   the space, and each is already bound to this cycle's event. */
function instruments(cycle, counts) {
  const i = cycle.ideathon, h = cycle.hackathon;
  const items = [
    { label: "Ideas Board",  to: `/ideas/${i.id}`,     stat: counts.ideas,       unit: "ideas" },
    { label: "Arena",        to: `/arena/${i.id}`,     stat: counts.moments,     unit: "moments" },
    { label: "Agent Office", to: `/office/${cycle.activeEvent.id}`, stat: 12,    unit: "agents" },
    h ? { label: "Diff", to: `/diff/${h.id}`, stat: counts.teams, unit: "teams" }
      : { label: "Diff", disabled: true, reason: "after the hackathon starts" },
    h ? { label: "Tribunal", to: `/tribunal/${h.id}`, stat: counts.reflections, unit: "reflections" }
      : { label: "Tribunal", disabled: true, reason: "after hackathon judging" },
  ];
  return html`
    <div class="arena-section-label">Instruments</div>
    <div class="v-live__instruments">
      ${items.map((it) => it.disabled
        ? html`<div class="arena-card v-live__inst v-live__inst--off"><b>${it.label}</b><small>${it.reason}</small></div>`
        : html`<a class="arena-card v-live__inst" href="${href(it.to)}"><b>${it.label}</b><small>${it.stat === null || it.stat === undefined ? "—" : it.stat} ${it.unit}</small></a>`)}
      <a class="arena-card v-live__inst" href="${href("/headroom")}"><b>Headroom</b><small>inference budget</small></a>
    </div>`;
}

function history(cycles) {
  if (cycles.length < 2) return "";
  return html`
    <div class="arena-section-label">Earlier Arenas</div>
    <div class="v-live__history">
      ${cycles.slice(1).map((c) => html`
        <a class="arena-card v-live__hist" href="${href(`/cycle/${c.id}`)}">
          <span class="v-live__hist-ord">Arena ${c.ordinal}</span>
          <span class="v-live__hist-date">${dateRange(c.startDate, c.endDate)}</span>
          <span class="arena-pill ${c.isLive ? "arena-pill--live" : "arena-pill--muted"}">${c.isLive ? "running" : "finished"}</span>
        </a>`)}
    </div>`;
}

export async function mount(el, params) {
  let disposed = false;

  render(el, html`<div class="arena-state">Loading the Arena…</div>`);
  await store.loadAgents();

  async function draw() {
    if (disposed) return;
    const { data, error } = store.events.get();
    if (!data) {
      if (error) render(el, html`<div class="arena-state arena-state--error">Couldn't reach the Arena API.</div>`);
      return;
    }

    const cycles = toCycles(data);
    if (!cycles.length) {
      render(el, html`<div class="arena-state">No Arena has run yet.</div>`);
      return;
    }

    const cycle = (params.cycleId && findCycle(data, params.cycleId)) || cycles[0];
    const i = cycle.ideathon, h = cycle.hackathon;

    // All optional: a missing endpoint must degrade a number to "—", never
    // take the hub down. Pages and the Worker deploy independently.
    const [ideas, teams, queue, queueItems, timeline, reflections, summary] = await Promise.all([
      fetchJson(`/ideas?event_id=${encodeURIComponent(i.id)}`, { ttl: isTerminal(i) ? FOREVER : 30_000, optional: true }),
      h ? fetchJson(`/events/${encodeURIComponent(h.id)}/teams`, { optional: true }) : Promise.resolve([]),
      fetchJson(`/events/${encodeURIComponent(cycle.activeEvent.id)}/queue-status`, { optional: true }),
      fetchJson(`/events/${encodeURIComponent(cycle.activeEvent.id)}/queue-items`, { optional: true }),
      fetchJson(`/events/${encodeURIComponent(i.id)}/timeline`, { ttl: isTerminal(i) ? FOREVER : 30_000, optional: true }),
      h ? fetchJson(`/events/${encodeURIComponent(h.id)}/tribunal`, { optional: true }) : Promise.resolve([]),
      fetchJson("/events/summary", { ttl: 60_000, optional: true }),
    ]);
    if (disposed) return;

    const counts = {
      ideas: ideas ? ideas.length : null,
      teams: teams ? teams.length : null,
      moments: timeline ? timeline.length : null,
      reflections: reflections ? reflections.length : null,
    };

    const calFailed = i.calibration && i.calibration.passed === false;
    const activeSummary = (summary || []).find((s) => s.id === cycle.activeEvent.id);

    render(el, html`
      <header class="v-live__masthead">
        <div>
          <div class="arena-eyebrow">${params.cycleId ? "Past Arena" : "Current Arena"}</div>
          <h1>Arena ${cycle.ordinal}</h1>
          <p class="v-live__dates">${dateRange(cycle.startDate, cycle.endDate)}</p>
        </div>
        <span class="arena-pill ${cycle.isLive ? "arena-pill--live" : "arena-pill--muted"}">
          ${cycle.isLive ? `${typeLabel(cycle.activeEvent.type)} · ${phaseLabel(cycle.activeEvent)}` : "finished"}
        </span>
      </header>

      ${activeSummary ? html`<div id="v-live-strip"></div>` : ""}

      ${calFailed ? html`
        <div class="arena-note arena-note--warn"><span>⚠</span><span>
          <b>Judge calibration failed for this Arena</b> (correlation ${score(i.calibration.correlation)}, below the 0.6 threshold) — every score below is lower-confidence.
        </span></div>` : ""}

      ${spine(cycle)}

      <div class="v-live__cols">
        ${ideathonColumn(cycle, ideas)}
        ${hackathonColumn(cycle, teams)}
      </div>

      <section class="arena-card v-live__queue">
        <div class="v-live__queue-head">
          <div>
            <div class="arena-section-label">Turn machine · ${typeLabel(cycle.activeEvent.type)} (${shortId(cycle.activeEvent.id, 22)})</div>
            <p class="v-live__queue-note">The last 60 queue items, moving across on each cron tick.</p>
          </div>
          <div class="v-live__tick" data-tick>next tick in —</div>
        </div>
        ${queueItems ? turnMachine(queueItems) : (queue ? meter(queue) : html`<div class="arena-state">Queue status unavailable.</div>`)}
      </section>

      ${instruments(cycle, counts)}
      ${params.cycleId ? html`<div class="v-live__back"><a class="arena-btn arena-btn--sm arena-btn--ghost" href="${href("/live")}">← Current Arena</a></div>` : history(cycles)}

      <p class="arena-freshness" data-freshness></p>`);

    const stripEl = el.querySelector("#v-live-strip");
    if (stripEl && activeSummary) renderStrip(stripEl, activeSummary);

    /* The queue card re-renders on every draw, so the tick clock inside it
       must be remounted each time — the old instance's element is gone. */
    if (tickTeardown) { tickTeardown(); tickTeardown = null; }
    const tickEl = el.querySelector("[data-tick]");
    if (tickEl) tickTeardown = mountTickClock(tickEl);
  }

  let tickTeardown = null;
  await draw();
  const off = store.events.subscribe(draw);
  return () => { disposed = true; off(); if (tickTeardown) tickTeardown(); };
}
