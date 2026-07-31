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

const IDEATHON_ZONES = [
  { id: "research",     label: "Research Nook",      x: 17, y: 34 },
  { id: "idea",         label: "Idea Desk",          x: 50, y: 31 },
  { id: "critique",     label: "Critique Corner",    x: 83, y: 34 },
  { id: "architecture", label: "Architecture Table", x: 25, y: 63 },
  { id: "tribunal",     label: "Tribunal Circle",    x: 75, y: 63 },
  { id: "break",        label: "Break Area",         x: 50, y: 74 },
];

/**
 * P2 (docs/OFFICE_INVESTIGATION_2026-07-31.md G2). During a hackathon nobody
 * has a queue row — building is team-level GitHub Actions work — so the room
 * used to park all twelve at the break area behind an apology banner for
 * roughly half of every cycle.
 *
 * The layout swaps to two team benches instead. Placement comes from the
 * roster (hackathon_team_members), not from event_queue, so it works precisely
 * when the queue has nothing to say. Tribunal is kept because tribunal_* tasks
 * ARE per-agent and run at the end of a hackathon — during that phase agents
 * legitimately leave their benches for the circle.
 */
const HACKATHON_ZONES = [
  { id: "team_alpha", label: "Team Alpha", x: 24, y: 40 },
  { id: "team_beta",  label: "Team Beta",  x: 76, y: 40 },
  { id: "tribunal",   label: "Tribunal Circle", x: 50, y: 66 },
  { id: "break",      label: "Break Area", x: 50, y: 80 },
];

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

/* A turn's CI state, collapsed to the three things a viewer cares about.
   `status` is the workflow run's lifecycle, `conclusion` only exists once it
   finished — so an unfinished turn is "running" regardless of conclusion. */
const ciState = (t) =>
  t.status !== "completed" ? "running" : t.conclusion === "success" ? "success" : "failure";
const ciLabel = (t) => {
  const s = ciState(t);
  return s === "running" ? `⏳ turn ${t.turn_number} running`
    : s === "success" ? `✅ turn ${t.turn_number} passed`
    : `❌ turn ${t.turn_number} failed`;
};

