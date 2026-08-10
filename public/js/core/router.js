/**
 * Client-side router with an explicit mount/unmount lifecycle.
 *
 * The teardown contract is the important part. Every view's `mount()` returns
 * a cleanup function, and the router calls it before mounting the next view.
 * On the old page-per-view site the browser tore everything down on
 * navigation for free; in one shell, a d3 force simulation, a replay playback
 * timer, or the office's two-dozen sprite timers would otherwise keep running
 * forever behind whatever you navigated to.
 *
 * MODE is hash, and that is a deliberate, measured choice rather than a
 * default. History mode needs a `_redirects` splat rewriting unknown
 * /observatory/* paths to the shell, and Cloudflare Pages defeats that twice
 * over: it 308-canonicalizes /observatory/index.html to /observatory/, and it
 * strips .html from any other filename (/observatory/app.html ->
 * /observatory/app). So every candidate rewrite DESTINATION is itself
 * redirected, which turned the 200 rewrite into a 308 that also swallowed
 * real asset requests under /observatory. Both were reproduced locally.
 *
 * Hash routing needs no server config at all, behaves identically in dev and
 * production, and still gives real deep links — which was the actual goal,
 * since nothing in the old site was linkable below page level. Flipping back
 * to "history" is a one-line change if Pages' behaviour ever changes; every
 * link in the app is produced by href() below.
 */

import { loadCss } from "./assets.js";
import { esc } from "./html.js";

export const MODE = "hash";
const BASE = "/observatory";

/** route: [pattern, view module path, css path] — first match wins. */
const ROUTES = [
  ["/live",                      "live"],
  ["/cycle/:cycleId",            "live"],
  ["/archive",                   "archive"],
  ["/office",                    "office"],
  ["/office/:eventId",           "office"],
  ["/graph",                     "graph"],
  ["/graph/:eventId",            "graph"],
  ["/ideas/:eventId",            "ideas"],
  ["/ideas/:eventId/:ideaId",    "ideas"],
  ["/replay/:eventId",           "replay"],
  ["/replay/:eventId/:index",    "replay"],
  ["/diff/:eventId",             "diff"],
  ["/diff/:eventId/:team",       "diff"],
  ["/diff/:eventId/:team/:sha",  "diff"],
  ["/tribunal/:eventId",         "tribunal"],
  ["/headroom",                  "headroom"],
];

/* Old .html paths also get 301s in _redirects, but recognising them here too
   means a stale bookmark resolves even if a redirect rule is ever dropped. */
const LEGACY = {
  "live.html": "/live",
  "office.html": "/office",
  "agents.html": "/graph",
  "headroom.html": "/headroom",
  "ideas.html": "/ideas",
  "replay.html": "/replay",
  "diff.html": "/diff",
  "tribunal.html": "/tribunal",
};

