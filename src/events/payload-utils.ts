/**
 * Shared JSON-payload helpers for event_queue idempotency/counting checks.
 * Deliberately NOT `payload LIKE '%"field":"val"%'` — found live
 * (2026-07-22): D1 throws "LIKE or GLOB pattern too complex" whenever the
 * pattern contains a literal `"` character, which every JSON-substring LIKE
 * pattern here necessarily does. Fetching the (small, per-event) row set
 * and filtering in JS sidesteps it entirely, and is arguably more correct
 * anyway — exact field match instead of substring matching that could
 * false-positive across similarly-prefixed IDs.
 *
 * Extracted as its own module (2026-07-23 code-quality pass) so
 * executor.ts's dispatch-turn-count logic can share the same parsing
 * primitive instead of hand-rolling a near-identical duplicate.
 */

function parsePayloadField(payload: string | null, field: string): string | undefined {
  if (!payload) return undefined;
  try {
    const value = JSON.parse(payload)?.[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined; // malformed payload — treat as no match, not a crash
  }
}

/** One field from a set of queue rows' payloads, as a Set for cheap membership checks. */
export function queuedPayloadValues(rows: Array<{ payload: string | null }>, field: string): Set<string> {
  const values = new Set<string>();
  for (const row of rows) {
    const value = parsePayloadField(row.payload, field);
    if (value !== undefined) values.add(value);
  }
  return values;
}

/** How many rows have `field` equal to `targetValue` — a Set would collapse repeats, losing the count. */
export function countPayloadFieldMatches(rows: Array<{ payload: string | null }>, field: string, targetValue: string): number {
  return rows.filter((row) => parsePayloadField(row.payload, field) === targetValue).length;
}

/**
 * Extracts a required string field from a queue item's payload, throwing a
 * consistent "<taskType> task missing payload.<field>" error if it's
 * absent — replaces 6 near-identical parse+check preambles across
 * executor.ts's task handlers (2026-07-23 code-quality pass).
 */
export function requirePayloadField(payload: string | null, field: string, taskType: string): string {
  const value = parsePayloadField(payload, field);
  if (!value) throw new Error(`${taskType} task missing payload.${field}`);
  return value;
}
