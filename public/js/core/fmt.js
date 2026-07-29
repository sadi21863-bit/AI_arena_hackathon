/** Small formatting helpers shared across views. */

/** D1 stores "YYYY-MM-DD HH:MM:SS" in UTC, without a zone marker. */
export function parseUtc(value) {
  if (!value) return null;
  const iso = String(value).includes("T") ? String(value) : String(value).replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function utcDate(value, { withTime = false } = {}) {
  const d = parseUtc(value);
  if (!d) return "—";
  const date = d.toISOString().slice(0, 10);
  return withTime ? `${date} ${d.toISOString().slice(11, 16)} UTC` : date;
}

export function dateRange(from, to) {
  const a = parseUtc(from), b = parseUtc(to);
  if (!a) return "—";
  const fmt = (d) => d.toISOString().slice(0, 10);
  return b ? `${fmt(a)} → ${fmt(b)}` : `${fmt(a)} → now`;
}

export function relativeTime(value) {
  const d = parseUtc(value);
  if (!d) return "—";
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function shortId(id, len = 14) {
  if (!id) return "—";
  return id.length > len ? id.slice(0, len) + "…" : id;
}

export function score(n, digits = 2) {
  return typeof n === "number" && !isNaN(n) ? n.toFixed(digits) : "—";
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}
