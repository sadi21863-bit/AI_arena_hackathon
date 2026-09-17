/**
 * What's new — the returning visitor's entry point. Live shows right now,
 * Archive shows everything ever; this shows the delta: new ideas, new
 * interactions, and queue transitions since a timestamp (default: last 24h).
 * One bounded backend call (/events/:id/changes), no new state.
 */

import { fetchJson } from "../core/api.js";
import { html, render, wireReload } from "../core/html.js";
import { href } from "../core/router.js";
import * as store from "../core/store.js";
import { shortId } from "../core/fmt.js";

const TYPE_LABEL = {
  idea: "idea submitted",
  critique: "critique",
  propose_collaboration: "collaboration proposed",
  merge: "ideas merged",
  collaboration_refused: "collaboration refused",
};

export async function mount(el, params) {
  let disposed = false;
  await store.loadAgents();

  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const event = all.find((e) => e.id === params.eventId) || all.find((e) => e.type === "ideathon");
  if (!event) {
    render(el, html`<div class="arena-state">No events yet — nothing has run.<br><small>The scheduler creates the first ideathon automatically.</small></div>`);
    return () => { disposed = true; };
  }

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · since yesterday</div>
      <h1>What's new</h1>
      <p>Everything this event produced in the last 24 hours. <a href="${href("/live")}">← Live</a></p>
    </header>
    <div id="ch-body"><div class="arena-state">Loading changes…</div></div>`);

  const body = el.querySelector("#ch-body");
  const data = await fetchJson(`/events/${encodeURIComponent(event.id)}/changes`, { optional: true });
  if (disposed) return () => { disposed = true; };
  if (!data) {
    render(body, html`<div class="arena-state arena-state--error">Couldn't load changes.<div class="arena-state__action"><button class="arena-btn arena-btn--sm arena-btn--ghost" data-reload>Reload</button></div></div>`);
    wireReload(body);
    return () => { disposed = true; };
  }

  const ideas = data.ideas || [];
  const interactions = data.interactions || [];
  const journal = data.journal || [];
  if (!ideas.length && !interactions.length) {
    render(body, html`<div class="arena-state">Nothing new in the last 24 hours.<br><small>Follow the current phase on the <a href="${href("/live")}">Live</a> view.</small></div>`);
    return () => { disposed = true; };
  }

  render(body, html`
    <div class="arena-section-label">Since ${String(data.since || "").slice(0, 16).replace("T", " ")}</div>
    ${ideas.length ? html`
      <div class="arena-section-label">Ideas (${ideas.length})</div>
      ${ideas.map((r) => html`
        <div class="arena-card v-changes__row">
          <b>${r.title}</b>
          <small>${store.agentName(r.agent_id)} · ${r.status} · ${(r.ts || "").slice(0, 16).replace("T", " ")}</small>
          ${r.one_liner ? html`<div class="v-changes__text">${r.one_liner}</div>` : ""}
        </div>`)}` : ""}
    ${interactions.length ? html`
      <div class="arena-section-label">Interactions (${interactions.length})</div>
      ${interactions.map((r) => html`
        <div class="arena-card v-changes__row">
          <b>${TYPE_LABEL[r.type] || r.type}</b>
          <small>${store.agentName(r.actor_id)}${r.target_id ? ` → ${shortId(r.target_id, 8)}` : ""} · ${(r.ts || "").slice(0, 16).replace("T", " ")}</small>
        </div>`)}` : ""}
    ${journal.length ? html`
      <div class="arena-section-label">Queue movement</div>
      <div class="arena-card v-changes__row"><small>${journal.map((j) => `${j.task_type} → ${j.to_status} ×${j.n}`).join(" · ")}</small></div>` : ""}
  `);
  return () => { disposed = true; };
}
