/**
 * Observatory entry point.
 *
 * Everything shared is started once here: the poller, the agent roster, and
 * the router. Views are lazily imported by the router, so a visit only pays
 * for the code and CSS of the view actually being looked at.
 */

import { startRouter, activeView } from "./core/router.js";
import * as store from "./core/store.js";

const outlet = document.getElementById("view");

/** Keep the top-bar active state in sync with whatever view is mounted. */
function syncNav() {
  const view = activeView();
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active = a.getAttribute("data-nav") === view ||
      (a.getAttribute("data-nav") === "live" && (view === "live" || view === "cycle"));
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

store.loadAgents();
store.start();
startRouter(outlet);

// The router has no event of its own; navigation is always a click or a
// popstate, both of which bubble to the document.
document.addEventListener("click", () => setTimeout(syncNav, 0));
window.addEventListener("popstate", () => setTimeout(syncNav, 0));
setTimeout(syncNav, 0);

// Exposed for debugging in the console — not used by application code.
window.__arena = { store };
