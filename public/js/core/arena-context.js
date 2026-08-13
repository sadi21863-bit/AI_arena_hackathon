/**
 * Arena Context Bar — the one place that answers "which Arena am I in?".
 *
 * Mounted once in the shell, outside the router's outlet, so it survives
 * every navigation. It derives the arena list from store.events via
 * toCycles() — the same model the views read — and finds the current arena
 * by matching the URL hash, so the bar carries no state of its own beyond
 * the last events snapshot.
 *
 * It replaces the per-view ideathon pickers with one app-level selector
 * (each view's picker re-derived the same list), and its instrument row is
 * the cross-navigation between Live / Replay / Ideas / Graph / Diff /
 * Tribunal / Office / Archive / Headroom, each scoped link carrying the
 * current arena along.
 *
 * The bar navigates through the router like any link would. On this router
 * every resolve() tears down and remounts the view, so a scoped view
 * (graph, ideas, replay, …) re-reads its event id from the new URL.
 */

import { html, render } from "./html.js";
import { href, navigate, activeView } from "./router.js";
import * as store from "./store.js";
import { toCycles, phaseLabel, typeLabel } from "./model.js";

/** [id, label, scoped, url-for-cycle] — scoped instruments need an arena id
 *  in the URL; unscoped ones (archive, headroom) don't. */
const INSTRUMENTS = [
  { id: "live",     label: "Live",     scoped: true,  url: (c) => `/cycle/${c.ideathon.id}` },
  { id: "arena",    label: "Arena",    scoped: true,  url: (c) => `/arena/${c.ideathon.id}` },
  { id: "ideas",    label: "Ideas",    scoped: true,  url: (c) => `/ideas/${c.ideathon.id}` },
  { id: "diff",     label: "Diff",     scoped: true,  url: (c) => `/diff/${c.ideathon.id}` },
  { id: "tribunal", label: "Tribunal", scoped: true,  url: (c) => `/tribunal/${c.ideathon.id}` },
  { id: "office",   label: "Office",   scoped: true,  url: (c) => `/office/${(c.activeEvent || c.ideathon).id}` },
  { id: "archive",  label: "Archive",  scoped: false, url: () => `/archive` },
  { id: "headroom", label: "Headroom", scoped: false, url: () => `/headroom` },
];

/** The arena the current URL points at. Ideathon and hackathon ids appear in
 *  the hash of every scoped route, and ids are unique enough that a substring
 *  match is a safe heuristic. Falls back to the newest arena — the same
 *  default the views use when a route carries no id. */
function arenaFromHash(cycles, hash) {
  if (!cycles.length) return null;
  const found = cycles.find((c) =>
    hash.includes(c.ideathon.id) || (c.hackathon && hash.includes(c.hackathon.id)));
  return found || cycles[0];
}

/** "Round 2 · Hackathon · Building" — which half of the arena is working. */
function roundLabel(cycle) {
  const active = cycle.activeEvent || cycle.ideathon;
  return `${active.type === "hackathon" ? "Round 2" : "Round 1"} · ${typeLabel(active.type)} · ${phaseLabel(active)}`;
}

/**
 * Mount the bar into `host`. Returns a teardown. The bar re-draws on every
 * hashchange (the router resolves the same events) and whenever store.events
 * changes (a fresh poll can add an arena or flip a phase).
 */
export function mountArenaContext(host) {
  let cycles = [];

  function draw() {
    if (!host) return;
    const arena = arenaFromHash(cycles, location.hash);
    // /cycle/:cycleId is the live view — match it to the Live instrument.
    const view = activeView();
    const activeInstrument = view === "cycle" ? "live" : view;

    render(host, html`
      <div class="arena-context__row">
        <div class="arena-context__crumb">
          ${arena
            ? html`
              <span class="arena-context__arena">Arena ${arena.ordinal}</span>
              <span class="arena-context__round">${roundLabel(arena)}</span>
              ${arena.isLive ? html`<span class="arena-pill arena-pill--live">Live</span>` : ""}`
            : html`<span class="arena-context__arena">No arena has run yet</span>`}
        </div>
        ${cycles.length ? html`
          <label class="arena-context__switch" for="arena-context-select">
            <span class="arena-context__switch-label">Switch arena</span>
            <select id="arena-context-select" class="arena-select">
              ${cycles.map((c) => html`
                <option value="${c.ideathon.id}" ${arena && c.id === arena.id ? "selected" : ""}>
                  Arena ${c.ordinal} · ${phaseLabel(c.activeEvent || c.ideathon)}
                </option>`)}
            </select>
          </label>` : ""}
      </div>
      <nav class="arena-context__instruments" aria-label="Observatory instruments">
        ${INSTRUMENTS.filter((i) => arena || !i.scoped).map((i) => html`
          <a href="${href(i.url(arena))}"
             ${i.id === "live" ? html`data-nav="live"` : ""}
             ${activeInstrument === i.id ? html`aria-current="page"` : ""}>${i.label}</a>`)}
      </nav>`);

    const sel = host.querySelector("#arena-context-select");
    if (sel) sel.addEventListener("change", () => {
      const next = toCycles(store.events.get().data || []).find((c) => c.id === sel.value);
      if (!next) return;
      // Stay in the current instrument when it is arena-scoped (graph →
      // graph of the new arena); otherwise land on that arena's Live view.
      const current = INSTRUMENTS.find((i) => i.id === (activeView() === "cycle" ? "live" : activeView()));
      navigate(current && current.scoped ? current.url(next) : `/cycle/${next.ideathon.id}`);
    });
  }

  window.addEventListener("hashchange", draw);
  const unsubscribe = store.events.subscribe(draw);

  (async () => {
    try {
      await store.loadAgents();
    } catch { /* the views surface agent failures themselves */ }
    const snap = store.events.get();
    const data = snap.data || (await store.refreshEvents()).data || [];
    cycles = toCycles(data);
    draw();
  })();

  return () => {
    unsubscribe();
    window.removeEventListener("hashchange", draw);
  };
}
