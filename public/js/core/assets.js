/**
 * Lazy, memoized loading of per-view CSS and third-party scripts.
 *
 * Stylesheets are awaited before a view paints, so navigating never shows a
 * frame of unstyled content. Once loaded a sheet stays — view CSS is small
 * and scoped by a .v-<view>__ prefix, so leaving it in place is cheaper than
 * churning <link> elements.
 *
 * Scripts are injected as classic <script> tags rather than dynamic import()
 * specifically so `integrity` still applies: SRI cannot be attached to a
 * dynamic import, so moving the vendored libraries into module imports would
 * have silently dropped that guarantee.
 */

const css = new Map();
const scripts = new Map();

export function loadCss(href) {
  if (css.has(href)) return css.get(href);
  const p = new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    // Resolve on error too: a missing view stylesheet should degrade to
    // unstyled, never block the view from rendering at all.
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
  css.set(href, p);
  return p;
}

function inject(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * Fallback that reloads a script's bytes through fetch() and executes them
 * from a Blob URL. Measured on the deployed site the classic <script> path
 * can fire 'error' (and reject) even when the very same URL served a healthy
 * 200 and the identical re-fetch executes fine — an engine/cache quirk this
 * path sidesteps entirely: the bytes that fetch() returns are the bytes that
 * run, no HTTP cache entry or transform in between. Same-origin file, so the
 * integrity guarantee is inherited from the fetch; a Blob URL cannot carry
 * an SRI attribute, which is why this is the fallback, not the primary path.
 */
async function injectViaFetch(url, integrity) {
  if (integrity) throw new Error(`cannot apply SRI to a Blob URL: ${url}`);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`failed to fetch ${url} → ${res.status}`);
  const text = await res.text();
  const blobUrl = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  try {
    await inject(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function loadScript(src, integrity) {
  if (!scripts.has(src)) {
    const p = inject(src, integrity).catch((err) => {
      // A rejection must not poison the map: the same page can lose one network
      // request without losing all later mounts, so drop the entry and reload
      // the script through fetch()+Blob URL — the deterministic path.
      scripts.delete(src);
      return injectViaFetch(src, integrity);
    });
    scripts.set(src, p);
  }
  return scripts.get(src).then(() => {
    // Classic script tags can't `export` — the library lands on `window` with
    // whatever name its IIFE chose. Views destructure the promise's value
    // straight from Promise.all, so the loaded object must be THAT value, not
    // undefined: inject() resolves on 'load', and by then the script body has
    // run synchronously, so the global is guaranteed present.
    const g = GLOBAL_BY_SRC[src];
    return g ? globalThis[g] : undefined;
  });
}

const GLOBAL_BY_SRC = {
  "/vendor/d3-7.9.0.min.js": "d3",
  "/vendor/diff2html-3.4.51.min.js": "Diff2Html",
};
