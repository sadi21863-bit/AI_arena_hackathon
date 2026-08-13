/**
 * Arena — the observatory's centerpiece: one view, two ways to read a cycle.
 *
 * The old Graph view was a pure force layout where position encoded nothing
 * and every interaction drew as an identical arrow, so a cycle's ~100
 * critiques collapsed into a monochrome hairball. This view replaces it with
 * a tabbed pair that shares ONE deterministic layout, so the mental map you
 * build in one tab carries into the other:
 *
 *  - Constellation: agents grouped into interaction-weight communities,
 *    each drawn inside its own hull. Edge type is encoded by color AND dash
 *    pattern AND width, never by position alone. Clicking an agent opens its
 *    story rail instead of just dimming the room.
 *  - Replay: the same positions, re-animated chronologically — nodes light
 *    up as their ideas land, edges draw at the moment the interaction
 *    happened, and a phase bar shows which day of the cycle you're in.
 *
 * Layout is computed once and is fully deterministic (no force simulation):
 * communities via label propagation over pair interaction weight, then a
 * grid of hull zones. Nothing ticks unless the user is playing the replay,
 * so teardown only has to stop one playback timer.
 *
 * Both tabs read public endpoints that already exist — /agents/graph
 * (aggregated agent-to-agent edges) and /events/:id/timeline (the
 * chronological moments) — so this view needed no backend change.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { loadScript } from "../core/assets.js";
import { mountArenaStrip } from "../core/arena-strip.js";
import { parseUtc } from "../core/fmt.js";
import * as store from "../core/store.js";
import { isTerminal } from "../core/model.js";

/* Edge encoding: type is three channels at once — color, dash, width. The
   previous design had one channel (thin + same color for everything), which
   is why every arena looked like the same hairball. */
const TYPES = {
  critique:              { color: "var(--arena-chart-1)", dash: null,         label: "critiqued",                  weight: 1.0 },
  propose_collaboration: { color: "var(--arena-chart-3)", dash: "7 4",         label: "proposed collaborating with", weight: 1.4 },
  merge:                 { color: "var(--arena-chart-2)", dash: null,         label: "merged with",                 weight: 2.2 },
  collaboration_refused: { color: "var(--arena-chart-5)", dash: "3 4",         label: "refused to collaborate with", weight: 1.1 },
  conduct:               { color: "var(--arena-chart-4)", dash: "3 4",         label: "flagged under conduct",       weight: 1.1 },
};
const TYPE_OTHER = { color: "var(--arena-line-strong)", dash: null, label: "interacted with", weight: 1.0 };

const DAY_MS = 86_400_000;
const STEP_MS = 900;

/* Day-of-cycle spans for the replay phase bar, mirroring phaseForDay in
   src/events/scheduler.ts (deep_research <2, ideation <3, collab <4,
   architecture <6, then judging). */
const PHASE_SPANS = [
  { id: "deep_research",     label: "Research",  from: 0, to: 2 },
  { id: "ideation_critique", label: "Ideation",  from: 2, to: 3 },
  { id: "collaboration",     label: "Collab",    from: 3, to: 4 },
  { id: "architecture",      label: "Arch",      from: 4, to: 6 },
  { id: "ready_for_judging", label: "Judging",   from: 6, to: 8 },
];

const DAY = (ms) => Math.floor(ms / DAY_MS);

/* ---- communities: label propagation over pair interaction weight ---- */

