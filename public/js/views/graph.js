/**
 * Agent Graph — who critiqued and collaborated with whom.
 *
 * First view with a third-party dependency and a long-lived simulation. d3 is
 * vendored under /vendor rather than pulled from a CDN: `integrity` cannot be
 * applied to a dynamic import(), so importing it as a module would have
 * silently dropped SRI. Loading it as a classic script keeps the guarantee,
 * and self-hosting removes the CDN as a dependency entirely.
 *
 * The force simulation MUST be stopped on teardown — otherwise it keeps
 * ticking behind whatever view you navigate to.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { href, navigate } from "../core/router.js";
import { loadScript } from "../core/assets.js";
import * as store from "../core/store.js";
import { isTerminal } from "../core/model.js";
import { shortId } from "../core/fmt.js";

const EDGE_COLORS = {
  critique: "var(--arena-chart-1)",
  merge: "var(--arena-chart-2)",
  propose_collaboration: "var(--arena-chart-3)",
  collaboration_refused: "var(--arena-chart-5)",
};

export async function mount(el, params) {
  let disposed = false;
  let sim = null;

  await store.loadAgents();
  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const ideathons = all.filter((e) => e.type === "ideathon");
  const eventId = params.eventId || (ideathons[0] && ideathons[0].id);

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §11</div>
      <h1>Agent Graph</h1>
      <p>The social record of one ideathon: who critiqued whom, and which merges were proposed, accepted, or refused. Drag a node to pull the layout apart.</p>
    </header>
    <div class="arena-picker">
      <label for="gr-event">Ideathon</label>
      <select class="arena-select" id="gr-event">
        ${ideathons.length
          ? ideathons.map((e) => html`<option value="${e.id}" ${e.id === eventId ? "selected" : ""}>${shortId(e.id, 18)} · ${e.status}</option>`)
          : html`<option>No ideathon events yet</option>`}
      </select>
      <a class="arena-btn arena-btn--sm arena-btn--ghost" href="${href("/live")}">← Live</a>
    </div>
    <div id="gr-body"><div class="arena-state">Loading the graph…</div></div>`);

  const body = el.querySelector("#gr-body");
  const picker = el.querySelector("#gr-event");
  if (picker) picker.addEventListener("change", () => navigate(`/graph/${picker.value}`));

  if (!eventId) {
    render(body, html`<div class="arena-state">No ideathon has run yet.</div>`);
    return () => { disposed = true; };
  }

  const owner = all.find((e) => e.id === eventId);
  const [data] = await Promise.all([
    fetchJson(`/agents/graph?event_id=${encodeURIComponent(eventId)}`, {
      ttl: isTerminal(owner) ? FOREVER : 60_000, optional: true,
    }),
    loadScript("/vendor/d3-7.9.0.min.js").catch(() => null),
  ]);
  if (disposed) return () => {};

  const d3 = window.d3;
  if (!data || !d3) {
    render(body, html`<div class="arena-state arena-state--error">Couldn't load the graph${d3 ? "" : " library"}.</div>`);
    return () => { disposed = true; };
  }

  const nodes = (data.nodes || []).map((n) => ({ id: n.id, name: n.name }));
  const edges = (data.edges || []).map((e) => ({ ...e }));
  if (!nodes.length) {
    render(body, html`<div class="arena-state">No interactions recorded for this event.</div>`);
    return () => { disposed = true; };
  }

  render(body, html`
    <div class="v-graph__legend">
      ${Object.keys(EDGE_COLORS).map((k) => html`
        <span class="v-graph__legend-item"><i style="background:${EDGE_COLORS[k]}"></i>${k.replace(/_/g, " ")}</span>`)}
      <span class="v-graph__legend-item v-graph__count">${nodes.length} agents · ${edges.length} interactions</span>
    </div>
    <div class="arena-card v-graph__stage"><svg id="gr-svg"></svg></div>`);

  // Navigating away mid-mount (d3 is ~280KB) replaces the outlet, so this
  // can be gone by now — bail rather than crash on a detached tree.
  const stage = el.querySelector(".v-graph__stage");
  if (!stage || !el.isConnected) return () => { disposed = true; };
  const W = stage.clientWidth || 900;
  const H = 560;

  const svg = d3.select("#gr-svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", "100%").attr("height", H);

  svg.append("defs").append("marker")
    .attr("id", "gr-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 26)
    .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
    .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "var(--arena-line-strong)");

  const link = svg.append("g").selectAll("line").data(edges).join("line")
    .attr("stroke", (d) => EDGE_COLORS[d.type] || "var(--arena-line-strong)")
    .attr("stroke-width", 1.4).attr("stroke-opacity", 0.55)
    .attr("marker-end", "url(#gr-arrow)");

  const node = svg.append("g").selectAll("g").data(nodes).join("g").style("cursor", "grab");
  node.append("circle").attr("r", 17)
    .attr("fill", "var(--arena-bg-raised)")
    .attr("stroke", "var(--arena-clay)").attr("stroke-width", 2);
  node.append("text").text((d) => d.name)
    .attr("text-anchor", "middle").attr("dy", 32)
    .attr("font-family", "var(--arena-font-mono)").attr("font-size", 11)
    .attr("fill", "var(--arena-ink-soft)");

  sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(edges).id((d) => d.id).distance(130).strength(0.35))
    .force("charge", d3.forceManyBody().strength(-420))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide(38))
    .on("tick", () => {
      link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

  node.call(d3.drag()
    .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on("end", (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  return () => {
    disposed = true;
    // Without this the simulation keeps ticking against detached DOM.
    if (sim) sim.stop();
  };
}
