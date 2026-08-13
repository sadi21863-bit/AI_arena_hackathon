/**
 * Arena Archive — one card per ARENA, where an arena is the full family:
 * the ideathon and every hackathon it spawned (event.parent_event_id chain).
 * One aggregated /events/summary payload; the root ideathon defines the
 * arena's number and lifecycle, and each hackathon child renders as a phase
 * block inside the same card next to the ideathon's own statistics.
 *
 * The Live/Office views are scoped to the current arena by design; this is
 * the one place the full record — investment, outcomes, failures — is
 * readable at a glance, from the current cycle back through every judged
 * ideathon and completed hackathon.
 */

import { fetchJson } from "../core/api.js";
import { html, render } from "../core/html.js";
import { utcDate, relativeTime } from "../core/fmt.js";

const POLL_MS = 120_000;

const STATUS_CLASS = {
  deep_research: "", ideation_critique: "", collaboration: "", architecture: "",
  ready_for_judging: "arena-chip--warn", judged: "arena-chip--ok",
  team_formation: "", building: "", tribunal: "arena-chip--warn",
  complete: "arena-chip--ok", failed: "arena-chip--bad", abandoned: "arena-chip--bad",
};

const STATUS_LABEL = {
  deep_research: "Deep research", ideation_critique: "Ideation + critique",
  collaboration: "Collaboration", architecture: "Architecture",
  ready_for_judging: "Judging", judged: "Judged",
  team_formation: "Team formation", building: "Building",
  tribunal: "Tribunal", complete: "Complete", failed: "Failed", abandoned: "Abandoned",
};

const terminal = ["judged", "complete", "failed", "abandoned"];

function chip(text, cls = "") {
  return html`<span class="arena-chip ${cls}">${text}</span>`;
}

function stat(label, value, title = "") {
  return html`<div class="v-archive__stat" ${title ? `title="${title}"` : ""}>
    <div class="v-archive__stat-value">${value}</div>
    <div class="v-archive__stat-label">${label}</div>
  </div>`;
}

function id8(id) {
  return id.replace(/^event_/, "").slice(0, 8);
}

function span(arena) {
  const end = arena.end_date || arena.last_progress_at;
  if (!arena.start_date || !end) return null;
  const ms = new Date(end.replace(" ", "T") + "Z") - new Date(arena.start_date.replace(" ", "T") + "Z");
  return Math.max(1, Math.round(ms / 86_400_000));
}

function failureWarn(c) {
  return c.queueFailed > 0
    ? html`<span class="v-archive__warn" title="${c.queueFailed} failed queue items over the arena's life">⚠ ${c.queueFailed} queue failures</span>`
    : "";
}

function winnerNote(arena) {
  return arena.winner
    ? html`<div class="arena-note arena-note--ok"><span>🏆</span><span>
        Winner: <b>${arena.winner.team ?? "—"}</b> built
        <b>${arena.winner.idea ?? "—"}</b></span></div>`
    : "";
}

function topsNote(arena) {
  return arena.topIdeas.length
    ? html`<div class="v-archive__tops">
        ${arena.topIdeas.map((t) => html`<span class="arena-chip arena-chip--ok">${t.score.toFixed(2)} — ${t.title}</span>`)}
      </div>`
    : "";
}

function meta(arena, extra = "") {
  return html`
    <div class="v-archive__meta">
      <span>started ${utcDate(arena.start_date)}${span(arena) ? ` · ${span(arena)} days` : ""}</span>
      ${arena.end_date ? html`<span> · ended ${utcDate(arena.end_date)}` : ""}
      ${extra}
    </div>`;
}

function ideathonStats(c) {
  return html`
    ${stat("ideas", c.ideas ?? 0)}
    ${stat("critiques", c.critiques ?? 0)}
    ${stat("judge scores", c.judgeScores ?? 0, "Individual judge criterion scores")}
    ${stat("chronicle", c.chronicle ?? 0, "Chronicler narratives written")}
    ${stat("tribunal", c.tribunalReflections ?? 0, "Post-event reflections")}
    ${stat("done", c.queueCompleted ?? 0, "Completed queue items")}`;
}

function hackathonStats(c) {
  return html`
    ${stat("teams", c.teams ?? 0)}
    ${stat("build turns", c.buildTurns ?? 0, `${c.buildSuccesses ?? 0} success · ${c.buildFailures ?? 0} failure · ${c.buildCancelled ?? 0} cancelled`)}
    ${stat("judge scores", c.judgeScores ?? 0, "Individual judge criterion scores")}
    ${stat("tribunal", c.tribunalReflections ?? 0, "Post-event reflections")}
    ${stat("done", c.queueCompleted ?? 0, "Completed queue items")}`;
}

function phaseLinks(arena, type) {
  const links = [
    ["Office", `/observatory/office/${arena.id}`],
    ["Arena", `/observatory/arena/${arena.id}`],
    ["Ideas", `/observatory/ideas/${arena.id}`],
  ];
  if (type === "hackathon") {
    links.push(["Diff", `/observatory/diff/${arena.id}`], ["Tribunal", `/observatory/tribunal/${arena.id}`]);
  }
  return html`<footer class="v-archive__links">
    ${links.map(([label, href]) => html`<a class="arena-btn arena-btn--sm arena-btn--ghost" href="${href}">${label}</a>`)}
  </footer>`;
}