function communities(edges, agentIds) {
  const w = new Map();
  for (const e of edges) {
    if (e.source === e.target) continue;
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    w.set(key, (w.get(key) || 0) + (e.weight || 1));
  }
  const labels = new Map(agentIds.map((id) => [id, id]));
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (const id of agentIds) {
      const votes = new Map();
      for (const other of agentIds) {
        if (other === id) continue;
        const key = id < other ? `${id}|${other}` : `${other}|${id}`;
        const wt = w.get(key);
        if (!wt) continue;
        const lbl = labels.get(other);
        votes.set(lbl, (votes.get(lbl) || 0) + wt);
      }
      let best = labels.get(id), bestW = 0;
      for (const [lbl, wt] of votes) if (wt > bestW) { bestW = wt; best = lbl; }
      if (best !== labels.get(id)) { labels.set(id, best); moved = true; }
    }
    if (!moved) break;
  }
  const groups = new Map();
  for (const [id, lbl] of labels) {
    if (!groups.has(lbl)) groups.set(lbl, []);
    groups.get(lbl).push(id);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/* ---- deterministic layout: hull zones in a grid, agents on a ring ---- */

function layout(groups, W, H) {
  const cols = Math.ceil(Math.sqrt(groups.length));
  const rows = Math.ceil(groups.length / cols);
  const pos = new Map();
  groups.forEach((members, gi) => {
    const cx = (W / cols) * (gi % cols) + W / (cols * 2);
    const cy = (H / rows) * Math.floor(gi / cols) + H / (rows * 2);
    const r = Math.max(28, Math.min(W / cols, H / rows) * 0.33);
    const n = members.length;
    members.forEach((id, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2 + (gi % 2 ? 0.5 : 0);
      pos.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    });
  });
  return pos;
}

const hullPath = (d3, pts) => {
  const hull = d3.polygonHull(pts);
  return hull ? `M${hull.map((p) => p.map((v) => +v.toFixed(1)).join(",")).join("L")}Z` : "";
};

/* ---- moment list: ideas + interactions, targets resolved to agents ---- */

function buildMoments(timeline) {
  const ideaAuthor = new Map();
  for (const row of timeline || []) {
    if (row.kind === "idea") ideaAuthor.set(row.id, row.agent_id);
  }
  const moments = (timeline || [])
    .map((row) => row.kind === "idea"
      ? {
          kind: "idea", ts: row.ts, agentId: row.agent_id, targetId: null,
          type: "idea", title: row.title, text: row.one_liner || "", ideaId: row.id,
        }
      : {
          kind: "interaction", ts: row.ts, agentId: row.actor_id,
          targetId: ideaAuthor.get(row.target_id) ?? row.target_id,
          type: row.type, text: row.content || "", ideaId: row.target_id,
        })
    .filter((m) => m.kind === "idea" || (m.agentId && m.targetId && m.agentId !== m.targetId))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { moments, ideaAuthor };
}

const edgeKey = (m) => `${m.agentId}|${m.type}|${m.targetId}`;

function summarizeInteraction(content) {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content);
    if (parsed.strength) return `Strength: ${parsed.strength} — Weakness: ${parsed.weakness || "—"} — Suggestion: ${parsed.suggestion || "—"}`;
  } catch { /* not JSON — fall through to the raw excerpt */ }
  return content.slice(0, 200);
}

