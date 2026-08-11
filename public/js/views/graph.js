/**
 * Agent Graph — who critiqued and collaborated with whom, made legible.
 *
 * The first version drew every interaction as a thin 1.4px arrow, so an
 * ideathon's ~100 critiques collapsed into a solid hairball and the rare
 * collaboration edges were invisible under them. This redesign fixes the
 * encoding rather than the layout:
 *
 *  - Multi-edges are aggregated per (source, type, target); line width and
 *    opacity carry volume, not identity.
 *  - Interaction types are toggleable chips, not just a legend — filtering
 *    out critiques leaves the collaboration story readable on its own.
 *  - Clicking an agent enters "focus mode": only its interactions stay
 *    visible, everything else dims. Click again (or anywhere else) to leave.
 *  - Every edge and node carries a native tooltip with real counts.
 *
 * d3 is vendored under /vendor rather than pulled from a CDN: `integrity`
 * cannot be applied to a dynamic import(), so importing it as a module would
 * have silently dropped SRI. Loading it as a classic script keeps the
 * guarantee, and self-hosting removes the CDN as a dependency entirely.
 *
 * The force simulation MUST be stopped on teardown — otherwise it keeps
 * ticking behind whatever view you navigate to.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { loadScript } from "../core/assets.js";
import { mountArenaStrip } from "../core/arena-strip.js";
import * as store from "../core/store.js";
import { isTerminal } from "../core/model.js";

const EDGE_COLORS = {
  critique: "var(--arena-chart-1)",
  merge: "var(--arena-chart-2)",
  propose_collaboration: "var(--arena-chart-3)",
  collaboration_refused: "var(--arena-chart-5)",
};

const EDGE_LABELS = {
  critique: "critiqued",
  merge: "merged with",
  propose_collaboration: "proposed collaborating with",
  collaboration_refused: "refused to collaborate with",
};

const WIDTH_MAX = 8;

const MAX_GRAPH_RETRIES = 3;
let graphRetries = 0;

/* Per (source, type, target) aggregation so volume is encoding, not noise. */
function aggregate(raw) {
  const map = new Map();
  for (const e of raw) {
    const key = `${e.source}|${e.type}|${e.target}`;
    const hit = map.get(key) || { source: e.source, target: e.target, type: e.type, count: 0 };
    hit.count++;
    map.set(key, hit);
  }
  return [...map.values()].map((e) => ({
    ...e,
    width: Math.min(WIDTH_MAX, 1 + 1.9 * Math.sqrt(e.count)),
    opacity: Math.min(0.85, 0.35 + e.count * 0.07),
  }));
}

const edgeKey = (d) => `${d.source}|${d.type}|${d.target}`;

