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
import { mountArenaStrip } from "../core/arena-strip.js";

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

/**
 * Per-stage environments (docs/OFFICE_ENVIRONMENTS_PROPOSAL.md §4).
 *
 * One room served every phase, which meant it was wrong for all of them: 12
 * agents research, 6 draft architecture, 6+6 build, and a single fixed layout
 * cannot be sized for those at once. Each phase now gets a set.
 *
 * These are DESCRIPTORS, not scenes. There is one renderer; a set only says
 * which zones exist, where they sit, and what furniture dresses them. That is
 * the same shape as project-chimera's `location_manager.gd`, which is a
 * LOCATIONS dictionary rather than eight hand-built scenes — eight
 * environments for roughly the cost of one and a half, and a new phase is a
 * data entry rather than a new view.
 *
 * Two rules make this safe to extend:
 *
 *  - **Zone ids are stable across sets.** TASK below maps a queue task_type to
 *    a zone id, and that mapping never changes. A set only decides whether
 *    that zone is present and where. An agent whose zone is absent from the
 *    current set falls back to the set's `fallbackZone`, so adding a set can
 *    never strand a character at coordinates that do not exist.
 *  - **Props reuse the existing CSS prop classes.** Set dressing is
 *    rearrangement, not new art — no set can require a stylesheet change.
 *
 * Zone `y` is where characters stand; the label renders slightly below it.
 */
const SETS = {
  library: {
    name: "Research Library",
    blurb: "Twelve lenses, twelve carrels. Everyone is reading.",
    fallbackZone: "research",
    zones: [
      { id: "research", label: "Carrels",   x: 50, y: 38 },
      { id: "idea",     label: "Long Table", x: 50, y: 66 },
      { id: "break",    label: "Break Area", x: 86, y: 80 },
    ],
    props: [
      { cls: "shelf", x: 10, y: 24 }, { cls: "shelf", x: 30, y: 24 },
      { cls: "shelf", x: 70, y: 24 }, { cls: "shelf", x: 90, y: 24 },
      { cls: "table", x: 50, y: 62 }, { cls: "plant", x: 6, y: 78 },
      { cls: "plant", x: 94, y: 60 }, { cls: "cooler", x: 88, y: 74 },
    ],
  },

  studio: {
    name: "Studio Floor",
    blurb: "Ideas go up, critiques come back. The busiest room in the cycle.",
    fallbackZone: "break",
    zones: [
      { id: "idea",         label: "Idea Desks",       x: 30, y: 34 },
      { id: "critique",     label: "Critique Corner",  x: 76, y: 36 },
      { id: "research",     label: "Reading Nook",     x: 12, y: 62 },
      { id: "architecture", label: "Drafting Table",   x: 46, y: 64 },
      { id: "break",        label: "Break Area",       x: 82, y: 74 },
    ],
    props: [
      { cls: "desk", x: 20, y: 28 }, { cls: "desk", x: 40, y: 28 },
      { cls: "board", x: 76, y: 27 }, { cls: "shelf", x: 6, y: 52 },
      { cls: "table", x: 46, y: 60 }, { cls: "couch", x: 82, y: 70 },
      { cls: "cooler", x: 94, y: 76 }, { cls: "rug", x: 46, y: 76 },
      { cls: "plant", x: 62, y: 80 },
    ],
  },

  merge: {
    name: "Merge Tables",
    blurb: "Paired ideas meet. Either they combine, or both authors walk away.",
    fallbackZone: "break",
    zones: [
      { id: "collaboration", label: "Merge Tables", x: 50, y: 40 },
      { id: "idea",          label: "Idea Desks",   x: 16, y: 66 },
      { id: "break",         label: "Break Area",   x: 82, y: 72 },
    ],
    props: [
      { cls: "table", x: 34, y: 36 }, { cls: "table", x: 66, y: 36 },
      { cls: "desk", x: 16, y: 62 }, { cls: "couch", x: 82, y: 68 },
      { cls: "rug", x: 50, y: 52 }, { cls: "plant", x: 6, y: 82 },
      { cls: "plant", x: 94, y: 50 },
    ],
  },

  drafting: {
    name: "Drafting Room",
    blurb: "Only the top ideas get built out — half the room is watching.",
    fallbackZone: "break",
    zones: [
      { id: "architecture", label: "Drafting Tables", x: 42, y: 40 },
      { id: "critique",     label: "Review Wall",     x: 84, y: 40 },
      { id: "break",        label: "Observers",       x: 50, y: 74 },
    ],
    props: [
      { cls: "board", x: 84, y: 30 }, { cls: "table", x: 30, y: 36 },
      { cls: "table", x: 55, y: 36 }, { cls: "couch", x: 50, y: 70 },
      { cls: "rug", x: 50, y: 78 }, { cls: "shelf", x: 8, y: 30 },
      { cls: "plant", x: 8, y: 80 },
    ],
  },

  judging: {
    name: "Judging Hall",
    blurb: "Seven judges score the field. The agents can only wait.",
    fallbackZone: "break",
    zones: [
      { id: "judging", label: "Judges' Bench", x: 50, y: 30 },
      { id: "break",   label: "The Floor",     x: 50, y: 68 },
    ],
    props: [
      { cls: "table", x: 34, y: 26 }, { cls: "table", x: 66, y: 26 },
      { cls: "board", x: 50, y: 16 }, { cls: "rug", x: 50, y: 66 },
      { cls: "plant", x: 8, y: 40 }, { cls: "plant", x: 92, y: 40 },
    ],
  },

  /**
   * P2's team benches, kept as a set. Tribunal stays present because
   * tribunal_* tasks ARE per-agent and run at the end of a hackathon — agents
   * legitimately leave their benches for the circle, and a real task always
   * outranks bench placement (see zoneFor).
   */
  teams: {
    name: "Team Rooms",
    blurb: "Two teams, one build each. The ring marks whose turn it is.",
    fallbackZone: "break",
    zones: [
      { id: "team_alpha", label: "Team Alpha",      x: 24, y: 40 },
      { id: "team_beta",  label: "Team Beta",       x: 76, y: 40 },
      { id: "tribunal",   label: "Tribunal Circle", x: 50, y: 66 },
      { id: "break",      label: "Break Area",      x: 50, y: 80 },
    ],
    props: [
      { cls: "desk", x: 24, y: 34 }, { cls: "desk", x: 76, y: 34 },
      { cls: "board", x: 10, y: 30 }, { cls: "board", x: 90, y: 30 },
      { cls: "table", x: 50, y: 62 }, { cls: "couch", x: 50, y: 78 },
      { cls: "cooler", x: 92, y: 76 }, { cls: "plant", x: 6, y: 76 },
    ],
  },

  tribunal: {
    name: "Tribunal Circle",
    blurb: "Everyone reflects on what just happened, in front of everyone else.",
    fallbackZone: "tribunal",
    zones: [
      { id: "tribunal", label: "The Circle", x: 50, y: 46 },
      { id: "break",    label: "Break Area", x: 86, y: 80 },
    ],
    props: [
      { cls: "rug", x: 50, y: 50 }, { cls: "table", x: 50, y: 32 },
      { cls: "plant", x: 8, y: 34 }, { cls: "plant", x: 92, y: 34 },
      { cls: "couch", x: 86, y: 76 },
    ],
  },

  records: {
    name: "Hall of Records",
    blurb: "The cycle is closed. What is left is the archive.",
    fallbackZone: "break",
    zones: [
      { id: "team_alpha", label: "Winners",    x: 34, y: 40 },
      { id: "team_beta",  label: "Runners-up", x: 66, y: 44 },
      { id: "break",      label: "The Floor",  x: 50, y: 76 },
    ],
    props: [
      { cls: "board", x: 50, y: 18 }, { cls: "table", x: 34, y: 36 },
      { cls: "table", x: 66, y: 40 }, { cls: "rug", x: 50, y: 74 },
      { cls: "shelf", x: 8, y: 28 }, { cls: "shelf", x: 92, y: 28 },
    ],
  },
};

