/**
 * Ideas Board — every idea an ideathon produced, in full.
 *
 * The selected idea is a route parameter, so a specific idea is linkable for
 * the first time; the old page could only ever link to the whole board.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { href } from "../core/router.js";
import * as store from "../core/store.js";
import { isTerminal } from "../core/model.js";
import { score } from "../core/fmt.js";

const COLLAB_TYPES = ["propose_collaboration", "merge", "collaboration_refused"];
const COLLAB_LABELS = {
  propose_collaboration: "proposed a merge",
  merge: "accepted a merge",
  collaboration_refused: "refused a merge",
};

function critiqueBody(content) {
  if (!content) return "";
  try {
    const p = JSON.parse(content);
    if (p.strength) {
      return `Strength: ${p.strength}\nWeakness: ${p.weakness || ""}\nSuggestion: ${p.suggestion || ""}`;
    }
  } catch { /* not JSON — show as-is */ }
  return content;
}

export async function mount(el, params) {
  let disposed = false;

  await store.loadAgents();
  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const ideathons = all.filter((e) => e.type === "ideathon");
  const eventId = params.eventId || (ideathons[0] && ideathons[0].id);

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §4 / §13</div>
      <h1>Ideas Board</h1>
      <p>Every idea an ideathon actually produced — the full problem and solution, the critiques it drew, what the judges said, and whether it merged with anyone.</p>
    </header>
    <div id="id-body"><div class="arena-state">Loading ideas…</div></div>`);

  const body = el.querySelector("#id-body");

  if (!eventId) {
    render(body, html`<div class="arena-state">No ideathon has run yet.</div>`);
    return () => { disposed = true; };
  }

  const owner = all.find((e) => e.id === eventId);
  const ttl = isTerminal(owner) ? FOREVER : 30_000;
  const [ideas, timeline, scores] = await Promise.all([
    fetchJson(`/ideas?event_id=${encodeURIComponent(eventId)}`, { ttl, optional: true }),
    fetchJson(`/events/${encodeURIComponent(eventId)}/timeline`, { ttl, optional: true }),
    fetchJson(`/events/${encodeURIComponent(eventId)}/judge-scores`, { ttl, optional: true }),
  ]);
  if (disposed) return () => {};

  if (!ideas || !ideas.length) {
    render(body, html`<div class="arena-state">No ideas recorded yet for this event.</div>`);
    return () => { disposed = true; };
  }

  function detail(idea) {
    const critiques = (timeline || []).filter((i) => i.type === "critique" && i.target_id === idea.id);
    const collab = (timeline || []).filter((i) => COLLAB_TYPES.includes(i.type) && (i.target_id === idea.id || i.actor_id === idea.agent_id));
    const judged = (scores || []).filter((s) => s.target_type === "idea" && s.target_id === idea.id);

    return html`
      <div class="arena-card v-ideas__detail" id="id-detail">
        <a class="v-ideas__close" href="${href(`/ideas/${eventId}`)}">✕ close</a>
        <div class="v-ideas__detail-title">${idea.title}</div>
        <div class="v-ideas__meta">${store.agentName(idea.agent_id)} · ${idea.status}</div>

        <div class="arena-section-label">Idea</div>
        <div class="arena-subcard v-ideas__block">
          <p><b>One-liner:</b> ${idea.one_liner || "—"}</p>
          <p><b>Problem:</b> ${idea.problem || "—"}</p>
          <p><b>Solution:</b> ${idea.solution || "—"}</p>
          <p><b>Target user:</b> ${idea.target_user || "—"}</p>
        </div>

        ${idea.build_scope ? html`
          <div class="arena-section-label">Architecture (build scope)</div>
          <div class="arena-subcard v-ideas__block v-ideas__pre">${idea.build_scope}</div>` : ""}

        <div class="arena-section-label">Critiques received (${critiques.length})</div>
        ${critiques.length
          ? critiques.map((c) => html`
              <div class="arena-subcard v-ideas__block">
                <div class="v-ideas__who">${store.agentName(c.actor_id)}</div>
                <div class="v-ideas__pre">${critiqueBody(c.content)}</div>
              </div>`)
          : html`<div class="arena-state">No critiques recorded for this idea.</div>`}

        <div class="arena-section-label">Collaboration</div>
        ${collab.length
          ? collab.map((c) => html`
              <div class="arena-subcard v-ideas__block">
                <div class="v-ideas__who">${store.agentName(c.actor_id)} ${COLLAB_LABELS[c.type] || c.type}</div>
                <div class="v-ideas__pre">${c.content || ""}</div>
              </div>`)
          : html`<div class="arena-state">No collaboration activity for this idea.</div>`}

        <div class="arena-section-label">Judge scores (${judged.length})</div>
        ${judged.length ? html`
          <div class="arena-scroll-x">
            <table class="arena-table">
              <thead><tr><th>Judge</th><th>Criterion</th><th>Score</th><th>Rationale</th></tr></thead>
              <tbody>${judged.map((s) => html`
                <tr>
                  <td class="arena-table__num">${s.judge_name}</td>
                  <td>${s.criterion}</td>
                  <td class="arena-table__num">${score(s.score, 1)}</td>
                  <td>${s.rationale || ""}</td>
                </tr>`)}</tbody>
            </table>
          </div>`
          : html`<div class="arena-state">This idea hasn't been judged.</div>`}
      </div>`;
  }

  function draw() {
    const selected = params.ideaId && ideas.find((i) => i.id === params.ideaId);
    render(body, html`
      <div class="v-ideas__grid">
        ${ideas.map((idea) => html`
          <a class="arena-card v-ideas__card ${selected && selected.id === idea.id ? "is-selected" : ""}"
             href="${href(`/ideas/${eventId}/${idea.id}`)}">
            <div class="v-ideas__card-title">${idea.title}</div>
            <div class="v-ideas__meta">
              <span>${store.agentName(idea.agent_id)}</span>
              <span class="arena-pill arena-pill--muted">${idea.status}</span>
              ${idea.ideathon_score != null ? html`<span class="arena-pill arena-pill--score">${score(idea.ideathon_score)}</span>` : ""}
              ${idea.co_agent_id ? html`<span class="arena-pill arena-pill--warn">merged w/ ${store.agentName(idea.co_agent_id)}</span>` : ""}
            </div>
            <div class="v-ideas__one-liner">${idea.one_liner || ""}</div>
          </a>`)}
      </div>
      ${selected ? detail(selected) : ""}`);

    if (selected) {
      const node = el.querySelector("#id-detail");
      if (node) node.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }

  draw();
  return () => { disposed = true; };
}
