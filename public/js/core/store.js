/**
 * Shared data store — one poller for the entire application.
 *
 * Replaces: two visibility-gated intervals, one ungated interval
 * (headroom.html, the odd one out), and a hand-rolled freshness ticker.
 *
 * The poll is aligned to the Worker's cron boundary rather than free-running.
 * wrangler.toml runs the queue every 5 minutes, so the data genuinely cannot
 * change between ticks. Firing just after each boundary means ~10x fewer requests
 * AND changes surface sooner than a 30s free-running interval would show
 * them — the old behaviour could sit on a stale value for most of a minute
 * right after a tick.
 */

import { fetchJson, invalidate, FOREVER } from "./api.js";

const TICK_MS = 300_000;               // cron period
const JITTER_MS = 6_000;               // spread clients so they don't stampede
const FRESHNESS_MS = 1_000;

function createSignal(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get() { return value; },
    set(next) { value = next; subs.forEach((fn) => fn(value)); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get size() { return subs.size; },
  };
}

export const events = createSignal({ data: null, error: null, loadedAt: null });

let agentsPromise = null;
let agentsById = new Map();

/** 12 rows that never change within a session — fetched once, cached forever. */
export function loadAgents() {
  if (!agentsPromise) {
    agentsPromise = fetchJson("/agents", { ttl: FOREVER, optional: true })
      .then((list) => {
        agentsById = new Map((list || []).map((a) => [a.id, a]));
        return list || [];
      });
  }
  return agentsPromise;
}

export function agentName(id) {
  const a = agentsById.get(id);
  return a ? a.name : id;
}

export async function refreshEvents() {
  try {
    invalidate("/events");
    const data = await fetchJson("/events");
    events.set({ data, error: null, loadedAt: Date.now() });
  } catch (err) {
    // Keep the last good data on screen rather than blanking the app.
    events.set({ ...events.get(), error: err });
  }
  return events.get();
}

/** ms until just after the next cron boundary. */
function msUntilNextTick() {
  return TICK_MS - (Date.now() % TICK_MS) + 1_000 + Math.random() * JITTER_MS;
}

let pollTimer = null;
let started = false;
let freshnessTimer = null;

function schedule() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (document.visibilityState === "visible") await refreshEvents();
    schedule();
  }, msUntilNextTick());
}

function onVisible() {
  // Catch up immediately rather than waiting out the remaining interval.
  if (document.visibilityState === "visible") refreshEvents();
}

/** bfcache restore fires pageshow, not visibilitychange — unhandled before. */
function onPageShow(e) { if (e.persisted) refreshEvents(); }

function tickFreshness() {
  const { loadedAt } = events.get();
  if (!loadedAt) return;
  const secs = Math.round((Date.now() - loadedAt) / 1000);
  const text = secs < 2 ? "Updated just now" : secs < 90 ? `Updated ${secs}s ago` : `Updated ${Math.round(secs / 60)}m ago`;
  document.querySelectorAll("[data-freshness]").forEach((el) => { el.textContent = text; });
}

export function start() {
  if (started) return;
  started = true;
  refreshEvents();
  schedule();
  freshnessTimer = setInterval(tickFreshness, FRESHNESS_MS);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onPageShow);
}

export function stop() {
  started = false;
  clearTimeout(pollTimer);
  clearInterval(freshnessTimer);
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("pageshow", onPageShow);
}

/** Diagnostic: prove no view leaked a subscription after navigating away. */
export function subscriberCount() { return events.size; }
