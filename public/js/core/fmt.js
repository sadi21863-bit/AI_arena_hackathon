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

/**
 * Describes a calibration failure with the bound it actually breached.
 *
 * The band is two-sided, and the two sides mean opposite things: too-low means
 * the judges disagree (weak anchors), too-high means they agree so closely that
 * 3 anchors were too easy to separate — an overfit signal about the anchors,
 * not confidence in the ranking. The bounds come from the API payload rather
 * than being restated here, because this function previously hardcoded
 * "below 0.6" for every failure and misreported a 0.959 over-correlation as an
 * under-correlation on 2026-09-29.
 */
export function calibrationVerdict(cal) {
  if (!cal) return "no calibration recorded";
  const band = cal.band || { min: 0.6, max: 0.95 };
  if (cal.passed) {
    return `correlation ${score(cal.correlation)}, inside the ${band.min}–${band.max} band`;
  }
  const side =
    cal.failedSide ||
    (cal.correlation > band.max ? "high" : cal.correlation < band.min ? "low" : null);
  if (side === "high") {
    return `correlation ${score(cal.correlation)}, above the ${band.max} ceiling — over-agreeing judges`;
  }
  if (side === "low") {
    return `correlation ${score(cal.correlation)}, below the ${band.min} floor — judges disagree`;
  }
  return `correlation ${score(cal.correlation)}, outside the ${band.min}–${band.max} band`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}