export async function mount(el, params) {
  let disposed = false;
  let playTimer = null;
  let teardownStrip = null;

  await store.loadAgents();
  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const ideathons = all.filter((e) => e.type === "ideathon");
  if (!ideathons.length) {
    render(el, html`<div class="arena-state">No arena has run yet.</div>`);
    return () => {};
  }

  /* A hackathon id on the route (office links there) resolves to its parent
     ideathon — the constellation and replay are both ideathon views. */
  let eventId = params.eventId || ideathons[0].id;
  const direct = all.find((e) => e.id === eventId);
  if (direct && direct.type === "hackathon" && direct.parent_event_id) eventId = direct.parent_event_id;
  const event = all.find((e) => e.id === eventId);
  const parsedStart = parseUtc(event ? event.start_date : null);
  const startMs = parsedStart ? parsedStart.getTime() : null;

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · Arena ${(all.findIndex((e) => e.id === eventId) + 1) || ""}</div>
      <h1>Arena — interactions, read two ways</h1>
      <p>Constellation groups agents by how much they actually interacted, then colours every edge by its kind. Replay re-animates the same map moment by moment.</p>
    </header>
    <div id="ar-strip"></div>
    <div class="v-arena__tabs" role="tablist" aria-label="Arena views">
      <button class="is-active" role="tab" aria-selected="true" data-tab="constellation">Constellation</button>
      <button role="tab" aria-selected="false" data-tab="replay">Replay</button>
    </div>
    <div class="v-arena__layout">
      <div class="v-arena__main">
        <div class="v-arena__legend" id="ar-legend"></div>
        <div class="arena-card v-arena__stage"><svg id="ar-svg"></svg></div>
        <div class="v-arena__phase" id="ar-phase"></div>
        <div class="v-arena__controls" id="ar-controls"></div>
      </div>
      <aside class="v-arena__rail">
        <div class="arena-card v-arena__focus" id="ar-focus"></div>
        <div class="arena-card v-arena__feed" id="ar-feed"></div>
      </aside>
    </div>`);

  const stripEl = el.querySelector("#ar-strip");
  const teardown = () => {
    disposed = true;
    stop();
    if (teardownStrip) teardownStrip();
  };
  teardownStrip = mountArenaStrip(stripEl, { eventId });

  const stage = el.querySelector(".v-arena__stage");
  const legendEl = el.querySelector("#ar-legend");
  const phaseEl = el.querySelector("#ar-phase");
  const controlsEl = el.querySelector("#ar-controls");
  const focusEl = el.querySelector("#ar-focus");
  const feedEl = el.querySelector("#ar-feed");

  /* ---- data ---- */
  const [graphData, timeline, d3] = await Promise.all([
    fetchJson(`/agents/graph?event_id=${encodeURIComponent(eventId)}`, {
      ttl: isTerminal(event) ? FOREVER : 60_000, optional: true,
    }),
    fetchJson(`/events/${encodeURIComponent(eventId)}/timeline`, {
      ttl: isTerminal(event) ? FOREVER : 30_000, optional: true,
    }),
    loadScript("/vendor/d3-7.9.0.min.js").catch(() => null),
  ]);
  if (disposed) return () => {};

  const missing = [];
  if (!d3) missing.push("the graph library");
  if (!graphData) missing.push("the graph data");
  if (!timeline) missing.push("the timeline");
  if (missing.length) {
    const layoutEl = el.querySelector(".v-arena__layout");
    render(layoutEl, html`
      <div class="arena-state arena-state--error">Couldn't load ${missing.join(" and ")}. Reload to retry.</div>`);
    return teardown;
  }

  const { moments, ideaAuthor } = buildMoments(timeline);
  const agentIds = (graphData.nodes || []).map((n) => n.id);
  const edges = graphData.edges || [];
  if (!agentIds.length || !moments.length) {
    render(el.querySelector(".v-arena__layout"), html`
      <div class="arena-state">No interactions recorded for this event yet.</div>`);
    return teardown;
  }

  const meta = new Map((graphData.nodes || []).map((n) => [n.id, n]));
  const ideaList = new Map(agentIds.map((id) => [id, []]));
  for (const row of timeline) {
    if (row.kind === "idea" && ideaList.has(row.agent_id)) {
      ideaList.get(row.agent_id).push({ id: row.id, title: row.title, one_liner: row.one_liner, ts: row.ts });
    }
  }

  const W = stage.clientWidth || 940;
  const H = 540;
  const groups = communities(edges, agentIds);
  const pos = layout(groups, W, H);

  /* Per-agent interaction totals and per-type partner lists, for the rail. */
  const totals = new Map(agentIds.map((id) => [id, { given: 0, received: 0, byType: new Map(), partners: new Set() }]));
  for (const e of edges) {
    const a = totals.get(e.source), b = totals.get(e.target);
    if (a) { a.given += e.weight; a.byType.set(e.type, (a.byType.get(e.type) || 0) + e.weight); a.partners.add(e.target); }
    if (b) { b.received += e.weight; b.byType.set(e.type, (b.byType.get(e.type) || 0) + e.weight); b.partners.add(e.source); }
  }

  /* ---- shared svg scaffold ---- */
  const svg = d3.select(el.querySelector("#ar-svg"))
    .attr("viewBox", `0 0 ${W} ${H}`).attr("width", "100%").attr("height", H);
  const viewport = svg.append("g");

  svg.append("defs").append("marker")
    .attr("id", "ar-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 30)
    .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
    .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "var(--arena-line-strong)");

  const hullG = viewport.append("g").attr("class", "v-arena__hulls");
  const linkG = viewport.append("g").attr("class", "v-arena__links");
  const nodeG = viewport.append("g").attr("class", "v-arena__nodes");
  const flashG = viewport.append("g").attr("class", "v-arena__flashes");

  const nodeSel = nodeG.selectAll("g").data(agentIds, (d) => d).join("g")
    .attr("transform", (id) => `translate(${pos.get(id).x},${pos.get(id).y})`)
    .style("cursor", "pointer");

  const nodeInfo = (id) => {
    const m = meta.get(id) || {};
    const t = totals.get(id) || { given: 0, received: 0 };
    return `${m.name || store.agentName(id)} — ${m.lens || "agent"}\n` +
      `${ideaList.get(id).length} ideas · gave ${t.given}, received ${t.received} interactions`;
  };

  nodeSel.append("circle").attr("r", (id) => 12 + Math.min(12, Math.sqrt(ideaList.get(id).length) * 4))
    .attr("fill", "var(--arena-bg-raised)")
    .attr("stroke", (id) => {
      const m = meta.get(id) || {};
      return m.lens ? "var(--arena-clay)" : "var(--arena-line-strong)";
    })
    .attr("stroke-width", (id) => {
      const t = totals.get(id) || {};
      return Math.min(6, 1.5 + Math.sqrt(t.given + t.received) * 0.55);
    });
  nodeSel.append("title").text(nodeInfo);
  nodeSel.append("text").text((id) => meta.get(id)?.name || store.agentName(id))
    .attr("text-anchor", "middle").attr("dy", 30)
    .attr("fill", "var(--arena-ink-soft)");

  function drawHulls() {
    const pts = groups.map((g) => g.map((id) => [pos.get(id).x, pos.get(id).y]));
    const bounds = pts.map((g) => ({
      g,
      hull: d3.polygonHull(g),
      cx: d3.mean(g, (p) => p[0]),
      cy: d3.mean(g, (p) => p[1]),
    }));
    hullG.selectAll("path").data(bounds, (b) => b.g[0]).join("path")
      .attr("d", (b) => hullPath(d3, b.hull))
      .attr("fill", (b, i) => `var(--arena-hull-${(i % 4) + 1})`)
      .attr("stroke", "var(--arena-line)");
    hullG.selectAll("text").data(bounds, (b) => b.g[0]).join("text")
      .attr("x", (b) => b.cx).attr("y", (b) => b.cy)
      .attr("text-anchor", "middle").attr("dy", "-0.2em")
      .attr("class", "v-arena__hull-label")
      .text((b) => `community of ${b.g.length}`);
  }

  /* ---- Constellation tab ---- */
  const filter = { types: new Set(Object.keys(TYPES)), focus: null };
  let activeTab = "constellation";

  const edgeFor = (e) => ({
    key: `${e.source}|${e.type}|${e.target}`,
    source: pos.get(e.source), target: pos.get(e.target),
    sx: pos.get(e.source).x, sy: pos.get(e.source).y,
    tx: pos.get(e.target).x, ty: pos.get(e.target).y,
    type: e.type, weight: e.weight,
    label: `${meta.get(e.source)?.name || e.source} ${(TYPES[e.type] || TYPE_OTHER).label} ${meta.get(e.target)?.name || e.target} ×${e.weight}`,
  });

  let linkSel = linkG.selectAll("line").data(edges.map(edgeFor), (d) => d.key).join("line");
  function styleLinks() {
    linkSel.attr("stroke", (d) => (TYPES[d.type] || TYPE_OTHER).color)
      .attr("stroke-width", (d) => (TYPES[d.type] || TYPE_OTHER).weight * Math.min(4, 1 + Math.sqrt(d.weight) * 0.7))
      .attr("stroke-dasharray", (d) => (TYPES[d.type] || TYPE_OTHER).dash || null)
      .attr("stroke-opacity", (d) => (filter.focus ? (d.type === "critique" ? 0.8 : 0.95) : Math.min(0.9, 0.3 + d.weight * 0.08)))
      .attr("marker-end", (d) => (d.type === "critique" ? "url(#ar-arrow)" : null));
    linkSel.selectAll("title").data((d) => [d]).join("title").text((d) => d.label);
  }
  styleLinks();

  function applyFilter() {
    const { types, focus } = filter;
    const visible = edges.filter((e) => types.has(e.type) && (!focus || e.source === focus || e.target === focus));
    linkSel = linkG.selectAll("line").data(visible.map(edgeFor), (d) => d.key).join("line");
    styleLinks();
    const partners = focus ? totals.get(focus)?.partners : null;
    nodeSel.classed("is-dim", (id) => !!focus && id !== focus && !partners?.has(id));
  }

  /* Node clicks read the story rail in both tabs, but focus-dimming and
     edge filtering only make sense in Constellation — during Replay the
     link layer belongs to the playback, not the filter. */
  nodeSel.on("click", (event, id) => {
    event.stopPropagation();
    if (activeTab !== "constellation") { drawFocus(id); return; }
    filter.focus = filter.focus === id ? null : id;
    applyFilter();
    drawFocus(id);
  });
  svg.on("click", () => {
    if (activeTab !== "constellation" || !filter.focus) return;
    filter.focus = null;
    applyFilter();
    drawFocus(null);
  });

  const zoom = d3.zoom().scaleExtent([0.3, 4]);
  zoom.on("zoom", (event) => viewport.attr("transform", event.transform));
  svg.call(zoom);

  function legend() {
    const counts = new Map(Object.keys(TYPES).map((t) => [t, 0]));
    for (const e of edges) counts.set(e.type, (counts.get(e.type) || 0) + e.weight);
    render(legendEl, html`
      <div class="v-arena__legend-row">
        ${Object.keys(TYPES).map((t) => html`
          <button class="v-arena__chip ${counts.get(t) ? "" : "is-empty"}" data-type="${t}" aria-pressed="true">
            <i style="background:${TYPES[t].color}"></i>${t.replace(/_/g, " ")}
            <span class="v-arena__chip-count" data-count="${t}">${counts.get(t) || "—"}</span>
          </button>`)}
        <span class="v-arena__count">${agentIds.length} agents · ${groups.length} communities · ${moments.length} moments</span>
      </div>`);
    for (const btn of legendEl.querySelectorAll(".v-arena__chip")) {
      const t = btn.dataset.type;
      btn.addEventListener("click", () => {
        if (filter.types.has(t) && filter.types.size === 1) return;
        if (filter.types.has(t)) filter.types.delete(t); else filter.types.add(t);
        btn.setAttribute("aria-pressed", filter.types.has(t));
        btn.classList.toggle("is-off", !filter.types.has(t));
        applyFilter();
      });
    }
  }

  function drawFocus(id) {
    if (!id) {
      render(focusEl, html`<div class="v-arena__focus-empty">Click an agent to read its story.</div>`);
      return;
    }
    const m = meta.get(id) || {};
    const t = totals.get(id) || { given: 0, received: 0 };
    const ideas = ideaList.get(id) || [];
    const typeRows = [...t.byType.entries()].sort((a, b) => b[1] - a[1]);
    render(focusEl, html`
      <div class="v-arena__focus-head">
        <b>${m.name || store.agentName(id)}</b>
        <span>${m.lens || ""}</span>
      </div>
      <dl class="v-arena__focus-stats">
        <div><dt>ideas</dt><dd>${ideas.length}</dd></div>
        <div><dt>given</dt><dd>${t.given}</dd></div>
        <div><dt>received</dt><dd>${t.received}</dd></div>
        <div><dt>partners</dt><dd>${t.partners.size}</dd></div>
      </dl>
      ${ideas.length ? html`
        <div class="arena-section-label">Ideas</div>
        <ul class="v-arena__ideas">
          ${ideas.map((i) => html`<li><b>${i.title}</b>${i.one_liner ? html`<small>${i.one_liner}</small>` : ""}</li>`)}
        </ul>` : ""}
      ${typeRows.length ? html`
        <div class="arena-section-label">Interactions</div>
        <ul class="v-arena__type-list">
          ${typeRows.map(([t, n]) => html`<li><i style="background:${(TYPES[t] || TYPE_OTHER).color}"></i>${t.replace(/_/g, " ")} <span>${n}</span></li>`)}
        </ul>` : ""}`);
  }

  drawHulls();
  legend();
  drawFocus(null);
  applyFilter();

  /* ---- Replay tab ---- */
  let rIndex = -1;
  const rVisible = new Set();
  const rNodeAlpha = new Map(agentIds.map((id) => [id, 0]));

  function applyReplay() {
    rVisible.clear();
    for (let i = 0; i <= rIndex && i < moments.length; i++) {
      const m = moments[i];
      if (m.kind === "idea") rNodeAlpha.set(m.agentId, 1);
      else rVisible.add(edgeKey(m));
    }
    const current = moments[rIndex] || null;

    const shown = [...rVisible].map((key) => {
      const m = moments.find((x) => edgeKey(x) === key);
      const isCurrent = current && key === edgeKey(current);
      return {
        key, m,
        sx: pos.get(m.agentId).x, sy: pos.get(m.agentId).y,
        tx: pos.get(m.targetId).x, ty: pos.get(m.targetId).y,
        isCurrent,
      };
    });
    const cur = shown.find((s) => s.isCurrent);

    linkG.selectAll("line").data(shown, (d) => d.key).join("line")
      .attr("stroke", (d) => (TYPES[d.m.type] || TYPE_OTHER).color)
      .attr("stroke-width", (d) => (TYPES[d.m.type] || TYPE_OTHER).weight * (d.isCurrent ? 2.6 : 1))
      .attr("stroke-dasharray", (d) => (TYPES[d.m.type] || TYPE_OTHER).dash || null)
      .attr("stroke-opacity", (d) => (d.isCurrent ? 1 : 0.55))
      .attr("marker-end", (d) => (d.m.type === "critique" ? "url(#ar-arrow)" : null));

    flashG.selectAll("circle").data(cur ? [cur] : []).join("circle")
      .attr("cx", (d) => d.tx).attr("cy", (d) => d.ty)
      .attr("r", 16).attr("fill", "none")
      .attr("stroke", "var(--arena-gold)").attr("stroke-width", 2)
      .attr("class", "v-arena__flash");

    nodeSel.attr("opacity", (id) => rNodeAlpha.get(id) || 0);
    nodeSel.classed("is-live", (id) => current && (current.agentId === id || current.targetId === id));
    nodeSel.classed("is-dim", false);

    drawPhase(current);
    drawControls();
    drawFeed(current);
  }

  function drawPhase(current) {
    if (!startMs) { render(phaseEl, ""); return; }
    const day = current ? DAY(new Date(String(current.ts).replace(" ", "T") + "Z") - startMs) : 0;
    const spans = PHASE_SPANS.map((p) => ({ ...p, active: day >= p.from && day < p.to }));
    render(phaseEl, html`
      <div class="v-arena__phase-bar" role="img" aria-label="Event day ${day} of 8">
        ${spans.map((p) => html`
          <div class="v-arena__phase-seg ${p.active ? "is-active" : ""}" style="flex:${p.to - p.from}">
            <span>${p.label}</span>
            <i style="left:${Math.max(0, Math.min(100, ((day - p.from) / (p.to - p.from)) * 100))}%"></i>
          </div>`)}
      </div>`);
  }

  function drawControls() {
    render(controlsEl, html`
      <div class="v-arena__bar">
        <button class="arena-btn arena-btn--sm arena-btn--ghost" id="ar-play" aria-label="Play">▶</button>
        <button class="arena-btn arena-btn--sm arena-btn--ghost" id="ar-back" aria-label="Step back">←</button>
        <button class="arena-btn arena-btn--sm arena-btn--ghost" id="ar-fwd" aria-label="Step forward">→</button>
        <input type="range" id="ar-range" min="0" max="${moments.length - 1}" value="${Math.max(0, rIndex)}" aria-label="Timeline position" />
        <span class="v-arena__pos">${rIndex + 1} / ${moments.length}</span>
      </div>`);
    const range = controlsEl.querySelector("#ar-range");
    const playBtn = controlsEl.querySelector("#ar-play");
    range.addEventListener("input", () => { stop(); goTo(parseInt(range.value, 10), false); });
    playBtn.addEventListener("click", () => (playTimer ? stop() : play()));
    controlsEl.querySelector("#ar-back").addEventListener("click", () => { stop(); goTo(rIndex - 1, false); });
    controlsEl.querySelector("#ar-fwd").addEventListener("click", () => { stop(); goTo(rIndex + 1, false); });
  }

  function stop() {
    clearInterval(playTimer);
    playTimer = null;
    const b = controlsEl.querySelector("#ar-play");
    if (b) { b.textContent = "▶"; b.setAttribute("aria-label", "Play"); }
  }

  function play() {
    const b = controlsEl.querySelector("#ar-play");
    b.textContent = "❚❚"; b.setAttribute("aria-label", "Pause");
    playTimer = setInterval(() => {
      if (rIndex + 1 >= moments.length) return stop();
      goTo(rIndex + 1, false);
    }, STEP_MS);
  }

  function goTo(i, scroll = true) {
    if (!moments.length) return;
    rIndex = Math.max(0, Math.min(moments.length - 1, i));
    applyReplay();
    if (scroll) {
      const active = feedEl.querySelector(".is-active");
      if (active && feedEl) feedEl.scrollTop = active.offsetTop - feedEl.clientHeight / 2;
    }
  }

  function drawFeed(current) {
    render(feedEl, html`
      <div class="arena-section-label">Timeline</div>
      <div class="v-arena__feed-list">
        ${moments.map((m, i) => {
          const name = store.agentName(m.agentId);
          const kind = m.kind === "idea" ? "Idea submitted" : (TYPES[m.type] || TYPE_OTHER).label;
          const text = m.kind === "idea"
            ? `${m.title}${m.text ? " — " + m.text : ""}`
            : summarizeInteraction(m.text);
          return html`
            <div class="v-arena__feed-item ${i === rIndex ? "is-active" : i < rIndex ? "is-past" : ""}"
                 data-feed-index="${i}" role="button" tabindex="0">
              <div class="v-arena__feed-kind">${kind} · ${(m.ts || "").slice(0, 16).replace("T", " ")}</div>
              <div class="v-arena__feed-title">${name}${m.targetId ? html` → ${store.agentName(m.targetId)}` : ""}</div>
              ${text ? html`<div class="v-arena__feed-text">${text}</div>` : ""}
            </div>`;
        })}
      </div>`);
    for (const item of feedEl.querySelectorAll(".v-arena__feed-item")) {
      item.addEventListener("click", () => { stop(); goTo(parseInt(item.dataset.feedIndex, 10)); });
    }
  }

  function showReplay() {
    filter.focus = null;
    render(focusEl, "");
    render(phaseEl, "");
    linkG.selectAll("line").remove();
    nodeSel.attr("opacity", 0);
    goTo(Math.max(0, rIndex));
  }

  function showConstellation() {
    stop();
    flashG.selectAll("*").remove();
    render(phaseEl, "");
    render(controlsEl, "");
    render(feedEl, "");
    nodeSel.attr("opacity", 1).classed("is-live", false);
    drawHulls();
    applyFilter();
    drawFocus(filter.focus);
  }

  for (const tab of el.querySelectorAll(".v-arena__tabs button")) {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab === "replay" ? "replay" : "constellation";
      el.querySelectorAll(".v-arena__tabs button").forEach((b) => {
        b.classList.toggle("is-active", b === tab);
        b.setAttribute("aria-selected", b === tab ? "true" : "false");
      });
      if (activeTab === "replay") showReplay(); else showConstellation();
    });
  }

  showConstellation();

  return teardown;
}
