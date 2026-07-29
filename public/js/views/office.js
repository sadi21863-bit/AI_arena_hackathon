/**
 * Agent Office — the twelve agents, standing where their real work is.
 *
 * The sprite choreography (zone table, frame stepping, walk/settle timing)
 * is carried over verbatim from the standalone page; it was hand-tuned and
 * there is nothing to gain by re-deriving it. What is new is the teardown:
 * the old page created 12 characters x 2 timers with no cleanup path, which
 * was harmless when the browser tore the page down on navigation and is a
 * hard leak inside one shell.
 *
 * Two behaviours worth not regressing, both found by testing the first cut:
 *  - A poll where nothing changed must NOT replay a walk cycle. The original
 *    computed direction from a zero delta, and `Math.abs(0) > Math.abs(0)`
 *    is false, so every agent walked "up" in place on every refresh.
 *  - Characters must stay inside the walls. A fixed percentage margin fails
 *    once the room is narrow, because the sprite is a fixed pixel size — so
 *    the clamp is computed from real element vs room dimensions.
 */

import { fetchJson } from "../core/api.js";
import { html, render } from "../core/html.js";
import { href } from "../core/router.js";
import * as store from "../core/store.js";
import { isLive, typeLabel, phaseLabel } from "../core/model.js";
import { shortId } from "../core/fmt.js";

/* Row order must match scripts/generate_office_sprites.js. */
const ROW = { idle: 0, walk_down: 1, walk_left: 2, walk_right: 3, walk_up: 4 };
const SHEET_COLS = 6, SHEET_ROWS = 5;
const WALK_FRAMES = 6;
const WALK_FPS = 8;          // matches the source Godot SpriteFrames timing
const MOVE_MS = 1150;        // must match the CSS transition duration
const MOVE_EPSILON = 0.4;    // %, below this a "move" isn't worth animating

/* 8 source characters cover 12 agents; 4 are hue-rotated twins. Cosmetic
   only — reshuffle freely, nothing depends on the mapping. */
const CAST = {
  agent_alex:  { sprite: "alex",      filter: null },
  agent_casey: { sprite: "casey",     filter: null },
  agent_blake: { sprite: "dean",      filter: null },
  agent_drew:  { sprite: "detective", filter: null },
  agent_ellis: { sprite: "jordan",    filter: null },
  agent_finn:  { sprite: "morgan",    filter: null },
  agent_gale:  { sprite: "riley",     filter: null },
  agent_hale:  { sprite: "sam",       filter: null },
  agent_iris:  { sprite: "dean",      filter: "hue-rotate(120deg) saturate(1.3)" },
  agent_jade:  { sprite: "detective", filter: "hue-rotate(200deg) saturate(1.3)" },
  agent_kai:   { sprite: "jordan",    filter: "hue-rotate(280deg) saturate(1.3)" },
  agent_leo:   { sprite: "morgan",    filter: "hue-rotate(45deg) saturate(1.3)" },
};

const ZONES = [
  { id: "research",     label: "Research Nook",      x: 17, y: 34 },
  { id: "idea",         label: "Idea Desk",          x: 50, y: 31 },
  { id: "critique",     label: "Critique Corner",    x: 83, y: 34 },
  { id: "architecture", label: "Architecture Table", x: 25, y: 63 },
  { id: "tribunal",     label: "Tribunal Circle",    x: 75, y: 63 },
  { id: "break",        label: "Break Area",         x: 50, y: 74 },
];
const ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));

const PROPS = [
  { cls: "rug",    x: 50, y: 78 }, { cls: "shelf",  x: 11, y: 26 },
  { cls: "desk",   x: 19, y: 28 }, { cls: "desk",   x: 50, y: 25 },
  { cls: "desk",   x: 83, y: 28 }, { cls: "board",  x: 25, y: 54 },
  { cls: "table",  x: 75, y: 60 }, { cls: "couch",  x: 50, y: 71 },
  { cls: "cooler", x: 88, y: 76 }, { cls: "plant",  x: 8,  y: 82 },
  { cls: "plant",  x: 93, y: 47 },
];

