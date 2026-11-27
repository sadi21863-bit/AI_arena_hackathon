#!/usr/bin/env node
/**
 * Completion tiers for the last N completed hackathons (A5, read-only).
 *
 * Uses the artifact audit's own D1/GitHub queries so the tier cannot drift
 * from the audit's numbers. Does not emit "substantial" and never writes D1.
 *
 * Usage: node scripts/completion_tiers.mjs [--last=6]
 */
import { d1, auditBuild } from "./artifact_audit.mjs";

const hit = process.argv.find((a) => a.startsWith("--last="));
const last = Math.max(1, Number(hit ? hit.slice(7) : "6") || 6);

const hackathons = await d1(
  `SELECT e.id, e.start_date, e.parent_event_id
   FROM archive_events e
   WHERE e.type = 'hackathon' AND e.status = 'complete'
     AND EXISTS (SELECT 1 FROM hackathon_teams t WHERE t.event_id = e.id AND t.repo_url IS NOT NULL)
   ORDER BY e.start_date DESC LIMIT ?`,
  [last],
);

const rows = [];
for (const h of hackathons) {
  const teams = await d1(
    `SELECT t.id, t.team_name, t.repo_url, t.status,
       COUNT(b.turn_id) AS turns,
       SUM(CASE WHEN b.run_id IS NOT NULL THEN 1 ELSE 0 END) AS with_run,
       SUM(CASE WHEN b.head_sha IS NOT NULL THEN 1 ELSE 0 END) AS with_sha,
       SUM(CASE WHEN b.conclusion = 'success' THEN 1 ELSE 0 END) AS successful_turns,
       SUM(CASE WHEN b.conclusion = 'failure' THEN 1 ELSE 0 END) AS failed_turns,
       EXISTS (SELECT 1 FROM ops_alerts a
               WHERE a.kind = 'quota_hold' AND a.event_id = t.event_id
                 AND a.task_type = t.team_name) AS quota_hold
     FROM hackathon_teams t LEFT JOIN build_turns b ON b.team_id = t.id
     WHERE t.event_id = ? GROUP BY t.id ORDER BY t.team_name`,
    [h.id],
  );
  const builds = await Promise.all(teams.map(auditBuild));
  for (const b of builds) {
    const team = teams.find((t) => t.team_name === b.team);
    rows.push({
      event: h.id,
      start: h.start_date,
      team: b.team,
      repo: b.repo,
      tier: b.tier,
      lines: b.code?.nonblank_lines ?? 0,
      tests: b.test_files.length,
      assertions: b.code?.assertion_hits ?? 0,
      verdict: b.verdict ?? "(none)",
      successful_turns: Number(team?.successful_turns) || 0,
      failed_turns: Number(team?.failed_turns) || 0,
    });
  }
}

console.log(`Completion tiers — last ${hackathons.length} complete hackathon(s), read-only`);
console.log("event\tstart\tteam\ttier\tlines\ttests\tassertions\tverdict\tsuccess\tfailed\trepo");
for (const r of rows) {
  console.log(
    [r.event, r.start, r.team, r.tier, r.lines, r.tests, r.assertions, r.verdict, r.successful_turns, r.failed_turns, r.repo].join("\t"),
  );
}
const counts = {};
for (const r of rows) counts[r.tier] = (counts[r.tier] ?? 0) + 1;
console.log(`\nCounts: ${JSON.stringify(counts)}`);
console.log('"substantial" is never emitted here: it requires the independent A5b rubric in addition to "complete".');
