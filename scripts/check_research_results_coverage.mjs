#!/usr/bin/env node
/**
 * Read-only coverage check for the A3 research_results write path.
 *
 * research_results failures are swallowed warnings, so logs are not enough.
 * Compare actual research_calls (excluding Tavily extract calls, which do not
 * write source rows) with distinct call ids present in research_results.
 *
 * A gap means either writes are failing OR the Tavily call returned zero
 * results. The latter cannot be distinguished with today's schema, so this
 * script reports a number, never a hard failure.
 *
 * Usage: node scripts/check_research_results_coverage.mjs [--event=event_...]
 */
import { d1 } from "./lib/d1_read.mjs";

const arg = process.argv.find((a) => a.startsWith("--event="));
const eventArg = arg ? arg.slice(8) : null;

const calls = await d1(
  `SELECT event_id, COUNT(*) AS calls
   FROM research_calls
   WHERE query NOT LIKE '%[extract:%'
     ${eventArg ? "AND event_id = ?" : ""}
   GROUP BY event_id ORDER BY event_id DESC`,
  eventArg ? [eventArg] : [],
);
const written = await d1(
  `SELECT event_id, COUNT(DISTINCT call_id) AS written
   FROM research_results
   ${eventArg ? "WHERE event_id = ?" : ""}
   GROUP BY event_id`,
  eventArg ? [eventArg] : [],
);
const byEvent = new Map(written.map((r) => [r.event_id, Number(r.written) || 0]));

console.log("event\tcalls\twritten\tgap");
for (const row of calls) {
  const n = Number(row.calls) || 0;
  const w = byEvent.get(row.event_id) ?? 0;
  console.log(`${row.event_id}\t${n}\t${w}\t${n - w}`);
}
console.log("A gap can include calls with zero Tavily results; investigate a large or growing gap.");
