#!/usr/bin/env node
/**
 * Anchor verifiability rates (A3, read-only, warning-only).
 *
 * Non-empty coverage was solved in 2026-11-02; this reports the four proposed
 * verifiability rates instead of pretending a non-empty string is evidence.
 * "traceable" is deliberately NOT measured by a script: it needs a human or
 * second-model sample. No hard rejection rule is implied.
 *
 * Usage: node scripts/anchor_verifiability.mjs [--event=event_...]
 */
import { d1 } from "./lib/d1_read.mjs";

const hit = process.argv.find((a) => a.startsWith("--event="));
let event;
if (hit) {
  event = (await d1(`SELECT id, status, start_date FROM archive_events WHERE id = ?`, [hit.slice(8)]))[0];
} else {
  // First chronologically (default); pass --event=... for any other ideathon.
  event = (
    await d1(
      `SELECT e.id, e.status, e.start_date FROM archive_events e
       WHERE e.type='ideathon' AND e.status='judged' AND e.start_date >= '2026-10-31'
         AND EXISTS (SELECT 1 FROM archive_ideas i WHERE i.event_id=e.id
                     AND i.research_anchor IS NOT NULL AND length(trim(i.research_anchor))>0)
       ORDER BY e.start_date ASC LIMIT 1`,
    )
  )[0];
}
if (!event) throw new Error("No suitable ideathon found");

const ideas = await d1(
  `SELECT id, title, research_anchor FROM archive_ideas
   WHERE event_id=? AND status IN ('judged','architecture_complete')`,
  [event.id],
);
const anchors = ideas.map((i) => String(i.research_anchor ?? "").trim()).filter(Boolean);
const identifiableRe = /(https?:\/\/|doi\b|\b(?:report|study|paper|regulation|directive|dataset|survey|standard)\b)/i;
const specificRe = /\d|["“”‘’]/;
const identifiable = anchors.filter((a) => identifiableRe.test(a));
const specific = anchors.filter((a) => specificRe.test(a));

const withUrl = identifiable.filter((a) => /https?:\/\//i.test(a));
let resolves = 0;
for (const a of withUrl) {
  const url = a.match(/https?:\/\/[^\s)>]+/i)[0];
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(12000) });
    await res.text();
    if (res.ok) resolves += 1;
  } catch {
    // Unreachable or blocked; counted as not resolved, never as a hard failure.
  }
}

const rate = (n, d) => (d ? `${n}/${d} (${((100 * n) / d).toFixed(0)}%)` : "0/0 (not measured)");
console.log(`Anchor verifiability — ${event.id} (${event.status}, ${event.start_date})`);
console.log(`finalists=${ideas.length} non_empty=${anchors.length}`);
console.log(`identifiable: ${rate(identifiable.length, anchors.length)}`);
console.log(`specific: ${rate(specific.length, anchors.length)}`);
console.log(`resolves: ${rate(resolves, withUrl.length)} (only anchors containing a URL; ${identifiable.length - withUrl.length} identifiable anchors have no URL)`);
console.log("traceable: not measured — requires a human/second-model sample of 10 anchors per event");
console.log("This is a process metric, not a score or gate.");
