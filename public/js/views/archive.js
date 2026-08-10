/**
 * Arena Archive — every arena the system has run, one card each, from the
 * single aggregated /events/summary payload.
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

function chip(text, cls = "") {
  return html`<span class="arena-chip ${cls}">${text}</span>`;
}

function stat(label, value, title = "") {
  return html`<div class="v-archive__stat" ${title ? `title="${title}"` : ""}>
    <div class="v-archive__stat-value">${value}</div>
    <div class="v-archive__stat-label">${label}</div>
  </div>`;
}

function arenaRow(arena, index) {
  const c = arena.counts || {};
  const isLive = !arena.end_date && !["judged", "complete", "failed", "abandoned"].includes(arena.status);
  const number = arena.id.replace(/^event_/, "").slice(0, 8);
  const days = (() => {
    const end = arena.end_date || arena.last_progress_at;
    if (!arena.start_date || !end) return null;
    const ms = new Date(end.replace(" ", "T") + "Z") - new Date(arena.start_date.replace(" ", "T") + "Z");
    return Math.max(1, Math.round(ms / 86_400_000));
  })();

  const winner = arena.winner
    ? html`<div class="arena-note arena-note--ok"><span>🏆</span><span>
        Winner: <b>${arena.winner.team ?? "—"}</b> built
        <b>${arena.winner.idea ?? "—"}</b></span></div>`
    : arena.topIdeas.length
      ? html`<div class="v-archive__tops">
          ${arena.topIdeas.map((t) => html`<span class="arena-chip arena-chip--ok">${t.score.toFixed(2)} — ${t.title}</span>`)}
        </div>`
      : "";

  const failureWarn = c.queueFailed > 0
    ? html`<span class="v-archive__warn" title="${c.queueFailed} failed queue items over the arena's life">⚠ ${c.queueFailed} queue failures</span>`
    : "";

  const lineage = arena.parent_event_id
    ? html`<a class="v-archive__lineage" href="/observatory/archive#${arena.parent_event_id}">from arena ${arena.parent_event_id.replace(/^event_/, "").slice(0, 8)}</a>`
    : "";

  return html`
    <article class="arena-card v-archive__card" id="${arena.id}">
      <header class="v-archive__head">
        <div class="v-archive__title">
          <span class="arena-eyebrow">Arena ${index}</span>
          <h2>${arena.type === "ideathon" ? "Ideathon" : "Hackathon"} <span class="v-archive__id">${number}</span></h2>
        </div>
        <div class="v-archive__chips">
          ${isLive ? chip("LIVE", "arena-chip--live") : ""}
          ${chip(STATUS_LABEL[arena.status] ?? arena.status, STATUS_CLASS[arena.status] ?? "")}
          ${arena.type === "ideathon" && arena.calibration
            ? chip(`calibration ${(arena.calibration.correlation * 100).toFixed(0)}%${arena.calibration.passed ? "" : " ⚠"}`, arena.calibration.passed ? "" : "arena-chip--warn")
            : ""}
          ${failureWarn}
        </div>
      </header>

      <div class="v-archive__meta">
        <span>started ${utcDate(arena.start_date)}${days ? ` · ${days} day${days === 1 ? "" : "s"}` : ""}</span>
        ${arena.end_date ? html`<span> · ended ${utcDate(arena.end_date)}` : ""}
        ${lineage}
      </div>

      ${winner}

      ${arena.abandoned_at
        ? html`<div class="arena-note arena-note--danger"><span>⚠</span><span>Abandoned ${relativeTime(arena.abandoned_at)}: ${arena.abandoned_reason ?? "no reason recorded"}</span></div>`
        : ""}

      <div class="v-archive__stats">
        ${stat("ideas", c.ideas ?? 0)}
        ${stat("critiques", c.critiques ?? 0)}
        ${stat("judge scores", c.judgeScores ?? 0, "Individual judge criterion scores")}
        ${arena.type === "hackathon" ? stat("teams", c.teams ?? 0) : ""}
        ${arena.type === "hackathon" ? stat("build turns", c.buildTurns ?? 0, `${c.buildSuccesses ?? 0} success · ${c.buildFailures ?? 0} failure · ${c.buildCancelled ?? 0} cancelled`) : ""}
        ${stat("chronicle", c.chronicle ?? 0, "Chronicler narratives written")}
        ${stat("tribunal", c.tribunalReflections ?? 0, "Post-event reflections")}
        ${stat("done", c.queueCompleted ?? 0, "Completed queue items")}
      </div>

      <footer class="v-archive__links">
        <a class="arena-btn arena-btn--sm arena-btn--ghost" href="/observatory/office/${arena.id}">Office</a>
        <a class="arena-btn arena-btn--sm arena-btn--ghost" href="/observatory/graph/${arena.id}">Graph</a>
        <a class="arena-btn arena-btn--sm arena-btn--ghost" href="/observatory/ideas/${arena.id}">Ideas</a>
        <a class="arena-btn arena-btn--sm arena-btn--ghost" href="/observatory/replay/${arena.id}">Replay</a>
        ${arena.type === "hackathon" ? html`<a class="arena-btn arena-btn--sm arena-btn--ghost" href="/observatory/diff/${arena.id}">Diff</a>` : ""}
        ${arena.type === "hackathon" ? html`<a class="arena-btn arena-btn--sm arena-btn--ghost" href="/observatory/tribunal/${arena.id}">Tribunal</a>` : ""}
      </footer>
    </article>`;
}

export async function mount(el) {
  let timer = null;
  let disposed = false;

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · the full record</div>
      <h1>Arena Archive</h1>
      <p>Every arena the system has run — cadence, ideas, judging, builds, tribunal — in one place. Live views follow the current arena; this is the archive that outlives it.</p>
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

    // newest first; index numbering counts down from the current arena
    const byStart = [...arenas].sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""));
    render(body, html`<div class="v-archive__list">${byStart.map((a, i) => arenaRow(a, byStart.length - i))}</div>`);

    const last = byStart[0];
    if (fresh) fresh.textContent = `updated ${relativeTime(last.last_progress_at ?? last.created_at)} · ${byStart.length} arenas`;
  }

  await load();
  timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);

  return () => { disposed = true; clearInterval(timer); };
}