/**
 * Replay — scrub an ideathon's interaction timeline.
 *
 * First view with genuinely stateful behaviour: a playback timer that MUST be
 * cleared on teardown. On the old page-per-view site the browser killed it on
 * navigation; in one shell it would otherwise keep advancing behind whatever
 * you moved to.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { navigate } from "../core/router.js";
import * as store from "../core/store.js";
import { isTerminal } from "../core/model.js";

const STEP_MS = 1200;

const COLLAB_LABELS = {
  propose_collaboration: "proposed collaboration",
  merge: "accepted merge",
  collaboration_refused: "refused collaboration",
};

const QUEUE_LABELS = {
  "pending→in_progress": "claimed",
  "in_progress→completed": "completed",
  "in_progress→failed": "failed",
  "in_progress→pending": "reset",
};

function queueLabel(row) {
  return QUEUE_LABELS[`${row.from_status}→${row.to_status}`] || `${row.from_status} → ${row.to_status}`;
}

function summarize(item) {
  if (!item.content) return "";
  if (COLLAB_LABELS[item.type]) return item.content;
  try {
    const parsed = JSON.parse(item.content);
    if (parsed.strength) {
      return `Strength: ${parsed.strength}\nWeakness: ${parsed.weakness || ""}\nSuggestion: ${parsed.suggestion || ""}`;
    }
  } catch { /* not JSON — fall through to the raw excerpt */ }
  return item.content.slice(0, 160);
}

export async function mount(el, params) {
  let disposed = false;
  let playTimer = null;
  let items = [];
  let index = 0;

  await store.loadAgents();
  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const ideathons = all.filter((e) => e.type === "ideathon");
  const eventId = params.eventId || (ideathons[0] && ideathons[0].id);

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §11</div>
      <h1>Replay</h1>
      <p>Every idea, critique and collaboration in the order it actually happened. Scrub or play it back.</p>
    </header>
    <div class="v-replay__bar arena-card">
      <button class="arena-btn arena-btn--sm arena-btn--ghost" id="rp-play" aria-label="Run the tape">Run</button>
      <button class="arena-btn arena-btn--sm arena-btn--ghost" id="rp-back" aria-label="Step back">←</button>
      <button class="arena-btn arena-btn--sm arena-btn--ghost" id="rp-fwd" aria-label="Step forward">→</button>
      <input type="range" id="rp-range" min="0" max="0" value="0" aria-label="Timeline position" />
      <span class="v-replay__pos" id="rp-pos">0 / 0</span>
    </div>
    <div id="rp-body"><div class="arena-state">Loading timeline…</div></div>`);

  const body = el.querySelector("#rp-body");
  const range = el.querySelector("#rp-range");
  const pos = el.querySelector("#rp-pos");
  const playBtn = el.querySelector("#rp-play");

  function stop() {
    clearInterval(playTimer);
    playTimer = null;
    playBtn.textContent = "Run";
    playBtn.setAttribute("aria-label", "Run the tape");
  }

  function goTo(i, { scroll = true } = {}) {
    if (!items.length) return;
    index = Math.max(0, Math.min(items.length - 1, i));
    range.value = String(index);
    pos.textContent = `${index + 1} / ${items.length}`;
    const els = body.querySelectorAll(".v-replay__item");
    els.forEach((node, idx) => {
      node.classList.toggle("is-active", idx === index);
      node.classList.toggle("is-past", idx < index);
    });
    if (scroll && els[index]) els[index].scrollIntoView({ block: "center", behavior: "smooth" });
    // Position lives in the URL so a specific moment is linkable — replace,
    // not push, so scrubbing doesn't bury the back button.
    if (eventId) navigate(`/replay/${eventId}/${index}`, { replace: true });
  }

  function play() {
    playBtn.textContent = "Hold";
    playBtn.setAttribute("aria-label", "Hold the tape");
    playTimer = setInterval(() => {
      if (index + 1 > items.length - 1) return stop();
      goTo(index + 1);
    }, STEP_MS);
  }

  playBtn.addEventListener("click", () => (playTimer ? stop() : play()));
  el.querySelector("#rp-back").addEventListener("click", () => { stop(); goTo(index - 1); });
  el.querySelector("#rp-fwd").addEventListener("click", () => { stop(); goTo(index + 1); });
  range.addEventListener("input", () => { stop(); goTo(parseInt(range.value, 10)); });

  if (!eventId) {
    render(body, html`<div class="arena-state">No ideathon has run yet.</div>`);
    return () => { disposed = true; stop(); };
  }

  const owner = all.find((e) => e.id === eventId);
  const ttl = isTerminal(owner) ? FOREVER : 30_000;
  const [data, journal] = await Promise.all([
    fetchJson(`/events/${encodeURIComponent(eventId)}/timeline`, { ttl, optional: true }),
    fetchJson(`/events/${encodeURIComponent(eventId)}/journal`, { ttl, optional: true }),
  ]);
  if (disposed) return () => {};

  // Merge the G7 queue journal into the interaction timeline: ideas and
  // interactions are the content, journal rows are the work — claimed,
  // completed, failed, reset. A failed task leaves no interaction row, so
  // without the journal the replay would show nothing where the work died.
  items = [...(data || []), ...(journal || []).map((row) => ({
    ...row,
    ts: row.ts || row.created_at,
    kind: "queue",
    actor_id: row.agent_id,
    content: null,
  }))].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!items.length) {
    render(body, html`<div class="arena-state">No interactions recorded yet for this event.</div>`);
    return () => { disposed = true; stop(); };
  }

  render(body, html`${items.map((item) => {
    const label = COLLAB_LABELS[item.type] || item.type;
    if (item.kind === "queue") {
      const failed = item.to_status === "failed";
      return html`
        <div class="arena-card v-replay__item v-replay__item--queue ${failed ? "v-replay__item--failed" : ""}">
          <div class="v-replay__kind">queue · ${(item.ts || "").slice(0, 16)}</div>
          <div class="v-replay__title">${store.agentName(item.agent_id)} — ${item.task_type} ${queueLabel(item)}</div>
          ${failed && item.error_message
            ? html`<div class="v-replay__text">${item.error_message}</div>`
            : ""}
        </div>`;
    }
    const kind = item.kind === "idea" ? "Idea submitted" : label;
    const title = item.kind === "idea" ? item.title : `${store.agentName(item.actor_id)} — ${label}`;
    const text = item.kind === "idea" ? item.one_liner : summarize(item);
    return html`
      <div class="arena-card v-replay__item">
        <div class="v-replay__kind">${kind} · ${(item.ts || "").slice(0, 16)}</div>
        <div class="v-replay__title">${title || ""}</div>
        <div class="v-replay__text">${text || ""}</div>
      </div>`;
  })}`);

  range.max = String(items.length - 1);
  const start = params.index !== undefined ? parseInt(params.index, 10) : items.length - 1;
  goTo(isNaN(start) ? items.length - 1 : start, { scroll: false });

  return () => { disposed = true; stop(); };
}
