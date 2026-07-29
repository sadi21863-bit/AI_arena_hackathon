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

export function loadScript(src, integrity) {
  if (scripts.has(src)) return scripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; }
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
  scripts.set(src, p);
  return p;
}
