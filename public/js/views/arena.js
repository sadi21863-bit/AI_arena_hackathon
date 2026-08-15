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
const PHASE_SPANS = [
  { id: "deep_research",     label: "Research",  from: 0, to: 2 },
  { id: "ideation_critique", label: "Ideation",  from: 2, to: 3 },
  { id: "collaboration",     label: "Collab",    from: 3, to: 4 },
  { id: "architecture",      label: "Arch",      from: 4, to: 6 },
  { id: "ready_for_judging", label: "Judging",   from: 6, to: 8 },
];

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

  nodeSel.attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", (id) => nodeInfo(id).replace(/\n/g, ", "));

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
  /* Keyboard parity with the click handler above — the nodes are
     focusable (tabindex=0), so Enter/Space must activate them too, else
     a keyboard-only user can tab to an agent but never read its story. */
  nodeSel.on("keydown", (event, id) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
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

    /* While scrubbing, the controls MUST not re-render: drawControls()
       replaces the track element, which drops the pointer capture and
       cancels the drag mid-swipe. Update chrome in place instead. */
    if (!dragging) drawControls();
    drawPhase(current);
    drawFeed(current);
  }

  /* Time scale: moments positioned by REAL timestamp, so the track's density
     marks show the arena's actual pacing — the dead quiet of day 1's
     research versus the critique burst of days 2-3. */
  const momentMs = moments.map((m) => new Date(String(m.ts).replace(" ", "T") + "Z").getTime());
  const tMin = Math.min(...momentMs);
  const tMax = Math.max(...momentMs);
  const fracOf = (i) => (tMax === tMin ? 0 : (momentMs[i] - tMin) / (tMax - tMin));
  const dayOf = (ms) => (startMs ? Math.floor((ms - startMs) / DAY_MS) : 0);
  let speed = 1;
  let dragging = false;
  const RING_C = 2 * Math.PI * 21;

  function drawPhase(current) {
    const readout = controlsEl.querySelector("#ar-readout");
    const track = controlsEl.querySelector("#ar-track");
    if (!readout) return;
    if (!current) { readout.textContent = ""; return; }
    const day = dayOf(momentMs[rIndex]);
    const span = PHASE_SPANS.find((p) => day >= p.from && day < p.to) || PHASE_SPANS[PHASE_SPANS.length - 1];
    const name = store.agentName(current.agentId);
    const target = current.targetId ? store.agentName(current.targetId) : "";
    const what = current.kind === "idea"
      ? `${name} submitted an idea`
      : `${name} → ${target} · ${(TYPES[current.type] || TYPE_OTHER).label}`;
    readout.textContent = `Day ${Math.max(0, day)} · ${span.label} — ${what} · ${rIndex + 1} / ${moments.length}`;
    if (track) track.setAttribute("aria-valuenow", String(rIndex));
  }

  function drawControls() {
    render(controlsEl, html`
      <div class="v-arena__transport">
        <button class="arena-btn arena-btn--sm arena-btn--ghost" id="ar-to-start" aria-label="Jump to start">⏮</button>
        <button class="arena-btn arena-btn--sm arena-btn--ghost" id="ar-back" aria-label="Step back">−1</button>
        <button class="v-arena__play" id="ar-play" aria-label="Play">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <circle class="v-arena__ring-track" cx="24" cy="24" r="21"></circle>
            <circle class="v-arena__ring-fill" id="ar-ring" cx="24" cy="24" r="21"></circle>
            <path class="v-arena__glyph v-arena__glyph-play" d="M19 15 L35 24 L19 33 Z"></path>
            <path class="v-arena__glyph v-arena__glyph-pause" d="M18 15 L23 15 L23 33 L18 33 Z M25 15 L30 15 L30 33 L25 33 Z"></path>
          </svg>
        </button>
        <button class="arena-btn arena-btn--sm arena-btn--ghost" id="ar-fwd" aria-label="Step forward">+1</button>
        <button class="arena-btn arena-btn--sm arena-btn--ghost" id="ar-to-end" aria-label="Skip to end">⏭</button>
        <div class="v-arena__speed" role="group" aria-label="Playback speed">
          <button data-speed="1" class="is-active" aria-pressed="true">1×</button>
          <button data-speed="2" aria-pressed="false">2×</button>
          <button data-speed="4" aria-pressed="false">4×</button>
        </div>
      </div>
      <div class="v-arena__readout" id="ar-readout" aria-live="polite"></div>
      <div class="v-arena__track" id="ar-track" tabindex="0" role="slider" aria-label="Timeline"
           aria-valuemin="0" aria-valuemax="${moments.length - 1}" aria-valuenow="0">
        <div class="v-arena__track-phases" aria-hidden="true">
          ${PHASE_SPANS.map((p) => html`
            <div class="v-arena__track-phase" style="left:${(p.from / 8) * 100}%;width:${((p.to - p.from) / 8) * 100}%"><span>${p.label}</span></div>`)}
        </div>
        <div class="v-arena__track-ticks" aria-hidden="true">
          ${moments.map((m, i) => html`<i style="left:${fracOf(i) * 100}%"></i>`)}
        </div>
        <div class="v-arena__playhead" id="ar-playhead"><i></i></div>
      </div>`);

    const track = controlsEl.querySelector("#ar-track");
    const playBtn = controlsEl.querySelector("#ar-play");
    playBtn.addEventListener("click", () => (playTimer ? stop() : play()));
    controlsEl.querySelector("#ar-to-start").addEventListener("click", () => { stop(); goTo(0, false); });
    controlsEl.querySelector("#ar-back").addEventListener("click", () => { stop(); goTo(rIndex - 1, false); });
    controlsEl.querySelector("#ar-fwd").addEventListener("click", () => { stop(); goTo(rIndex + 1, false); });
    controlsEl.querySelector("#ar-to-end").addEventListener("click", () => { stop(); goTo(moments.length - 1, false); });
    for (const btn of controlsEl.querySelectorAll(".v-arena__speed button")) {
      btn.addEventListener("click", () => {
        speed = parseInt(btn.dataset.speed, 10);
        controlsEl.querySelectorAll(".v-arena__speed button").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        if (playTimer) { stop(); play(); }
      });
    }

    /* Click-and-drag scrubbing straight on the track. */
    function seekTo(clientX) {
      const rect = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = tMin + frac * (tMax - tMin);
      let best = 0, bestDiff = Infinity;
      for (let i = 0; i < moments.length; i++) {
        const d = Math.abs(momentMs[i] - target);
        if (d < bestDiff) { bestDiff = d; best = i; }
      }
      stop();
      goTo(best, false);
    }
    track.addEventListener("pointerdown", (e) => {
      dragging = true;
      seekTo(e.clientX);
      track.setPointerCapture(e.pointerId);
      const move = (ev) => { if (ev.buttons) seekTo(ev.clientX); };
      const up = () => {
        dragging = false;
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
    });
    track.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); stop(); goTo(rIndex - 1, false); }
      if (e.key === "ArrowRight") { e.preventDefault(); stop(); goTo(rIndex + 1, false); }
    });

    updatePlayhead();
  }

  function updatePlayhead() {
    const playhead = controlsEl.querySelector("#ar-playhead");
    const ring = controlsEl.querySelector("#ar-ring");
    const track = controlsEl.querySelector("#ar-track");
    if (playhead) playhead.style.left = `${fracOf(rIndex) * 100}%`;
    if (ring) {
      const progress = moments.length > 1 ? rIndex / (moments.length - 1) : 1;
      ring.style.strokeDashoffset = String(RING_C * (1 - progress));
    }
    if (track) track.setAttribute("aria-valuenow", String(Math.max(0, rIndex)));
  }

  function stop() {
    clearInterval(playTimer);
    playTimer = null;
    const b = controlsEl.querySelector("#ar-play");
    if (b) { b.classList.remove("is-playing"); b.setAttribute("aria-label", "Play"); }
  }

  function play() {
    const b = controlsEl.querySelector("#ar-play");
    b.classList.add("is-playing");
    b.setAttribute("aria-label", "Pause");
    playTimer = setInterval(() => {
      if (rIndex + 1 >= moments.length) return stop();
      goTo(rIndex + 1, false);
    }, STEP_MS / speed);
  }

  function goTo(i, scroll = true) {
    if (!moments.length) return;
    rIndex = Math.max(0, Math.min(moments.length - 1, i));
    applyReplay();
    updatePlayhead();
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
      item.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        stop();
        goTo(parseInt(item.dataset.feedIndex, 10));
      });
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

  const tabButtons = () => [...el.querySelectorAll(".v-arena__tabs button")];
  const activateTab = (tab) => {
    activeTab = tab.dataset.tab === "replay" ? "replay" : "constellation";
    tabButtons().forEach((b) => {
      b.classList.toggle("is-active", b === tab);
      b.setAttribute("aria-selected", b === tab ? "true" : "false");
    });
    if (activeTab === "replay") showReplay(); else showConstellation();
  };
  for (const tab of tabButtons()) {
    tab.addEventListener("click", () => activateTab(tab));
    /* Arrow keys move between tabs per the ARIA tabs pattern — otherwise
       each tab is a separate Tab stop and the Replay/Constellation switch
       is unusable from the keyboard beyond clicking. */
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tabs = tabButtons();
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      e.preventDefault();
      next.focus();
      activateTab(next);
    });
  }

  showConstellation();

  return teardown;
}
