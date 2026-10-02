// Push main's corrected repo-scaffold/.gitignore into a live team repo,
// byte-exact, WITHOUT shell redirection.
//
// The 2026-09-28 CRLF incident came from pushing the Windows working copy
// instead of git's committed blob. PowerShell's `>` writes CRLF, so this
// fetches the blob through git itself: `git checkout FETCH_HEAD -- <path>`
// copies index content, never a shell-transcoded stream.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAIN = process.cwd();
const TMP = "C:\\Users\\aditya\\AppData\\Local\\Temp\\opencode";
const repos = process.argv.slice(2);
if (!repos.length) {
  console.error("usage: node sync_gitignore.cjs <repo> [repo...]");
  process.exit(2);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

const mainBlob = git(MAIN, ["rev-parse", "HEAD:repo-scaffold/.gitignore"]).trim();
console.log(`main blob: ${mainBlob}`);

for (const repo of repos) {
  const dir = path.join(TMP, `gi-${repo}`);
  fs.rmSync(dir, { recursive: true, force: true });
  git(TMP, ["clone", "--quiet", "--depth", "1", `https://github.com/AI-arena-hackathon/${repo}.git`, dir]);
  git(dir, ["remote", "add", "main", MAIN]);
  git(dir, ["fetch", "--quiet", "main", "master"]);
  git(dir, ["checkout", "FETCH_HEAD", "--", ".gitignore"]);

  // Set the index entry DIRECTLY to main's blob, bypassing the working tree.
  // `git add` stores whatever bytes are on disk, and the team repo's
  // .gitattributes may normalize LF→CRLF on checkout — so the index hash
  // diverges from main's. `update-index --cacheinfo` writes the exact blob
  // hash into the index, guaranteeing byte-exact parity with main.
  git(dir, ["update-index", "--cacheinfo", `100644,${mainBlob},.gitignore`]);

  // Verify the index blob matches main BEFORE pushing.
  const staged = git(dir, ["ls-files", "-s", ".gitignore"]).trim().split(/\s+/)[1];
  if (staged !== mainBlob) {
    console.error(`  ABORT ${repo}: index blob ${staged} != main ${mainBlob}`);
    process.exitCode = 1;
    continue;
  }
  git(dir, ["config", "user.name", "arena-bot"]);
  git(dir, ["config", "user.email", "arena-bot@users.noreply.github.com"]);
  git(dir, ["commit", "--quiet", "-m",
    "Track VERIFICATION_FAILURE.log / VERIFICATION_NOTE.log\n\n" +
    "The scaffold's '# Logs' rule (\\*.log) silently ignored both files, so the\n" +
    "verify step's report was written to the runner workspace and then skipped by\n" +
    "'git add -A' — it has never reached this repo, in any turn, despite AGENTS.md\n" +
    "rule 3 telling every agent to read it next turn. Negate both after the *.log\n" +
    "rule; real runtime logs stay ignored."]);
  git(dir, ["push", "--quiet", "origin", "HEAD:main"]);
  console.log(`  pushed ${repo} (blob ${staged.slice(0, 7)})`);
}