export async function mount(el, params) {
  let disposed = false;
  const nodes = {};
  const latest = {};
  let selectedId = null;
  let built = false;
  /* agent_id -> roster row, populated for hackathons only. */
  let rosterByAgent = {};
  /* team_id -> latest build turn, for the CI badge on each bench. */
  let turnByTeam = {};
  /* team_id -> agent_id whose turn it is next. */
  let turnHolder = {};
  let ZONES = IDEATHON_ZONES;
  let ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));

  /**
   * Where an agent stands. A real per-agent task always wins — during the
   * Tribunal at the end of a hackathon the tribunal_* tasks are genuinely
   * per-agent, and an agent doing real work should be at the work, not at a
   * bench. Team membership is the fallback that fills the otherwise-empty
   * building phase.
   */
  function zoneFor(agent) {
    const info = taskInfo(agent.task_type);
    if (info) return info.zone;
    const member = rosterByAgent[agent.agent_id];
    if (member) return member.team_name === "beta" ? "team_beta" : "team_alpha";
    return "break";
  }

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
    const member = rosterByAgent[a.agent_id];
    render(inspectorEl, html`
      <div class="v-office__inspector-name">${a.name}</div>
      <div class="v-office__inspector-lens">${a.lens || ""}</div>
      ${a.abandoned ? html`
        <div class="v-office__inspector-alert v-office__inspector-alert--stop">
          <b>The scheduler has given up on this agent.</b>
          ${a.failed_attempts} failed <code>${a.failed_task_type}</code> attempts hit the retry cap, so it is no longer being retried for this event.
          ${a.last_error ? html`<div class="v-office__inspector-err">${a.last_error}</div>` : ""}
        </div>` : ""}
      ${!a.abandoned && a.failed_attempts ? html`
        <div class="v-office__inspector-alert v-office__inspector-alert--warn">
          <b>${a.failed_attempts} failed <code>${a.failed_task_type}</code> attempt(s)</b> — still within the retry cap, so this should recover on its own.
          ${a.last_error ? html`<div class="v-office__inspector-err">${a.last_error}</div>` : ""}
        </div>` : ""}
      <div class="v-office__inspector-rows">
        <div>Doing: <b>${info ? `${info.emote} ${info.label}` : "nothing right now"}</b></div>
        <div>Queue task: <b>${a.task_type || "—"}</b></div>
        <div>Status: <b>${a.status || "idle"}</b></div>
        <div>Last update: <b>${a.updated_at || "—"}</b></div>
        ${member ? html`
          <div>Team: <b>${member.team_name || "—"}</b> (${member.membership})</div>
          <div>Build role: <b>${member.build_role || "—"}</b></div>
          <div>Turns taken: <b>${member.turns_taken ?? 0}</b></div>` : ""}
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
        ${ZONES.map((z) => html`
          <div class="v-office__zone" id="of-zone-${z.id}" data-team-id="${z.teamId || ""}" style="left:${z.x}%;top:${z.y + 9}%">
            ${z.label}${z.teamId ? html`<span class="v-office__zone-turn"></span>` : ""}
          </div>`)}
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
    agents.forEach((a) => { (perZone[zoneFor(a)] ||= []).push(a); });

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
        // P1: a failed row still never positions anyone — but it must not be
        // silent either. Without this, an agent the watchdog has permanently
        // given up on renders exactly like one relaxing on the couch.
        // Abandoned outranks the current task in the badge, because "the
        // system stopped retrying this agent" is the more important fact.
        const abandoned = !!a.abandoned;
        const struggling = !abandoned && (a.failed_attempts || 0) > 0;

        node.emoteEl.textContent = abandoned ? "🛑" : struggling ? "⚠️" : info ? info.emote : "";
        node.el.classList.toggle("has-task", !!info);
        node.el.classList.toggle("is-working", a.status === "in_progress");
        node.el.classList.toggle("is-abandoned", abandoned);
        node.el.classList.toggle("is-struggling", struggling);
        node.el.title = abandoned
          ? `${a.name} · GIVEN UP ON — ${a.failed_attempts} failed ${a.failed_task_type} attempts, no longer retrying`
          : struggling
            ? `${a.name} · ${a.failed_attempts} failed ${a.failed_task_type} attempt(s), still retrying`
            : `${a.name}${info ? ` · ${info.label}` : " · idle"}${a.status ? ` (${a.status})` : ""}`;
      });
    });

    // P2: mark whoever holds the current build turn. Mirrors nextBuildAuthor
    // (src/events/team-members.ts) — fewest turns first, leads breaking the
    // tie, then roster order — so the room agrees with the code that actually
    // picks, rather than guessing.
    Object.values(nodes).forEach((n) => n.el.classList.remove("is-turn-holder"));
    Object.values(turnHolder).forEach((agentId) => {
      if (nodes[agentId]) nodes[agentId].el.classList.add("is-turn-holder");
    });

    ZONES.forEach((z) => {
      const zEl = el.querySelector(`#of-zone-${z.id}`);
      if (!zEl) return;
      zEl.classList.toggle("is-active", z.id !== "break" && (perZone[z.id] || []).length > 0);
      const turn = zEl.querySelector(".v-office__zone-turn");
      if (turn) {
        const t = turnByTeam[zEl.dataset.teamId];
        turn.textContent = t ? ciLabel(t) : "";
        turn.className = `v-office__zone-turn ${t ? `is-${ciState(t)}` : ""}`;
      }
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

  const isHackathon = event.type === "hackathon";
  const [activity, teams, roster, turns] = await Promise.all([
    fetchJson(`/events/${encodeURIComponent(event.id)}/agent-activity`, { optional: true }),
    isHackathon ? fetchJson(`/events/${encodeURIComponent(event.id)}/teams`, { optional: true }) : Promise.resolve([]),
    isHackathon ? fetchJson(`/events/${encodeURIComponent(event.id)}/roster`, { optional: true }) : Promise.resolve([]),
    isHackathon ? fetchJson(`/events/${encodeURIComponent(event.id)}/build-turns`, { optional: true }) : Promise.resolve([]),
  ]);
  if (disposed) return () => {};

  /**
   * P2: swap the room to team benches for a hackathon, but only if a roster
   * actually came back. Teams formed before rosters existed have none, and
   * older Workers have no /roster or /build-turns route at all — in both cases
   * the ideathon layout plus the original banner is still the correct render,
   * so this degrades to exactly the previous behaviour rather than an empty
   * room.
   */
  const hasRoster = isHackathon && Array.isArray(roster) && roster.length > 0;
  if (hasRoster) {
    rosterByAgent = Object.fromEntries(roster.map((m) => [m.agent_id, m]));
    ZONES = HACKATHON_ZONES.map((z) => {
      if (z.id !== "team_alpha" && z.id !== "team_beta") return z;
      const wanted = z.id === "team_beta" ? "beta" : "alpha";
      const team = (teams || []).find((t) => t.team_name === wanted);
      return { ...z, teamId: team ? team.id : "", label: team ? `Team ${wanted}` : z.label };
    });
    ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));
    applyTurnState(turns, roster);
  }

  /** Latest turn per team, and whose turn it is next on each. */
  function applyTurnState(allTurns, rosterRows) {
    turnByTeam = {};
    for (const t of allTurns || []) {
      const prev = turnByTeam[t.team_id];
      if (!prev || (t.turn_number ?? 0) >= (prev.turn_number ?? 0)) turnByTeam[t.team_id] = t;
    }
    turnHolder = {};
    const byTeam = {};
    for (const m of rosterRows || []) (byTeam[m.team_id] ||= []).push(m);
    for (const [teamId, members] of Object.entries(byTeam)) {
      // Same ordering as nextBuildAuthor: fewest turns, leads first, then id.
      const next = [...members].sort((a, b) =>
        (a.turns_taken ?? 0) - (b.turns_taken ?? 0) ||
        (b.membership === "lead") - (a.membership === "lead") ||
        String(a.agent_id).localeCompare(String(b.agent_id))
      )[0];
      if (next) turnHolder[teamId] = next.agent_id;
    }
  }

  if (!activity) {
    // The endpoint ships with the Worker, which deploys separately from
    // Pages — so a missing endpoint is a permanent possibility, not a blip.
    render(stage, html`<div class="arena-state arena-state--error">
      Per-agent activity isn't available from the API yet.<br>
      <small>GET /events/:id/agent-activity returned no data — the Worker may not have been deployed.</small>
    </div>`);
    return () => { disposed = true; };
  }

  if (hasRoster) {
    // P2: the room now shows the build, so this explains what is being shown
    // rather than apologising for showing nothing.
    const built = (teams || []).map((t) => `${t.team_name} (${t.status || "?"})`).join(" · ");
    render(noteEl, html`<div class="arena-note"><span>🏗️</span><span>
      <b>Hackathon — agents are at their team benches.</b> Building runs as team-level GitHub Actions turns, so placement comes from the team roster rather than the work queue. The ring marks whoever holds the next build turn; each bench shows that team's latest CI result. Agents move to the Tribunal Circle at the end, where the work is per-agent again.
      ${built ? ` Teams: ${built}.` : ""}
    </span></div>`);
  } else if (isHackathon) {
    // Pre-roster teams, or a Worker without /roster — the old render is still
    // the truthful one here.
    const built = (teams || []).map((t) => `${t.team_name} (${t.status || "?"})`).join(" · ");
    render(noteEl, html`<div class="arena-note arena-note--warn"><span>🏗️</span><span>
      <b>Hackathon phase — the agents are between rounds.</b> Building runs as team-level GitHub Actions turns, not per-agent queue tasks, so everyone idles at the break area until the next ideathon. This event has no team roster recorded, so there are no benches to show.
      ${built ? ` Teams: ${built}.` : ""}
    </span></div>`);
  }

  draw(activity);

  // Re-draw off the shared store tick rather than a private timer.
  const off = store.events.subscribe(async () => {
    if (disposed) return;
    // Turn state is refetched alongside activity: during a hackathon it is the
    // only thing that actually changes between ticks, so polling activity
    // alone would leave the CI badge and the turn ring permanently stale.
    const [next, nextTurns, nextRoster] = await Promise.all([
      fetchJson(`/events/${encodeURIComponent(event.id)}/agent-activity`, { optional: true }),
      hasRoster ? fetchJson(`/events/${encodeURIComponent(event.id)}/build-turns`, { optional: true }) : Promise.resolve(null),
      hasRoster ? fetchJson(`/events/${encodeURIComponent(event.id)}/roster`, { optional: true }) : Promise.resolve(null),
    ]);
    if (disposed || !next) return;
    if (nextRoster && nextRoster.length) rosterByAgent = Object.fromEntries(nextRoster.map((m) => [m.agent_id, m]));
    if (nextTurns) applyTurnState(nextTurns, nextRoster || Object.values(rosterByAgent));
    draw(next);
  });

  return () => {
    disposed = true;
    off();
    // The whole point of the teardown contract: 12 characters x 2 timers.
    Object.values(nodes).forEach(stopWalk);
  };
}
