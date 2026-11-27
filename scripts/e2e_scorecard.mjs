#!/usr/bin/env node
/**
 * End-to-end product scorecard (A8, read-only).
 *
 * Emits the eight-row table from the strategy. A row is `pass`/`fail` only
 * when the check is actually measured; otherwise it is `not measured` with a
 * link to the instrument that would measure it. No check is weakened to make
 * a cycle pass.
 *
 * Usage: node scripts/e2e_scorecard.mjs
 */
import { d1 } from "./lib/d1_read.mjs";

const cycle = (
  await d1(
    `SELECT e.id, e.start_date, e.parent_event_id
     FROM archive_events e
     WHERE e.type='hackathon' AND e.status='complete'
       AND EXISTS (SELECT 1 FROM hackathon_teams t WHERE t.event_id=e.id AND t.repo_url IS NOT NULL)
     ORDER BY e.start_date DESC LIMIT 1`,
  )
)[0];
if (!cycle) throw new Error("No completed cycle with repos");

const parent = (
  await d1(`SELECT id, start_date, status FROM archive_events WHERE id=?`, [cycle.parent_event_id])
)[0];

const ideas = await d1(
  `SELECT id, status, title, one_liner FROM archive_ideas WHERE event_id=?`,
  [parent?.id ?? cycle.parent_event_id],
);
const blocked = ideas.filter((i) => i.status === "blocked").length;
const blockedShare = ideas.length ? ((100 * blocked) / ideas.length).toFixed(0) : "0";

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "about",
  "your", "their", "they", "them", "will", "can", "could", "should", "would", "have",
  "has", "are", "was", "were", "its", "it's", "our", "you", "not", "but", "all", "any",
  "new", "using", "use", "via", "per", "one", "two", "more", "most", "less", "than",
  "then", "when", "where", "which", "who", "what", "how", "why", "while", "also",
]);
const tokens = (v) =>
  new Set(
    String(v ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n / (a.size + b.size - n);
};
const keyed = ideas.map((i) => ({ id: i.id, t: tokens(`${i.title} ${i.one_liner}`) }));
let nearDuplicates = 0;
for (let a = 0; a < keyed.length; a += 1) {
  for (let b = a + 1; b < keyed.length; b += 1) {
    if (jaccard(keyed[a].t, keyed[b].t) >= 0.82) nearDuplicates += 1;
  }
}

const teams = await d1(
  `SELECT t.team_name,
     SUM(CASE WHEN b.conclusion='success' THEN 1 ELSE 0 END) AS successes,
     COUNT(b.turn_id) AS turns
   FROM hackathon_teams t LEFT JOIN build_turns b ON b.team_id=t.id
   WHERE t.event_id=? GROUP BY t.id ORDER BY t.team_name`,
  [cycle.id],
);
const buildStatus =
  teams.length > 0 && teams.every((t) => Number(t.successes) > 0) ? "pass" : "fail";
const buildEvidence = teams
  .map((t) => `${t.team_name}=${t.successes}/${t.turns} successes`)
  .join(", ");

const rows = [
  [1, "Research produces traceable problem evidence", "not measured", "scripts/anchor_verifiability.mjs — traceable needs a human/second-model sample"],
  [2, "Ideas distinct and meaningful", "not measured", `near-duplicate pairs=${nearDuplicates}, blocked=${blocked}/${ideas.length} (${blockedShare}%); human 'meaningful' sample not scored`],
  [3, "Critique leads to measurable improvement", "not measured", "no pre/post revision measurement is stored (C2)"],
  [4, "Seven judges produce defensible evaluations", "not measured", "six-axis probe + human alignment not run (A2)"],
  [5, "Teams build actual working software", buildStatus, `${cycle.id}: ${buildEvidence || "no teams"}; scripts/completion_tiers.mjs`],
  [6, "Builds and tests independently verified", "not measured", "A5b clean-container runner not built"],
  [7, "Observatory displays real system activity", "not measured", "A7a screenshot audit not signed off"],
  [8, "Final artifacts inspectable and reproducible", "not measured", "frozen export bundle / fresh-clone check not run for this cycle"],
];

console.log(`E2E scorecard — cycle ${cycle.id} (parent ${parent?.id ?? cycle.parent_event_id}, ${parent?.start_date ?? "-"})`);
console.log("#\tcheck\tstatus\tevidence");
for (const r of rows) console.log(r.join("\t"));
const passes = rows.filter((r) => r[2] === "pass").length;
const fails = rows.filter((r) => r[2] === "fail").length;
console.log(`\npass=${passes} fail=${fails} not_measured=${rows.length - passes - fails}`);
console.log("Milestone M-E2E requires eight passes; this cycle does not meet it.");