function match(path) {
  for (const [pattern, view] of ROUTES) {
    const pp = pattern.split("/").filter(Boolean);
    const ap = path.split("/").filter(Boolean);
    if (pp.length !== ap.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return { view, params, pattern };
  }
  return null;
}

/** Build an in-app link. The single place that knows about MODE. */
export function href(path) {
  return MODE === "hash" ? `${BASE}/#${path}` : `${BASE}${path}`;
}

function currentPath() {
  if (MODE === "hash") return location.hash.replace(/^#/, "") || "/live";
  let p = location.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length);
  p = p || "/";

  const legacy = LEGACY[p.replace(/^\//, "")];
  if (legacy) {
    const id = new URLSearchParams(location.search).get("event_id");
    return id ? `${legacy}/${encodeURIComponent(id)}` : legacy;
  }
  return p === "/" ? "/live" : p;
}

let teardown = null;
let outlet = null;
let currentKey = "";
let mountToken = 0;

/**
 * `replace: true` means "rewrite the URL to describe what is already on
 * screen" — a view syncing its own state (the replay scrubber's index, say).
 * It deliberately does NOT re-resolve: doing so remounts the very view that
 * asked for it, and since that view sets its state during mount, the result
 * was an infinite mount -> navigate -> mount loop that hung the page.
 */
export function navigate(path, { replace = false } = {}) {
  const url = href(path);
  if (replace) { history.replaceState({}, "", url); return; }
  if (MODE === "hash") { location.hash = path; return; }  // fires hashchange
  history.pushState({}, "", url);
  resolve();
}

async function resolve() {
  // Claimed here, BEFORE any await, so tokens follow navigation order. If it
  // were claimed after the dynamic import, a slower earlier view could take a
  // higher token than a later one and tear the current view down.
  const token = ++mountToken;
  const path = currentPath();
  const hit = match(path);

  // Re-mounting the same view for a param-only change is the view's job to
  // handle via its own state; remounting would drop scroll and focus.
  const key = hit ? hit.pattern.split("/")[1] : "404";

  if (teardown) {
    try { teardown(); } catch (err) { console.error("teardown failed", err); }
    teardown = null;
  }

  if (!hit) {
    outlet.innerHTML =
      '<div class="arena-state arena-state--error">No such view.' +
      `<div class="arena-state__action"><a class="arena-btn arena-btn--sm arena-btn--ghost" href="${href("/live")}">Go to Live</a></div></div>`;
    return;
  }

  const viewChanged = key !== currentKey;
  outlet.setAttribute("data-view", hit.view);
  currentKey = key;

  // Scroll to the top when the VIEW changes — not on a param-only change,
  // which is the replay scrubber stepping through its own timeline and must
  // keep its position (the comment above says as much).
  //
  // Two separate problems this fixes, both of which look like "the scroll is
  // buggy":
  //  - Nothing reset scroll, so leaving a long page scrolled down and opening
  //    a short one dropped you into the middle of it, sometimes past all its
  //    content.
  //  - `html { scroll-behavior: smooth }` (arena.css) means the browser
  //    ANIMATES the correction when a shorter view shrinks the page and the
  //    scroll offset gets clamped — so the page visibly slides on every
  //    navigation. "instant" opts this one scroll out of that, without
  //    removing smooth scrolling for in-page anchors that genuinely want it.
  if (viewChanged) {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    } catch {
      window.scrollTo(0, 0); // older browsers reject the options form
    }
  }

  try {
    // CSS first and awaited, so the view never paints unstyled for a frame.
    await loadCss(`/css/views/${hit.view}.css`);
    const mod = await import(`/js/views/${hit.view}.js`);

    // A view that awaits during mount can outlive its own mount: navigate
    // away before mount() returns and there is no teardown to call yet, so
    // it keeps going and writes into an outlet the router has already
    // replaced. If this mount is no longer the current one by the time it
    // resolves, tear it down immediately rather than leave it running
    // against detached DOM.
    if (token !== mountToken) return;
    const cleanup = (await mod.mount(outlet, hit.params)) || null;
    if (token !== mountToken) { try { cleanup && cleanup(); } catch { /* already gone */ } return; }
    teardown = cleanup;
  } catch (err) {
    console.error(err);
    // One bad view must not wedge the shell.
    // esc(): an error message can carry server-controlled text.
    outlet.innerHTML =
      `<div class="arena-state arena-state--error">This view failed to load.<br><small>${esc(err && err.message ? err.message : err)}</small>` +
      `<div class="arena-state__action"><button class="arena-btn arena-btn--sm arena-btn--ghost" data-reload>Reload</button></div></div>`;
    const reload = outlet.querySelector("[data-reload]");
    if (reload) reload.addEventListener("click", () => location.reload());
  }
}

/** Intercept same-origin in-app links so they don't full-page navigate. */
function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;

  e.preventDefault();
  if (MODE === "hash") { location.hash = url.hash.replace(/^#/, "") || "/live"; return; }
  if (url.pathname + url.search === location.pathname + location.search) return;
  history.pushState({}, "", url.pathname + url.search + url.hash);
  resolve();
}

export function startRouter(outletEl) {
  outlet = outletEl;
  document.addEventListener("click", onClick);
  window.addEventListener(MODE === "hash" ? "hashchange" : "popstate", resolve);
  resolve();
}

export function activeView() { return currentKey; }
