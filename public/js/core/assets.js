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

export function loadScript(src, integrity) {
  if (scripts.has(src)) return scripts.get(src);
  const p = inject(src, integrity).catch((err) => {
    // A rejection must not poison the map: the same page can lose one network
    // request without losing all later mounts. Retry once with a cache-busting
    // query — measured behaviour: the first fetch of a large vendored file
    // fires 'error' early in the page lifetime even though the response is a
    // healthy 200 and the identical re-fetch loads 10/10. The query side-steps
    // whatever cached entry the first attempt left behind. SRI still applies
    // to the first attempt; the retry is the fallback, not the norm.
    scripts.delete(src);
    const bust = src + (src.includes("?") ? "&" : "?") + "r=" + Date.now();
    return inject(bust, integrity);
  });
  scripts.set(src, p);
  return p;
}