export async function mount(el, params) {
  let disposed = false;
  let sim = null;
  let teardownStrip = null;
  let currentEventId = params.eventId || null;

  await store.loadAgents();
  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const ideathons = all.filter((e) => e.type === "ideathon");

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §11</div>
      <h1>Agent Graph</h1>
      <p>Who critiqued and collaborated with whom. Thicker lines mean more interactions, chips below toggle interaction types, and clicking an agent isolates its story.</p>
    </header>
    <div id="gr-strip"></div>
    <div id="gr-body"><div class="arena-state">Loading the graph…</div></div>`);

  const body = el.querySelector("#gr-body");
  const stripEl = el.querySelector("#gr-strip");

  function remountStrip(eventId) {
    if (teardownStrip) { teardownStrip(); teardownStrip = null; }
    if (stripEl) teardownStrip = eventId ? mountArenaStrip(stripEl, { eventId }) : mountArenaStrip(stripEl);
  }

  async function refetch(eventId) {
    if (disposed || eventId === null || eventId === undefined) return;
    if (sim) { sim.stop(); sim = null; }
    render(body, html`<div class="arena-state">Loading the graph…</div>`);
    await draw(body, eventId, false);
  }

  async function draw(bodyEl, eventId, isInitial) {
    if (disposed) return;
    if (!eventId) {
      render(bodyEl, html`<div class="arena-state">No ideathon has run yet.</div>`);
      return;
    }

    const [data, d3] = await Promise.all([
      fetchJson(`/agents/graph?event_id=${encodeURIComponent(eventId)}`, {
        ttl: isTerminal(all.find((e) => e.id === eventId)) ? FOREVER : 60_000, optional: true,
      }),
      loadScript("/vendor/d3-7.9.0.min.js").catch(() => null),
    ]);
    if (disposed) return;

    if (!data || !d3) {
      // Say WHICH dependency failed — "library" means the vendored d3 script
      // tag errored, anything else means the graph payload didn't arrive.
      // Retry with backoff: loadScript no longer caches its rejections, so a
      // transient failure heals instead of bricking the view for the session.
      render(bodyEl, html`<div class="arena-state arena-state--error">
        Couldn't load the graph ${d3 ? "data" : "library"} — retrying automatically.
      </div>`);
      if (isInitial && graphRetries < MAX_GRAPH_RETRIES) {
        const backoff = 3000 * Math.pow(2, graphRetries++);
        setTimeout(() => { if (!disposed) refetch(eventId); }, backoff);
      } else if (isInitial && !disposed) {
        render(bodyEl, html`<div class="arena-state arena-state--error">
          Couldn't load the graph ${d3 ? "data" : "library"}. Reload the page to try again.
        </div>`);
      }
      if (!isInitial) remountStrip(eventId);
      return;
    }
    graphRetries = 0;

    const nodes = (data.nodes || []).map((n) => ({ id: n.id, name: n.name }));
    const edges = aggregate(data.edges || []);
    if (!nodes.length) {
      render(bodyEl, html`<div class="arena-state">No interactions recorded for this event.</div>`);
      if (isInitial) return;
      remountStrip(eventId);
      return;
    }

    // Focus-mode adjacency and per-agent in/out counts for tooltips. Both
    // derived from the AGGREGATED edges so counts in the UI always match the
    // widths on screen.
    const partners = new Map(nodes.map((n) => [n.id, new Set()]));
    const inCount = new Map(), outCount = new Map();
    for (const e of edges) {
      outCount.set(e.source, (outCount.get(e.source) || 0) + e.count);
      inCount.set(e.target, (inCount.get(e.target) || 0) + e.count);
      partners.get(e.source)?.add(e.target);
      partners.get(e.target)?.add(e.source);
    }

    render(bodyEl, html`
      <div class="v-graph__legend">
        ${Object.keys(EDGE_COLORS).map((k) => html`
          <button class="v-graph__legend-item v-graph__toggle" data-type="${k}" aria-pressed="true">
            <i style="background:${EDGE_COLORS[k]}"></i>${k.replace(/_/g, " ")}
            <span class="v-graph__toggle-count" data-count="${k}"></span>
          </button>`)}
        <span class="v-graph__count">${nodes.length} agents · ${edges.reduce((s, e) => s + e.count, 0)} interactions</span>
      </div>
      <div class="arena-card v-graph__stage"><svg id="gr-svg"></svg></div>
      <p class="v-graph__hint" id="gr-hint">Drag nodes to rearrange · scroll to zoom · click an agent to isolate it</p>`);

    const stage = bodyEl.querySelector(".v-graph__stage");
    if (!stage || !bodyEl.isConnected) return;
    const W = stage.clientWidth || 900;
    const H = 560;

    const svg = d3.select(bodyEl.querySelector("#gr-svg"))
      .attr("viewBox", `0 0 ${W} ${H}`).attr("width", "100%").attr("height", H);
    const viewport = svg.append("g");

    svg.append("defs").append("marker")
      .attr("id", "gr-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 26)
      .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
      .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "var(--arena-line-strong)");

    const linkG = viewport.append("g");
    const nodeG = viewport.append("g");

    let linkSel = linkG.selectAll("line").data(edges, edgeKey).join("line");
    linkSel.attr("stroke", (d) => EDGE_COLORS[d.type] || "var(--arena-line-strong)")
      .attr("stroke-width", (d) => d.width)
      .attr("stroke-opacity", (d) => d.opacity)
      .attr("marker-end", "url(#gr-arrow)");
    linkSel.selectAll("title").data((d) => [d]).join("title")
      .text((d) => `${d.source} → ${d.target}: ${EDGE_LABELS[d.type] || d.type} ×${d.count}`);

    const nodeSel = nodeG.selectAll("g").data(nodes, (d) => d.id).join("g").style("cursor", "pointer");
    nodeSel.append("circle").attr("r", 17)
      .attr("fill", "var(--arena-bg-raised)")
      .attr("stroke", "var(--arena-clay)")
      .attr("stroke-width", (d) => Math.min(5, 2 + Math.sqrt((outCount.get(d.id) || 0) + (inCount.get(d.id) || 0))));
    nodeSel.append("text").text((d) => d.name)
      .attr("text-anchor", "middle").attr("dy", 32)
      .attr("font-family", "var(--arena-font-mono)").attr("font-size", 11)
      .attr("fill", "var(--arena-ink-soft)");
    nodeSel.append("title").text((d) =>
      `${d.name} — gave ${outCount.get(d.id) || 0} interactions, received ${inCount.get(d.id) || 0}`);

    const filter = { types: new Set(Object.keys(EDGE_COLORS)), focus: null };

    function applyFilter() {
      const { types, focus } = filter;
      const visible = edges.filter((e) =>
        types.has(e.type) && (!focus || e.source === focus || e.target === focus));
      linkSel = linkG.selectAll("line").data(visible, edgeKey).join("line");
      linkSel.attr("stroke", (d) => EDGE_COLORS[d.type] || "var(--arena-line-strong)")
        .attr("stroke-width", (d) => d.width)
        .attr("stroke-opacity", (d) => (focus ? 0.9 : d.opacity))
        .attr("marker-end", (d) => (focus ? null : "url(#gr-arrow)"));
      linkSel.selectAll("title").data((d) => [d]).join("title")
        .text((d) => `${d.source} → ${d.target}: ${EDGE_LABELS[d.type] || d.type} ×${d.count}`);

      nodeSel.classed("is-dim", (d) => !!focus && d.id !== focus && !partners.get(d.id)?.has(focus));
      if (sim) sim.alpha(0.5).restart();
    }

    sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(edges).id((d) => d.id).distance(130).strength(0.35))
      .force("charge", d3.forceManyBody().strength(-420))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide(38))
      .on("tick", () => {
        linkSel.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
        nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    nodeSel.call(d3.drag()
      .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end", (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    const zoom = d3.zoom().scaleExtent([0.25, 5]);
    zoom.on("zoom", (event) => viewport.attr("transform", event.transform));
    svg.call(zoom);
    nodeSel.on("dblclick.zoom", null); // nodes don't zoom on double-click

    const setHint = (msg) => {
      const hint = bodyEl.querySelector("#gr-hint");
      if (hint) hint.textContent = msg;
    };

    nodeSel.on("click", (event, d) => {
      event.stopPropagation();
      filter.focus = filter.focus === d.id ? null : d.id;
      setHint(filter.focus
        ? `Focus: ${d.name} — click again or click the stage to release`
        : `Drag nodes to rearrange · scroll to zoom · click an agent to isolate it`);
      applyFilter();
    });
    svg.on("click", () => {
      if (!filter.focus) return;
      filter.focus = null;
      setHint(`Drag nodes to rearrange · scroll to zoom · click an agent to isolate it`);
      applyFilter();
    });

    for (const btn of bodyEl.querySelectorAll(".v-graph__toggle")) {
      const type = btn.dataset.type;
      const n = edges.filter((e) => e.type === type).reduce((s, e) => s + e.count, 0);
      btn.querySelector(`[data-count="${type}"]`).textContent = n > 0 ? n : "—";
      btn.addEventListener("click", () => {
        if (filter.types.has(type) && filter.types.size === 1) return; // never allow zero types
        if (filter.types.has(type)) filter.types.delete(type); else filter.types.add(type);
        btn.setAttribute("aria-pressed", filter.types.has(type));
        btn.classList.toggle("is-off", !filter.types.has(type));
        applyFilter();
      });
    }

    if (currentEventId !== eventId || !isInitial) remountStrip(eventId);
  }

  currentEventId = null;
  await draw(body, params.eventId || (ideathons[0] && ideathons[0].id) || null, true);

  return () => {
    disposed = true;
    // Without this the simulation keeps ticking against detached DOM.
    if (sim) sim.stop();
    if (teardownStrip) teardownStrip();
  };
}