/** One hackathon child inside an arena card. */
function hackathonBlock(h) {
  const c = h.counts || {};
  return html`
    <section class="v-archive__phase">
      <header class="v-archive__phase-head">
        <h3>Hackathon <span class="v-archive__id">${id8(h.id)}</span></h3>
        <div class="v-archive__chips">
          ${chip(STATUS_LABEL[h.status] ?? h.status, STATUS_CLASS[h.status] ?? "")}
          ${failureWarn(c)}
        </div>
      </header>
      ${meta(h)}
      ${winnerNote(h)}
      <div class="v-archive__stats">${hackathonStats(c)}</div>
      ${phaseLinks(h, "hackathon")}
    </section>`;
}

/** One arena card: the root ideathon plus every hackathon it spawned. */
function arenaCard(g, index) {
  const root = g.root;
  const c = root.counts || {};
  const isLive = !root.end_date && !terminal.includes(root.status);
  const hacks = [...g.children].sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""));

  const head = root.type === "ideathon"
    ? html`<span class="arena-eyebrow">Arena ${index}</span>
        <h2>Ideathon <span class="v-archive__id">${id8(root.id)}</span></h2>`
    : html`<span class="arena-eyebrow">Arena ${index}</span>
        <h2>Hackathon <span class="v-archive__id">${id8(root.id)}</span></h2>`;

  const chips = html`
    <div class="v-archive__chips">
      ${isLive ? chip("LIVE", "arena-chip--live") : ""}
      ${chip(STATUS_LABEL[root.status] ?? root.status, STATUS_CLASS[root.status] ?? "")}
      ${root.type === "ideathon" && root.calibration
        ? chip(`calibration ${(root.calibration.correlation * 100).toFixed(0)}%${root.calibration.passed ? "" : " ⚠"}`, root.calibration.passed ? "" : "arena-chip--warn")
        : ""}
      ${failureWarn(c)}
    </div>`;

  return html`
    <article class="arena-card v-archive__card" id="${root.id}">
      <header class="v-archive__head">
        <div class="v-archive__title">${head}</div>
        ${chips}
      </header>

      ${meta(root)}

      ${root.abandoned_at
        ? html`<div class="arena-note arena-note--danger"><span>⚠</span><span>Abandoned ${relativeTime(root.abandoned_at)}: ${root.abandoned_reason ?? "no reason recorded"}</span></div>`
        : ""}

      <div class="v-archive__stats">${ideathonStats(c)}</div>
      ${topsNote(root)}
      ${phaseLinks(root, "ideathon")}

      ${hacks.length ? html`<h3 class="v-archive__phase-label">Hackathon${hacks.length > 1 ? "s" : ""} · ${hacks.length}</h3>` : ""}
      ${hacks.map(hackathonBlock)}
    </article>`;
}

export async function mount(el) {
  let timer = null;
  let disposed = false;

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · the full record</div>
      <h1>Arena Archive</h1>
      <p>Every arena the system has run — an ideathon and the hackathons it spawned, cadence, ideas, judging, builds, tribunal — in one place. Live views follow the current arena; this is the archive that outlives it.</p>
    </header>
    <div id="ar-body"><div class="arena-state">Loading the archive…</div></div>
    <p class="arena-freshness" data-freshness></p>`);

  const body = el.querySelector("#ar-body");
  const fresh = el.querySelector("[data-freshness]");

  async function load() {
    const arenas = await fetchJson("/events/summary", { ttl: 60_000, optional: true });
    if (disposed) return;
    if (!arenas || !arenas.length) {
      render(body, html`<div class="arena-state arena-state--error">Couldn't load the archive.</div>`);
      return;
    }

    // Group into arena families: walk each event's parent chain up to its
    // root ideathon; rootless events stand alone. Hackathons ride inside
    // their root's card, newest first by when the family started.
    const byId = new Map(arenas.map((a) => [a.id, a]));
    const rootOf = (a) => {
      let cur = a;
      const seen = new Set();
      while (cur.parent_event_id && byId.has(cur.parent_event_id) && !seen.has(cur.parent_event_id)) {
        seen.add(cur.parent_event_id);
        cur = byId.get(cur.parent_event_id);
      }
      return cur;
    };
    const groups = new Map();
    for (const a of arenas) {
      const root = rootOf(a);
      const g = groups.get(root.id) ?? { root, children: [] };
      if (root.id !== a.id) g.children.push(a);
      groups.set(root.id, g);
    }
    const familyList = [...groups.values()].sort((x, y) =>
      (y.root.start_date ?? "").localeCompare(x.root.start_date ?? ""));

    render(body, html`<div class="v-archive__list">${familyList.map((g, i) => arenaCard(g, familyList.length - i))}</div>`);

    const last = familyList[0]?.root;
    if (fresh) fresh.textContent = `updated ${relativeTime(last?.last_progress_at ?? last?.created_at)} · ${familyList.length} arenas`;
  }

  await load();
  timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);

  return () => { disposed = true; clearInterval(timer); };
}