/**
 * Which set a given event is currently in.
 *
 * `ready_for_judging` and `judged` occur in BOTH event types, so the type has
 * to be part of the decision — keying on status alone would put an ideathon
 * mid-judging into a hackathon set.
 */
function setForEvent(event, hasRoster) {
  const status = String(event.status || "");
  if (event.type === "hackathon") {
    if (status === "tribunal") return SETS.tribunal;
    if (status === "complete") return SETS.records;
    if (status === "ready_for_judging" || status === "judged") return SETS.judging;
    // team_formation / building — benches need a roster to place anyone; without
    // one the studio is the honest render (see the note where hasRoster is set).
    return hasRoster ? SETS.teams : SETS.studio;
  }
  switch (status) {
    case "deep_research":     return SETS.library;
    case "ideation_critique": return SETS.studio;
    case "collaboration":     return SETS.merge;
    case "architecture":      return SETS.drafting;
    case "ready_for_judging":
    case "judged":            return SETS.judging;
    default:                  return SETS.studio;
  }
}

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
  /* agent_id -> { idea, critique, reflection }, the work itself (P3). */
  let artifacts = {};
  /* P5: the seven judges — roster, progress and which model actually answered. */
  let judging = null;
  let selectedJudge = null;
  /* P4: agent_id -> the pair it is part of, for the Merge Tables. */
  let collabByAgent = {};
  let collabPairs = [];
  /* P6: agent_id -> index into the set's loitering spots, for idle roaming. */
  let roamSpot = {};
  let roamTimer = 0;

  /* Motion for its own sake is exactly what this setting asks us not to do,
     so roaming and the pet are skipped entirely rather than merely shortened.
     Everything else in the room still works — this removes drift, not data. */
  const prefersReducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /**
   * P6: where an idle agent can loiter.
   *
   * Derived from the SET's own furniture rather than a separate table, so a
   * new set gets sensible loitering for free and can never point somewhere
   * it has no props. Agents stand slightly below a piece so they read as
   * being AT it rather than inside it.
   */
  function loiterSpots() {
    const landmarks = (SET.props || []).filter((p) => ["couch", "cooler", "plant", "shelf", "rug"].includes(p.cls));
    return landmarks.map((p) => ({ x: p.x, y: Math.min(92, p.y + 7) }));
  }
  /* agent_id -> roster row, populated for hackathons only. */
  let rosterByAgent = {};
  /* team_id -> latest build turn, for the CI badge on each bench. */
  let turnByTeam = {};
  /* team_id -> agent_id whose turn it is next. */
  let turnHolder = {};
  let SET = SETS.studio;
  let ZONES = SET.zones;
  let ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));
  let PROPS = SET.props;

  /**
   * P3: what this agent is currently making, as one short line.
   *
   * Matched to what they are DOING rather than just showing the newest thing
   * they produced — an agent at Critique Corner should be quoting its critique
   * even if it wrote an idea more recently. Returns null when there is nothing
   * real to say, and the bubble is then not rendered at all: an empty bubble
   * is worse than none, and inventing filler would repeat exactly the failure
   * (plausible text standing in for real work) this project keeps hitting.
   */
  function bubbleFor(agent) {
    const art = artifacts[agent.agent_id];
    if (!art) return null;
    const zone = taskInfo(agent.task_type) ? TASK[agent.task_type].zone : null;

    if (zone === "critique" && art.critique?.weakness) {
      return { kind: "critique", lead: art.critique.target_title ? `on “${art.critique.target_title}”` : "critique", text: art.critique.weakness };
    }
    if (zone === "tribunal" && art.reflection?.excerpt) {
      return { kind: "reflection", lead: String(art.reflection.type || "").replace("_", " "), text: art.reflection.excerpt };
    }
    if ((zone === "idea" || zone === "architecture") && art.idea?.title) {
      return { kind: "idea", lead: art.idea.title, text: art.idea.one_liner };
    }
    // Idle or at a bench: the last thing they actually shipped is still the
    // most informative thing about them.
    if (art.idea?.title) return { kind: "idea", lead: art.idea.title, text: art.idea.one_liner };
    if (art.critique?.weakness) return { kind: "critique", lead: "last critique", text: art.critique.weakness };
    return null;
  }

  /**
   * Where an agent stands. A real per-agent task always wins — during the
   * Tribunal at the end of a hackathon the tribunal_* tasks are genuinely
   * per-agent, and an agent doing real work should be at the work, not at a
   * bench. Team membership is the fallback that fills the otherwise-empty
   * building phase.
   */
  function zoneFor(agent) {
    const info = taskInfo(agent.task_type);
    // A real per-agent task always wins. During the Tribunal at the end of a
    // hackathon the tribunal_* tasks ARE per-agent, and an agent doing real
    // work belongs at the work, not at a bench.
    let wanted = info ? info.zone : null;
    // P4: an agent whose pair is still being decided belongs at the Merge
    // Table. Only PENDING pairs move anyone — once accepted or refused the
    // conversation is over and standing there would misrepresent a settled
    // outcome as an ongoing one.
    if (!wanted) {
      const pair = collabByAgent[agent.agent_id];
      if (pair && pair.state === "pending") wanted = "collaboration";
    }
    if (!wanted) {
      const member = rosterByAgent[agent.agent_id];
      wanted = member ? (member.team_name === "beta" ? "team_beta" : "team_alpha") : "break";
    }
    // The set decides which zones exist. Falling back rather than trusting the
    // id is what makes adding a set safe: a phase whose layout has no Critique
    // Corner must not place anyone at coordinates that are not in the room.
    return ZONE_BY_ID[wanted] ? wanted : (ZONE_BY_ID[SET.fallbackZone] ? SET.fallbackZone : ZONES[0].id);
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
    <div id="of-strip"></div>
    <div id="of-note"></div>
    <div class="v-office__set" id="of-set"></div>
    <div id="of-stage"><div class="arena-skel arena-skel--block" style="min-height:440px"></div></div>
    <p class="v-office__chronicle" id="of-chronicle" hidden></p>
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
  const teardownStrip = el.querySelector("#of-strip")
    ? mountArenaStrip(el.querySelector("#of-strip"), { eventId: event.id })
    : null;

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

  /**
   * P5: the seven judges, seated at the bench.
   *
   * Rendered as seats rather than characters on purpose — judges are a
   * separate roster with no agent_id and no sprite, and borrowing an agent's
   * sprite would imply they are one. A seat also carries what actually
   * matters about a judge (criterion, weight, progress) in a way a 64px
   * character cannot.
   *
   * Laid out across the bench zone in percentage space, so this inherits the
   * room's responsive width for free.
   */
  function drawJudges() {
    const layer = el.querySelector("#of-judges");
    if (!layer) return;
    const bench = ZONE_BY_ID.judging;
    if (!bench || !judging || !Array.isArray(judging.judges)) {
      layer.replaceChildren();   // no bench in this set, or no judging data yet
      return;
    }

    const list = judging.judges;
    const span = 74;                                  // % of room width the bench occupies
    const step = list.length > 1 ? span / (list.length - 1) : 0;
    const startX = bench.x - span / 2;

    render(layer, html`${list.map((j, i) => {
      const done = j.expected > 0 && j.scored >= j.expected;
      const working = !done && j.scored > 0;
      const pct = j.expected > 0 ? Math.round((j.scored / j.expected) * 100) : 0;
      return html`
        <div class="v-office__judge ${done ? "is-done" : working ? "is-working" : ""} ${j.modelDeviates ? "is-deviant" : ""} ${selectedJudge === j.name ? "is-selected" : ""}"
             id="of-judge-${j.name}" tabindex="0" role="button"
             style="left:${(startX + i * step).toFixed(2)}%;top:${bench.y}%"
             title="${j.name} — ${j.criterion} · weight ${Math.round(j.weight * 100)}% · ${j.scored}/${j.expected} scored${j.modelDeviates ? " · MODEL DEVIATES FROM THE PIN" : ""}">
          <div class="v-office__judge-seat"><span class="v-office__judge-initial">${j.name.slice(0, 1)}</span></div>
          <div class="v-office__judge-name">${j.name}</div>
          <div class="v-office__judge-bar"><span style="width:${pct}%"></span></div>
        </div>`;
    })}`);

    list.forEach((j) => {
      const node = layer.querySelector(`#of-judge-${CSS.escape(j.name)}`);
      if (!node) return;
      const pick = () => { selectedJudge = j.name; selectedId = null; drawJudges(); drawInspector(); };
      node.addEventListener("click", pick);
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
    });
  }

  /**
   * Keep every bubble inside the walls.
   *
   * Same reason the sprite clamp in draw() exists, and the same failure mode
   * the header comment already warns about: the bubble is a fixed PIXEL width
   * centred on a PERCENTAGE position, so an agent near a wall (Critique Corner
   * sits at 83%) pushes it straight through. Found overflowing by 7px on
   * desktop and 33px on mobile during verification.
   *
   * Must run on resize, not only on a data tick — draw() fires when the queue
   * changes, which can be minutes apart, so a window resize in between would
   * otherwise leave every bubble clamped to the old room width.
   */
  function clampBubbles() {
    const roomEl = el.querySelector("#of-room");
    if (!roomEl) return;
    const width = roomEl.getBoundingClientRect().width;
    if (!width) return;
    const margin = 6;

    Object.values(nodes).forEach((node) => {
      const b = node.bubbleEl;
      if (!b || b.hidden) return;
      const half = b.offsetWidth / 2;
      const centre = (node.x / 100) * width;
      let shift = 0;
      if (centre - half < margin) shift = margin - (centre - half);
      else if (centre + half > width - margin) shift = (width - margin) - (centre + half);
      shift = Math.round(shift);
      b.style.transform = `translateX(calc(-50% + ${shift}px))`;
      // The tail moves back by the same amount so it keeps pointing at its own
      // character instead of sliding off them.
      b.style.setProperty("--bubble-shift", `${-shift}px`);
    });
  }

  function drawInspector() {
    // P5: a selected judge takes the panel. Judges and agents are mutually
    // exclusive selections — picking one clears the other — because the panel
    // describes a single subject and a judge is not an agent.
    const j = selectedJudge && judging?.judges?.find((x) => x.name === selectedJudge);
    if (j) {
      const pinned = judging.pinned || {};
      render(inspectorEl, html`
        <div class="v-office__inspector-name">Judge ${j.name}</div>
        <div class="v-office__inspector-lens">${j.criterion} · ${Math.round(j.weight * 100)}% of the ${judging.phase} score</div>
        ${j.modelDeviates ? html`
          <div class="v-office__inspector-alert v-office__inspector-alert--stop">
            <b>This judge did not use the model pinned for the event.</b>
            Pinned <code>${pinned.model || "—"}</code>, but scores came from <code>${j.models.join(", ")}</code>.
            Mixing model families inside one weighted ranking is the failure P0-2 exists to prevent.
          </div>` : ""}
        <div class="v-office__inspector-rows">
          <div>Progress: <b>${j.scored} / ${j.expected} scored</b></div>
          <div>Average score: <b>${j.averageScore ?? "—"}</b></div>
          <div>Model: <b>${j.models.length ? j.models.join(", ") : "—"}</b></div>
        </div>
        ${j.latestRationale ? html`
          <div class="v-office__inspector-quote">“${j.latestRationale}”</div>` : ""}`);
      return;
    }

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
      ${(() => {
        // P4: who this agent is paired with, and how it went. Shown for
        // settled pairs too — "Gale refused Iris, and why" stays interesting
        // after the phase ends, and it is the only place the reason is
        // readable outside the raw interaction log.
        const pair = collabByAgent[a.agent_id];
        if (!pair) return "";
        const verb = pair.state === "accepted" ? "merged with"
          : pair.state === "refused" ? "declined a merge with"
          : pair.state === "failed" ? "pairing failed with"
          : "deciding on a merge with";
        return html`
          <div class="v-office__inspector-alert ${pair.state === "accepted" ? "v-office__inspector-alert--ok" : "v-office__inspector-alert--warn"}">
            <b>${verb} ${pair.partner.title}</b>
            ${pair.score != null ? html` · similarity ${pair.score}` : ""}
            ${pair.reason ? html`<div class="v-office__inspector-err">${pair.reason}</div>` : ""}
          </div>`;
      })()}
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
    selectedJudge = null;      // one subject in the panel at a time
    drawJudges();
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
        <div class="v-office__judges" id="of-judges"></div>
        <div class="v-office__pet" id="of-pet" hidden aria-hidden="true"></div>
        ${agents.filter((a) => CAST[a.agent_id]).map((a) => html`
          <div class="v-office__agent" id="of-agent-${a.agent_id}" tabindex="0" role="button" aria-label="${a.name}">
            <div class="v-office__bubble" hidden></div>
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
        bubbleEl: node.querySelector(".v-office__bubble"),
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

  /**
   * @param {object[]} agents
   * @param {{animate?: boolean}} [opts] animate:false repositions silently —
   *   used on resize, where every character's coordinates change because the
   *   room did, not because anyone moved. Replaying walk cycles there would
   *   have the whole cast stroll across the room every time the window is
   *   dragged.
   */
  function draw(agents, { animate = true, reshuffleRoam = false } = {}) {
    const first = !built;
    if (first) build(agents);
    // Before positions are computed — placement reads roamSpot.
    assignRoamSpots(agents, { reshuffleOne: reshuffleRoam });
    agents.forEach((a) => { latest[a.agent_id] = a; });

    // The room can genuinely be gone by now. mount() awaits several fetches,
    // and if the router swaps views during that window the outlet is wiped
    // before this mount's teardown exists to set `disposed` — so an in-flight
    // draw runs against detached DOM. Observed as a real TypeError while
    // navigating quickly between views; the same race the router's own header
    // comment describes, just landing here.
    const roomEl = el.querySelector("#of-room");
    if (!roomEl) return;
    const room = roomEl.getBoundingClientRect();

    // Character size, measured — the root cause of the room feeling cramped
    // was a fixed 64px character on a percentage grid, so density changed
    // with viewport instead of staying constant. 8.5% of room width keeps
    // the character at roughly two-thirds of the row pitch below; the 64px
    // ceiling preserves the original desktop look and the 36px floor stops
    // it disappearing on a phone.
    //
    // Written straight onto each element rather than through CSS. Two other
    // routes were tried against a live room and both failed the same way —
    // the agents' style simply did not re-resolve:
    //   - `clamp(36px, 8.5cqw, 64px)`: a probe element with the SAME parent
    //     computed 61px while an agent computed 64px, the agent still
    //     resolving cqw against the viewport.
    //   - an inherited `--office-char` set on the room: the agent's computed
    //     value read 59px while its width still resolved to the 64px var()
    //     fallback.
    // An explicit inline width has no such ambiguity, and this loop already
    // touches every node. Applied before the probe is measured — the pitch
    // maths below reads the character's real rendered width.
    if (room.width) {
      const charPx = Math.round(Math.max(36, Math.min(64, room.width * 0.085)));
      Object.values(nodes).forEach((n) => {
        n.el.style.width = `${charPx}px`;
        n.el.style.height = `${charPx}px`;
      });
    }

    const probe = nodes[agents[0] && agents[0].agent_id];
    const halfW = probe ? probe.el.offsetWidth / 2 : 32;
    const padX = room.width ? (halfW / room.width) * 100 + 1 : 7;
    const padTop = room.height ? ((probe ? probe.el.offsetHeight : 64) / room.height) * 100 + 14 : 17;
    const padBottom = room.height ? (18 / room.height) * 100 : 4;

    // Spacing derives from the character's REAL rendered size rather than the
    // old hardcoded 11%. Scaling the sprite alone would not have helped: an
    // 11% pitch is 63px in a 573px room against what used to be a 64px
    // character, so the overlap came from the pitch being a percentage while
    // the character was pixels. Both ends are measured now, so the gap stays
    // proportional at every width.
    //
    // 1.35x horizontally leaves ~26% of the pitch as gap — which lands within
    // a percent of the original 11% at desktop width, so the desktop layout is
    // preserved rather than re-tuned. 1.5x vertically because the name label
    // sits below the sprite and needs the extra room.
    const charW = probe ? probe.el.offsetWidth : 64;
    const charH = probe ? probe.el.offsetHeight : 64;
    const colPitch = room.width ? (charW * 1.35 / room.width) * 100 : 11;
    const rowPitch = room.height ? (charH * 1.5 / room.height) * 100 : 11;

    const perZone = {};
    agents.forEach((a) => { (perZone[zoneFor(a)] ||= []).push(a); });

    Object.keys(perZone).forEach((zoneId) => {
      const group = perZone[zoneId];
      const zone = ZONE_BY_ID[zoneId];
      // Rows of at most 4, but fewer when the room cannot fit 4 — all 12
      // legitimately share one zone during a hackathon, and on a narrow room a
      // 4-wide row overruns the walls and collides with the neighbouring
      // zone's row. Falling back to more, shorter rows keeps them apart.
      const fitPerRow = Math.max(1, Math.floor((100 - 2 * padX) / colPitch));
      const perRow = Math.max(1, Math.min(4, group.length, fitPerRow));
      const rowCount = Math.ceil(group.length / perRow);

      group.forEach((a, i) => {
        const node = nodes[a.agent_id];
        if (!node) return;
        const r = Math.floor(i / perRow), c = i % perRow;
        const inRow = Math.min(perRow, group.length - r * perRow);
        let x = clamp(zone.x + (c - (inRow - 1) / 2) * colPitch, padX, 100 - padX);
        let y = clamp(zone.y + r * rowPitch - (rowCount - 1) * (rowPitch / 2), padTop, 100 - padBottom);

        // P6: a genuinely idle agent loiters by the furniture instead of
        // standing in a parade-ground row. A quiet room should read as calm;
        // twelve characters in rigid formation reads as frozen, which is the
        // wrong signal given how much of a real cycle is legitimately quiet.
        const spot = roamSpot[a.agent_id];
        if (zoneId === "break" && spot) {
          x = clamp(spot.x, padX, 100 - padX);
          y = clamp(spot.y, padTop, 100 - padBottom);
        }

        place(node, x, y, animate && !first);

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

        // P3: the work itself. Rendered as text nodes rather than innerHTML —
        // every string here is LLM output, and it reaches the DOM without
        // passing through the template escaper.
        const bubble = bubbleFor(a);
        if (node.bubbleEl) {
          node.bubbleEl.textContent = "";
          if (bubble) {
            const lead = document.createElement("b");
            lead.textContent = bubble.lead;
            node.bubbleEl.append(lead);
            if (bubble.text) {
              const body = document.createElement("span");
              body.textContent = bubble.text;
              node.bubbleEl.append(body);
            }
            node.bubbleEl.hidden = false;
            node.bubbleEl.dataset.kind = bubble.kind;
          } else {
            node.bubbleEl.hidden = true;
          }
        }
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

    clampBubbles();
    drawJudges();
    drawPet(agents);
    drawInspector();
  }

  /**
   * Who is free to wander. Deliberately narrow:
   *
   *  - an agent with a real task is at that task, not loitering;
   *  - an ABANDONED agent must not drift. It is greyed out because the
   *    scheduler gave up on it, and a character that strolls around looks
   *    content — which would quietly undo the whole point of P1;
   *  - a struggling agent is mid-retry, and a wandering warning badge reads
   *    as careless.
   */
  function canRoam(agent) {
    return !taskInfo(agent.task_type) && !agent.abandoned && !(agent.failed_attempts > 0);
  }

  /** Give each idle agent a loitering spot, keeping them off each other. */
  function assignRoamSpots(agents, { reshuffleOne = false } = {}) {
    if (prefersReducedMotion) { roamSpot = {}; return; }
    const spots = loiterSpots();
    if (!spots.length) { roamSpot = {}; return; }

    const idle = agents.filter((a) => canRoam(a) && zoneFor(a) === "break");
    const idleIds = new Set(idle.map((a) => a.agent_id));
    // Anyone who stopped being idle gives their spot back.
    for (const id of Object.keys(roamSpot)) if (!idleIds.has(id)) delete roamSpot[id];

    const taken = new Set(Object.values(roamSpot).map((s) => s.index));
    const free = () => spots.map((_, i) => i).filter((i) => !taken.has(i));

    if (reshuffleOne && idle.length) {
      // Move exactly one agent per tick. Moving several at once looks like a
      // scene change rather than someone getting up.
      const mover = idle[Math.floor(Math.random() * idle.length)];
      const options = free();
      if (options.length) {
        const prev = roamSpot[mover.agent_id];
        if (prev) taken.delete(prev.index);
        const pick = options[Math.floor(Math.random() * options.length)];
        roamSpot[mover.agent_id] = { ...spots[pick], index: pick };
        taken.add(pick);
      }
    }

    for (const a of idle) {
      if (roamSpot[a.agent_id]) continue;
      const options = free();
      if (!options.length) break;   // more idle agents than furniture — the rest keep the grid
      const pick = options[Math.floor(Math.random() * options.length)];
      roamSpot[a.agent_id] = { ...spots[pick], index: pick };
      taken.add(pick);
    }
  }

  /**
   * P6: the office pet. Naps beside whoever has been idle longest, which is a
   * cheap way to make "nothing is happening" look intentional.
   *
   * Drawn in CSS like the furniture — the 3D pet packs in the asset dump would
   * need the Blender render pipeline to match the characters' style, and a
   * mismatched sprite would look worse than a shape.
   */
  function drawPet(agents) {
    const pet = el.querySelector("#of-pet");
    if (!pet) return;
    if (prefersReducedMotion) { pet.hidden = true; return; }

    const idle = agents.filter((a) => canRoam(a) && nodes[a.agent_id]);
    if (!idle.length) { pet.hidden = true; return; }

    // Oldest updated_at = idle longest. Missing timestamps sort first, which
    // is right: an agent with no activity at all is the most idle of all.
    const host = idle.slice().sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")))[0];
    const node = nodes[host.agent_id];
    pet.hidden = false;
    pet.style.left = `${clamp(node.x + 3.5, 2, 96)}%`;
    pet.style.top = `${node.y}%`;
    pet.style.zIndex = String(10 + Math.round(node.y * 2) + 1);
    pet.title = `Napping next to ${host.name}, who has been idle longest`;
  }

  // Layout depends on the room's pixel size, which changes on resize with no
  // data change at all — so it cannot ride on the data tick. Since characters
  // now scale with the room (--office-char), their spacing changes too, and a
  // resize without a re-layout would leave them at coordinates computed for
  // the old character size. rAF-coalesced because resize fires continuously
  // while dragging.
  // Debounced with a timer rather than requestAnimationFrame: rAF is
  // suspended whenever the page is not compositing — a background tab, or a
  // hidden pane — so an rAF-coalesced handler silently never runs and the
  // layout stays sized for the old room until the next data tick, which can
  // be minutes away. Found exactly that while verifying this: rAF never
  // fired in the preview pane.
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = 0;
      const known = Object.values(latest);
      if (built && known.length) draw(known, { animate: false });
      else clampBubbles();
    }, 120);
  };
  window.addEventListener("resize", onResize);

  /**
   * P6: nudge one idle agent to a different spot every so often.
   *
   * 14s, and only one agent at a time, because the point is ambient life
   * rather than activity — a room where several characters relocate at once
   * reads as something happening, and something happening is exactly the
   * signal the rest of this view works hard to report honestly. Skipped
   * entirely under reduced motion, and cleared in teardown like every other
   * timer this file owns.
   */
  const ROAM_INTERVAL_MS = 14_000;
  function scheduleRoam() {
    if (prefersReducedMotion) return;
    roamTimer = setTimeout(() => {
      if (disposed) return;
      const known = Object.values(latest);
      if (built && known.length) draw(known, { reshuffleRoam: true });
      scheduleRoam();
    }, ROAM_INTERVAL_MS);
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
  // Judging data is only fetched for the phases that have any — it is three
  // queries server-side, and asking for it during deep_research would be a
  // round trip for a guaranteed-empty answer.
  const isJudgingPhase = event.status === "ready_for_judging" || event.status === "judged";
  // Collaboration outlives its own phase: pairs decided during `collaboration`
  // still explain why an idea has two authors when you look back during
  // architecture or judging, so this is fetched for any ideathon rather than
  // only while the phase is live.
  const wantsCollab = event.type === "ideathon";
  const [activity, teams, roster, turns, arts, chronicle, judgingData, collabData] = await Promise.all([
    fetchJson(`/events/${encodeURIComponent(event.id)}/agent-activity`, { optional: true }),
    isHackathon ? fetchJson(`/events/${encodeURIComponent(event.id)}/teams`, { optional: true }) : Promise.resolve([]),
    isHackathon ? fetchJson(`/events/${encodeURIComponent(event.id)}/roster`, { optional: true }) : Promise.resolve([]),
    isHackathon ? fetchJson(`/events/${encodeURIComponent(event.id)}/build-turns`, { optional: true }) : Promise.resolve([]),
    // Both optional: they postdate the Worker the Pages site may be talking
    // to, and the room is still correct without them — bubbles and the
    // caption simply don't render.
    fetchJson(`/events/${encodeURIComponent(event.id)}/agent-artifacts`, { optional: true }),
    fetchJson(`/events/${encodeURIComponent(event.id)}/chronicle`, { optional: true }),
    isJudgingPhase ? fetchJson(`/events/${encodeURIComponent(event.id)}/judging`, { optional: true }) : Promise.resolve(null),
    wantsCollab ? fetchJson(`/events/${encodeURIComponent(event.id)}/collaborations`, { optional: true }) : Promise.resolve(null),
  ]);
  if (disposed) return () => {};
  if (arts) artifacts = arts;
  if (judgingData) judging = judgingData;
  if (collabData) applyCollaborations(collabData);

  /** Index pairs by agent so zoneFor can ask "is this agent mid-negotiation?". */
  function applyCollaborations(pairs) {
    collabPairs = Array.isArray(pairs) ? pairs : [];
    collabByAgent = {};
    for (const p of collabPairs) {
      // Both sides of a pending pair walk to the table; the proposer is `a`.
      collabByAgent[p.a.agent_id] = { ...p, side: "a", partner: p.b };
      collabByAgent[p.b.agent_id] = { ...p, side: "b", partner: p.a };
    }
  }

  // P3: the Chronicler's line for the most recent phase, as a caption under
  // the room. Set as textContent — this is model-generated prose reaching the
  // DOM outside the template escaper.
  const chronicleEl = el.querySelector("#of-chronicle");
  const latestChronicle = Array.isArray(chronicle) && chronicle.length ? chronicle[chronicle.length - 1] : null;
  if (chronicleEl && latestChronicle?.narrative) {
    chronicleEl.textContent = `“${latestChronicle.narrative}” — the Chronicler, on ${latestChronicle.phase}`;
    chronicleEl.hidden = false;
  }

  /**
   * P2: swap the room to team benches for a hackathon, but only if a roster
   * actually came back. Teams formed before rosters existed have none, and
   * older Workers have no /roster or /build-turns route at all — in both cases
   * the ideathon layout plus the original banner is still the correct render,
   * so this degrades to exactly the previous behaviour rather than an empty
   * room.
   */
  const hasRoster = isHackathon && Array.isArray(roster) && roster.length > 0;
  if (hasRoster) rosterByAgent = Object.fromEntries(roster.map((m) => [m.agent_id, m]));

  // Pick the set for whatever phase this event is in, then bind the team zones
  // to real team ids so the CI badge and turn ring have something to key on.
  // Zones are copied, never mutated — SETS is module-level and shared across
  // every mount, so writing teamId onto it would leak one event's teams into
  // the next event rendered.
  SET = setForEvent(event, hasRoster);
  ZONES = SET.zones.map((z) => {
    if (z.id !== "team_alpha" && z.id !== "team_beta") return { ...z };
    const wanted = z.id === "team_beta" ? "beta" : "alpha";
    const team = (teams || []).find((t) => t.team_name === wanted);
    return { ...z, teamId: team ? team.id : "", label: team ? `Team ${wanted}` : z.label };
  });
  ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));
  PROPS = SET.props;
  if (hasRoster) applyTurnState(turns, roster);

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

  // Name the set. The room changing shape between phases is only legible if
  // it says which room it is — otherwise a returning viewer just sees the
  // furniture moved.
  render(el.querySelector("#of-set"), html`
    <span class="v-office__set-name">${SET.name}</span>
    <span class="v-office__set-blurb">${SET.blurb}</span>`);

  // P4: what the pairing actually produced. Refusals are reported alongside
  // merges rather than hidden — an agent declining is a legitimate spec
  // outcome, and a room that only showed successful merges would overstate
  // how much collaboration is really happening.
  if (collabPairs.length) {
    const n = (s) => collabPairs.filter((p) => p.state === s).length;
    const pending = n("pending"), accepted = n("accepted"), refused = n("refused");
    render(noteEl, html`<div class="arena-note"><span>🤝</span><span>
      <b>Collaboration — ${collabPairs.length} pair(s) proposed.</b>
      ${accepted} merged, ${refused} refused, ${pending} still deciding.
      Pairs are chosen by embedding similarity, then each responding agent accepts or refuses in character — refusing is allowed, so a low merge count is a real result rather than a broken step.
    </span></div>`);
  }

  // P5: the judging contract, stated where the judging happens. The pinned
  // model matters because a mid-event swap mixes model families into one
  // weighted ranking (P0-2), and a failed calibration matters because judging
  // proceeds anyway by design (P2-7) — both are decisions a reader of the
  // result should be able to see, not infer.
  if (judging) {
    const cal = judging.calibration;
    const deviants = judging.judges.filter((j) => j.modelDeviates).map((j) => j.name);
    render(noteEl, html`<div class="arena-note ${deviants.length || (cal && !cal.passed) ? "arena-note--warn" : ""}"><span>⚖️</span><span>
      <b>Judging — ${judging.judges.filter((j) => j.expected > 0 && j.scored >= j.expected).length}/${judging.judges.length} judges finished</b>
      across ${judging.expected} ${judging.phase === "hackathon" ? "team(s)" : "idea(s)"}.
      Pinned model: <code>${judging.pinned.model || "not pinned"}</code>${judging.pinned.provider ? html` (${judging.pinned.provider})` : ""}.
      ${cal ? html` Calibration correlation ${Number(cal.correlation).toFixed(2)} — ${cal.passed ? "passed" : "FAILED, scores are low-confidence"}.` : " No calibration recorded."}
      ${deviants.length ? html` <b>${deviants.join(", ")} did not use the pinned model.</b>` : ""}
    </span></div>`);
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
  scheduleRoam();

  // Re-draw off the shared store tick rather than a private timer.
  const off = store.events.subscribe(async () => {
    if (disposed) return;
    // Turn state is refetched alongside activity: during a hackathon it is the
    // only thing that actually changes between ticks, so polling activity
    // alone would leave the CI badge and the turn ring permanently stale.
    const [next, nextTurns, nextRoster, nextJudging, nextCollab] = await Promise.all([
      fetchJson(`/events/${encodeURIComponent(event.id)}/agent-activity`, { optional: true }),
      hasRoster ? fetchJson(`/events/${encodeURIComponent(event.id)}/build-turns`, { optional: true }) : Promise.resolve(null),
      hasRoster ? fetchJson(`/events/${encodeURIComponent(event.id)}/roster`, { optional: true }) : Promise.resolve(null),
      // Scores landing one at a time IS the interesting motion during judging,
      // and no agent has a queue row then — polling activity alone would leave
      // the bench frozen through the whole phase.
      isJudgingPhase ? fetchJson(`/events/${encodeURIComponent(event.id)}/judging`, { optional: true }) : Promise.resolve(null),
      // Pairs resolving one at a time IS the motion of the collaboration
      // phase, and it produces no per-agent queue rows — polling activity
      // alone would leave the Merge Tables frozen through the whole phase,
      // the same way it would have frozen the judges' bench.
      wantsCollab ? fetchJson(`/events/${encodeURIComponent(event.id)}/collaborations`, { optional: true }) : Promise.resolve(null),
    ]);
    if (disposed || !next) return;
    if (nextRoster && nextRoster.length) rosterByAgent = Object.fromEntries(nextRoster.map((m) => [m.agent_id, m]));
    if (nextTurns) applyTurnState(nextTurns, nextRoster || Object.values(rosterByAgent));
    if (nextJudging) judging = nextJudging;
    if (nextCollab) applyCollaborations(nextCollab);
    draw(next);
  });

  return () => {
    disposed = true;
    off();
    if (teardownStrip) teardownStrip();
    // The whole point of the teardown contract: 12 characters x 2 timers,
    // plus the resize listener and any frame it has pending — a listener that
    // outlives its view is the same leak in a different shape.
    window.removeEventListener("resize", onResize);
    clearTimeout(resizeTimer);
    clearTimeout(roamTimer);
    Object.values(nodes).forEach(stopWalk);
  };
}
