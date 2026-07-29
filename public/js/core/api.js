/**
 * API client: one cache, in-flight de-duplication, per-request TTL.
 *
 * Why this exists: previously every page hardcoded the API origin and fetched
 * independently, so a single page load could issue `/events` several times
 * and every view refetched `/agents` from scratch. With one shell and several
 * components mounting at once that would get worse, not better — so requests
 * are de-duplicated by URL while in flight, and cached afterwards.
 *
 * In-memory only, deliberately: a stale hackathon score surviving a browser
 * restart is worse than paying for one fetch.
 */

export const API_ORIGIN = "https://arena-api.sadi21863.workers.dev";

/** Entries: url -> { at, value, promise } */
const cache = new Map();

export const FOREVER = Infinity;
const DEFAULT_TTL = 30_000;

function url(path) {
  return path.startsWith("http") ? path : API_ORIGIN + path;
}

/**
 * @param {string} path      "/events" or an absolute URL
 * @param {object} [opts]
 * @param {number} [opts.ttl]       ms to consider a cached value fresh
 * @param {boolean} [opts.optional] resolve to null on a non-2xx instead of throwing
 * @param {object} [opts.headers]
 * @param {string} [opts.method]
 * @param {any}    [opts.body]      JSON-encoded automatically
 */
export function fetchJson(path, opts = {}) {
  const { ttl = DEFAULT_TTL, optional = false, headers, method = "GET", body } = opts;
  const full = url(path);

  // Only GETs are cacheable; a POST (e.g. /archive/query) always goes out.
  const cacheable = method === "GET";
  const key = full;

  if (cacheable) {
    const hit = cache.get(key);
    if (hit) {
      if (hit.promise) return hit.promise;               // in flight — share it
      if (Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    }
  }

  const promise = fetch(full, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
    .then((res) => {
      if (!res.ok) {
        if (optional) return null;
        throw new Error(`${method} ${path} → ${res.status}`);
      }
      return res.json();
    })
    .then((value) => {
      if (cacheable) cache.set(key, { at: Date.now(), value, promise: null });
      return value;
    })
    .catch((err) => {
      if (cacheable) cache.delete(key);
      if (optional) return null;
      throw err;
    });

  if (cacheable) cache.set(key, { at: 0, value: undefined, promise });
  return promise;
}

/** Drop cached entries whose URL contains `substr` (omit to clear all). */
export function invalidate(substr) {
  if (!substr) return cache.clear();
  for (const key of [...cache.keys()]) if (key.includes(substr)) cache.delete(key);
}

/** Test/diagnostic hook — how many entries are held. */
export function cacheSize() { return cache.size; }
