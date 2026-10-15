// Pushes the arena's HARNESS_FILES from this repo into a team repo.
//
// Why this is needed for verification: production syncs the harness inside
// dispatchTurnIfNeeded -> syncTeamHarness, which only runs as part of the event
// engine's build phase. There is no /admin route to trigger a turn (the spec
// lists /admin/trigger-build but src/index.ts never implemented it), so a
// manually dispatched verification turn would otherwise run whatever harness
// the team repo already had -- which is exactly what happened on the first
// attempt: it ran the pre-switch Groq config for 120 minutes and proved nothing
// about OpenRouter.
//
// The file list is read from src/github/repos.ts rather than copied here, so it
// cannot silently drift from what the Worker actually syncs.
//
// Usage: node scripts/sync_team_harness.mjs <owner/repo>

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

const token = dotenv.GITHUB_TOKEN;
const [owner, repo] = (process.argv[2] || "").split("/");
if (!owner || !repo) {
  console.error("usage: node scripts/sync_team_harness.mjs <owner/repo>");
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

// Parse HARNESS_FILES + SKILL_PATHS out of repos.ts so the list is the real one.
const reposSrc = fs.readFileSync("src/github/repos.ts", "utf8");
const skillBlock = reposSrc.match(/const SKILL_PATHS = \[([\s\S]*?)\] as const;/)[1];
const skillPaths = [...skillBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const harnessBlock = reposSrc.match(/const HARNESS_FILES = \[([\s\S]*?)\] as const;/)[1];
const harnessFiles = [
  ...[...harnessBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  ...skillPaths,
];

console.log(`  syncing ${harnessFiles.length} harness files to ${owner}/${repo}`);

let changed = 0;
let unchanged = 0;

for (const path of harnessFiles) {
  // Normalise CRLF -> LF before pushing. On Windows the working copy is CRLF
  // (core.autocrlf) while git stores LF, and the Worker's own syncTeamHarness
  // fetches the LF blob from raw.githubusercontent. Pushing the CRLF working
  // copy made the team repo byte-different from main, which the harness-drift
  // probe (blob-SHA comparison) reads as permanent drift. Found live
  // 2026-10-15: 1065 CRLF lines, identical after normalisation.
  const local = Buffer.from(fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n"), "utf8");
  const content = local.toString("base64");

  // Need the current blob sha to update an existing file.
  let sha;
  const cur = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers });
  if (cur.ok) {
    const j = await cur.json();
    sha = j.sha;
    // Skip if identical, so the sync is a no-op when nothing changed.
    const remote = Buffer.from(j.content, "base64");
    if (remote.equals(local)) {
      unchanged++;
      continue;
    }
  } else if (cur.status !== 404) {
    throw new Error(`GET ${path}: ${cur.status} ${await cur.text()}`);
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `Sync harness: ${path}`,
      content,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    console.log(`    FAIL ${path}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  changed++;
  console.log(`    updated ${path}`);
}

console.log(`  ${changed} updated, ${unchanged} already current`);