/* Only these task types ever carry an agent_id — the rest are event- or
   team-level, and judges are a separate roster. An agent with none of these
   is genuinely idle, which is normal, not missing data. */
const TASK = {
  research:               { zone: "research",     label: "researching",           emote: "🔍" },
  submit_idea:            { zone: "idea",         label: "writing an idea",       emote: "💡" },
  critique:               { zone: "critique",     label: "critiquing",            emote: "💬" },
  architecture:           { zone: "architecture", label: "drafting architecture", emote: "📐" },
  tribunal_reflect:       { zone: "tribunal",     label: "reflecting",            emote: "🤔" },
  tribunal_cross_examine: { zone: "tribunal",     label: "cross-examining",       emote: "⚖️" },
  tribunal_synthesize:    { zone: "tribunal",     label: "synthesizing",          emote: "📝" },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const taskInfo = (t) => TASK[t] || null;
const zoneFor = (t) => (taskInfo(t) ? TASK[t].zone : "break");

export async function mount(el, params) {
  let disposed = false;
  const nodes = {};
  const latest = {};
  let selectedId = null;
  let built = false;

  await store.loadAgents();
  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const event = (params.eventId && all.find((e) => e.id === params.eventId)) || all[0];

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §11</div>
      <h1>Agent Office</h1>
      <p>All twelve agents in one room, standing where their real work is. Each character's desk is whatever that agent's current queue task actually is — they walk over when it changes, and idle at the break area when they have nothing running. Click anyone to inspect them.</p>
    </header>
    <div class="arena-picker">
      <span id="of-meta"></span>
      <a class="arena-btn arena-btn--sm arena-btn--ghost" href="${href("/live")}">← Live</a>
    </div>
    <div id="of-note"></div>
    <div id="of-stage"><div class="arena-skel arena-skel--block" style="min-height:440px"></div></div>
    <div class="arena-card v-office__inspector" id="of-inspector">
      <div class="v-office__inspector-empty">Click a character to see what they're working on.</div>
    </div>
    <div class="v-office__legend" id="of-legend"></div>
    <p class="arena-freshness" data-freshness></p>`);

  const stage = el.querySelector("#of-stage");
  const metaEl = el.querySelector("#of-meta");
  const noteEl = el.querySelector("#of-note");
  const legendEl = el.querySelector("#of-legend");
  const inspectorEl = el.querySelector("#of-inspector");

  function setFrame(node, row, col) {
    node.spriteEl.style.backgroundPosition =
      `${(col * 100) / (SHEET_COLS - 1)}% ${(row * 100) / (SHEET_ROWS - 1)}%`;
  }

  function stopWalk(node) {
    if (node.walkTimer) { clearInterval(node.walkTimer); node.walkTimer = null; }
    if (node.settleTimer) { clearTimeout(node.settleTimer); node.settleTimer = null; }
  }

  function place(node, x, y, animate) {
    const dx = x - node.x, dy = y - node.y;
    const far = Math.abs(dx) > MOVE_EPSILON || Math.abs(dy) > MOVE_EPSILON;

    node.x = x; node.y = y;
    // Lower in the room = nearer the viewer, so paint over furniture and
    // anyone standing behind.
    node.el.style.zIndex = String(10 + Math.round(y * 2));

    if (!animate || !far) {
      stopWalk(node);
      node.el.classList.remove("is-moving");
      node.el.style.left = x + "%";
      node.el.style.top = y + "%";
      setFrame(node, ROW.idle, 0);
      return;
    }

    const row = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? ROW.walk_right : ROW.walk_left)
      : (dy > 0 ? ROW.walk_down : ROW.walk_up);

    stopWalk(node);
    let frame = 0;
    setFrame(node, row, 0);
    node.walkTimer = setInterval(() => {
      frame = (frame + 1) % WALK_FRAMES;
      setFrame(node, row, frame);
    }, 1000 / WALK_FPS);

    node.el.classList.add("is-moving");
    node.el.style.left = x + "%";
    node.el.style.top = y + "%";

    node.settleTimer = setTimeout(() => { stopWalk(node); setFrame(node, ROW.idle, 0); }, MOVE_MS + 60);
  }

  function drawInspector() {
    const a = selectedId && latest[selectedId];
    if (!a) {
      render(inspectorEl, html`<div class="v-office__inspector-empty">Click a character to see what they're working on.</div>`);
      return;
    }
    const info = taskInfo(a.task_type);
    render(inspectorEl, html`
      <div class="v-office__inspector-name">${a.name}</div>
      <div class="v-office__inspector-lens">${a.lens || ""}</div>
      <div class="v-office__inspector-rows">
        <div>Doing: <b>${info ? `${info.emote} ${info.label}` : "nothing right now"}</b></div>
        <div>Queue task: <b>${a.task_type || "—"}</b></div>
        <div>Status: <b>${a.status || "idle"}</b></div>
        <div>Last update: <b>${a.updated_at || "—"}</b></div>
      </div>`);
  }

  function select(id) {
    selectedId = id;
    Object.keys(nodes).forEach((k) => nodes[k].el.classList.toggle("is-selected", k === id));
    drawInspector();
  }

  function build(agents) {
    render(stage, html`
      <div class="v-office__room" id="of-room">
        <div class="v-office__floor"></div>
        <div class="v-office__wall"></div>
        ${PROPS.map((p) => html`<div class="v-office__prop v-office__prop--${p.cls}" style="left:${p.x}%;top:${p.y}%;z-index:${10 + Math.round(p.y * 2) - 1}"></div>`)}
        ${ZONES.map((z) => html`<div class="v-office__zone" id="of-zone-${z.id}" style="left:${z.x}%;top:${z.y + 9}%">${z.label}</div>`)}
        ${agents.filter((a) => CAST[a.agent_id]).map((a) => html`
          <div class="v-office__agent" id="of-agent-${a.agent_id}" tabindex="0" role="button" aria-label="${a.name}">
            <div class="v-office__emote"></div>
            <div class="v-office__sprite" style="background-image:url(/observatory/assets/office/sprites/${CAST[a.agent_id].sprite}.webp)${CAST[a.agent_id].filter ? `;filter:${CAST[a.agent_id].filter}` : ""}"></div>
            <div class="v-office__name">${a.name}</div>
          </div>`)}
      </div>`);

    agents.forEach((a) => {
      const node = el.querySelector(`#of-agent-${CSS.escape(a.agent_id)}`);
      if (!node) return;
      nodes[a.agent_id] = {
        el: node,
        spriteEl: node.querySelector(".v-office__sprite"),
        emoteEl: node.querySelector(".v-office__emote"),
        x: 50, y: 74,          // everyone starts at the break area and walks out
        walkTimer: null, settleTimer: null,
      };
      node.addEventListener("click", () => select(a.agent_id));
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(a.agent_id); }
      });
    });
    built = true;
  }

  function draw(agents) {
    const first = !built;
    if (first) build(agents);
    agents.forEach((a) => { latest[a.agent_id] = a; });

    const room = el.querySelector("#of-room").getBoundingClientRect();
    const probe = nodes[agents[0] && agents[0].agent_id];
    const halfW = probe ? probe.el.offsetWidth / 2 : 32;
    const padX = room.width ? (halfW / room.width) * 100 + 1 : 7;
    const padTop = room.height ? ((probe ? probe.el.offsetHeight : 64) / room.height) * 100 + 14 : 17;
    const padBottom = room.height ? (18 / room.height) * 100 : 4;

    const perZone = {};
    agents.forEach((a) => { (perZone[zoneFor(a.task_type)] ||= []).push(a); });

    Object.keys(perZone).forEach((zoneId) => {
      const group = perZone[zoneId];
      const zone = ZONE_BY_ID[zoneId];
      // Rows of at most 4: all 12 legitimately share the break area during a
      // hackathon, and one row that wide overlaps its own name labels.
      const perRow = Math.min(4, group.length);
      const rowCount = Math.ceil(group.length / perRow);

      group.forEach((a, i) => {
        const node = nodes[a.agent_id];
        if (!node) return;
        const r = Math.floor(i / perRow), c = i % perRow;
        const inRow = Math.min(perRow, group.length - r * perRow);
        const x = clamp(zone.x + (c - (inRow - 1) / 2) * 11, padX, 100 - padX);
        const y = clamp(zone.y + r * 11 - (rowCount - 1) * 5.5, padTop, 100 - padBottom);

        place(node, x, y, !first);

        const info = taskInfo(a.task_type);
        node.emoteEl.textContent = info ? info.emote : "";
        node.el.classList.toggle("has-task", !!info);
        node.el.classList.toggle("is-working", a.status === "in_progress");
        node.el.title = `${a.name}${info ? ` · ${info.label}` : " · idle"}${a.status ? ` (${a.status})` : ""}`;
      });
    });

    ZONES.forEach((z) => {
      const zEl = el.querySelector(`#of-zone-${z.id}`);
      if (zEl) zEl.classList.toggle("is-active", z.id !== "break" && (perZone[z.id] || []).length > 0);
    });

    render(legendEl, html`${ZONES.map((z) => html`
      <div class="v-office__legend-item"><span class="v-office__legend-count">${(perZone[z.id] || []).length}</span>${z.label}</div>`)}`);

    drawInspector();
  }

  if (!event) {
    render(stage, html`<div class="arena-state">No events yet — nothing has run.</div>`);
    return () => { disposed = true; };
  }

  const live = isLive(event);
  render(metaEl, html`
    <span class="arena-dot ${live ? "arena-dot--live" : "arena-dot--done"}"></span>
    ${live ? "Live" : "Most recent · finished"} · ${typeLabel(event.type)} · ${phaseLabel(event)} · ${shortId(event.id, 20)}`);

  const [activity, teams] = await Promise.all([
    fetchJson(`/events/${encodeURIComponent(event.id)}/agent-activity`, { optional: true }),
    event.type === "hackathon"
      ? fetchJson(`/events/${encodeURIComponent(event.id)}/teams`, { optional: true })
      : Promise.resolve([]),
  ]);
  if (disposed) return () => {};

  if (!activity) {
    // The endpoint ships with the Worker, which deploys separately from
    // Pages — so a missing endpoint is a permanent possibility, not a blip.
    render(stage, html`<div class="arena-state arena-state--error">
      Per-agent activity isn't available from the API yet.<br>
      <small>GET /events/:id/agent-activity returned no data — the Worker may not have been deployed.</small>
    </div>`);
    return () => { disposed = true; };
  }

  if (event.type === "hackathon") {
    const built = (teams || []).map((t) => `${t.team_name} (${t.status || "?"})`).join(" · ");
    render(noteEl, html`<div class="arena-note arena-note--warn"><span>🏗️</span><span>
      <b>Hackathon phase — the agents are between rounds.</b> Building runs as team-level GitHub Actions turns, not per-agent queue tasks, so everyone idles at the break area until the next ideathon.
      ${built ? ` Teams: ${built}.` : ""}
    </span></div>`);
  }

  draw(activity);

  // Re-draw off the shared store tick rather than a private timer.
  const off = store.events.subscribe(async () => {
    if (disposed) return;
    const next = await fetchJson(`/events/${encodeURIComponent(event.id)}/agent-activity`, { optional: true });
    if (!disposed && next) draw(next);
  });

  return () => {
    disposed = true;
    off();
    // The whole point of the teardown contract: 12 characters x 2 timers.
    Object.values(nodes).forEach(stopWalk);
  };
}
