// Polls one workflow run to completion and prints each status change once.
//
// Prints only on CHANGE: a build turn runs 10-40 min, and re-printing
// "in_progress" every 30s buries the one line that matters (the run name
// confirmed it started; the conclusion tells us whether it worked).
//
// Usage: node scripts/watch_run.mjs <runId> [maxMinutes]

import fs from "node:fs";

const dotenv = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Za-z_][A-Za-z_0-9]*\s*=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const headers = {
  Authorization: `Bearer ${dotenv.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const runId = process.argv[2];
const maxMinutes = Number(process.argv[3] || 45);
const REPO = "AI-arena-hackathon/arena-team-alpha-d28b420c";

let last = null;
let elapsed = 0;
const deadline = Date.now() + maxMinutes * 60_000;

while (Date.now() < deadline) {
  const run = await (
    await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${runId}`, { headers })
  ).json();

  const stamp = `${run.status}/${run.conclusion}`;

  if (stamp !== last) {
    console.log(`  [${(elapsed / 60).toFixed(1)}m] ${stamp}  ${run.html_url}`);
    if (run.status === "completed") {
      const jobs = await (
        await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${runId}/jobs`, { headers })
      ).json();
      for (const j of jobs.jobs || []) {
        console.log(`      job ${j.name}: ${j.conclusion}`);
        for (const s of j.steps || []) {
          if (s.conclusion && s.conclusion !== "success") {
            console.log(`        step ${s.number} ${s.name}: ${s.conclusion}`);
          }
        }
      }
      process.exit(run.conclusion === "success" ? 0 : 1);
    }
    last = stamp;
  }

  await new Promise((s) => setTimeout(s, 30_000));
  elapsed += 30;
}

console.log(`  [timeout] still ${last} after ${maxMinutes}m`);
process.exit(2);