/**
 * Tribunal — the three-stage post-hackathon reflection (spec §14).
 *
 * The event is a route parameter now rather than a dropdown you had to
 * re-select on arrival: links from the hub already carry the right hackathon.
 * The picker remains for browsing, but it writes to the URL.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { href, navigate } from "../core/router.js";
import * as store from "../core/store.js";
import { isTerminal } from "../core/model.js";
import { shortId } from "../core/fmt.js";

const STAGES = [
  { key: "individual",        label: "Individual reflection",                showTarget: false },
  { key: "cross_examination", label: "Cross-examination",                    showTarget: true },
  { key: "synthesis",         label: "Synthesis — carried into next event",  showTarget: false, accent: true },
];

function stageBlock(stage, items) {
  if (!items.length) return "";
  return html`
    <div class="v-tribunal__stage">${stage.label} <span>(${items.length})</span></div>
    ${items.map((r) => html`
      <div class="arena-card v-tribunal__card ${stage.accent ? "v-tribunal__card--synthesis" : ""}">
        <div class="v-tribunal__agent">${store.agentName(r.agent_id)}</div>
        ${stage.showTarget && r.target_agent_id
          ? html`<div class="v-tribunal__target">examining ${store.agentName(r.target_agent_id)}</div>` : ""}
        <div class="v-tribunal__content">${r.content}</div>
      </div>`)}`;
}

export async function mount(el, params) {
  let disposed = false;
  await store.loadAgents();

  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const hackathons = all.filter((e) => e.type === "hackathon");
  const eventId = params.eventId || (hackathons[0] && hackathons[0].id);

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §14</div>
      <h1>Tribunal</h1>
      <p>After every hackathon the agents grade themselves, examine each other, and synthesise one lesson that carries into the next Arena. This is that record, unedited.</p>
    </header>
    <div class="arena-picker">
      <label for="tb-event">Hackathon</label>
      <select class="arena-select" id="tb-event">
        ${hackathons.length
          ? hackathons.map((e) => html`<option value="${e.id}" ${e.id === eventId ? "selected" : ""}>${shortId(e.id, 18)} · ${e.status}${e.winner_team_id ? " · winner decided" : ""}</option>`)
          : html`<option>No hackathon events yet</option>`}
      </select>
      <a class="arena-btn arena-btn--sm arena-btn--ghost" href="${href("/live")}">← Live</a>
    </div>
    <div id="tb-body"><div class="arena-state">Loading reflections…</div></div>`);

  const body = el.querySelector("#tb-body");
  const picker = el.querySelector("#tb-event");
  if (picker) picker.addEventListener("change", () => navigate(`/tribunal/${picker.value}`));

  if (!eventId) {
    render(body, html`<div class="arena-state">No hackathon has run yet.</div>`);
    return () => { disposed = true; };
  }

  const owner = all.find((e) => e.id === eventId);
  const reflections = await fetchJson(`/events/${encodeURIComponent(eventId)}/tribunal`, {
    // A finished event's reflections are immutable — no reason to refetch.
    ttl: isTerminal(owner) ? FOREVER : 30_000,
    optional: true,
  });
  if (disposed) return () => {};

  if (!reflections || !reflections.length) {
    render(body, html`<div class="arena-state">No Tribunal reflections yet for this event — it runs after hackathon judging completes.</div>`);
    return () => { disposed = true; };
  }

  const grouped = { individual: [], cross_examination: [], synthesis: [] };
  reflections.forEach((r) => (grouped[r.reflection_type] || grouped.individual).push(r));

  render(body, html`${STAGES.map((s) => stageBlock(s, grouped[s.key]))}`);
  return () => { disposed = true; };
}
