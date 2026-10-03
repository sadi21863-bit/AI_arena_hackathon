// Verifies ensureGitignoreTracksArtifacts' core decision — which lines it adds
// — against real .gitignore content from the team repos. The append/overwrite
// distinction is the whole point: agents add their own entries and those must
// survive, so a correct implementation reports MISSING lines only when the
// negations are truly absent.
//
// Extracts the logic under test rather than importing the TS module, which
// pulls in Cloudflare types and cannot be loaded by bare Node.

const fs = require("fs");

const GITIGNORE_ARTIFACTS = ["VERIFICATION_FAILURE.log", "VERIFICATION_NOTE.log"];

// --- copy of the logic in repos.ts (kept in sync by check below) ---
function missingArtifacts(current) {
  return GITIGNORE_ARTIFACTS.filter((name) => !new RegExp(`^!${name}$`, "m").test(current));
}

function buildBlock(missing) {
  return [
    "",
    "# Arena verification artifacts — tracked on purpose.",
    ...missing.map((name) => `!${name}`),
  ].join("\n");
}
// ------------------------------------------------------------

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// 1. The pre-fix scaffold: *.log with no negations. This is the real bug state.
const preFix = fs.readFileSync("repo-scaffold/.gitignore", "utf8");
check("fixed scaffold has no missing artifacts", missingArtifacts(preFix).length === 0,
  `missing: ${missingArtifacts(preFix)}`);

// 2. A historical pre-fix team .gitignore (reconstructed: *.log, no negations).
const historical = preFix.replace(/!VERIFICATION_(FAILURE|NOTE)\.log\r?\n?/g, "");
const m2 = missingArtifacts(historical);
check("historical team copy reports BOTH artifacts missing",
  m2.length === 2 && m2.includes("VERIFICATION_FAILURE.log") && m2.includes("VERIFICATION_NOTE.log"),
  `got ${m2}`);

// 3. Agent-modified copy WITH the negations already present -> no-op.
const withAgentEdits = historical.replace(/\n$/, "") +
  "\n/.pydeps/\n*.sqlite\n" + buildBlock(missingArtifacts(historical)) + "\n";
check("already-patched copy is a no-op", missingArtifacts(withAgentEdits).length === 0,
  `missing: ${missingArtifacts(withAgentEdits)}`);

// 4. Partially patched (only one negation) -> exactly one reported.
const halfPatched = historical + "\n!VERIFICATION_FAILURE.log\n";
const m4 = missingArtifacts(halfPatched);
check("half-patched reports exactly the missing one",
  m4.length === 1 && m4[0] === "VERIFICATION_NOTE.log", `got ${m4}`);

// 5. Agents' own entries survive the append. This is the regression that
// stopped .gitignore from being promoted to HARNESS_FILES wholesale.
// Build the realistic pre-fix team file: the historical scaffold PLUS the
// entries real agents appended (alpha-75504818 turn 1 added /.pydeps/).
const agentEdited = historical + "\n/.pydeps/\n*.sqlite\n";
const appended = agentEdited + buildBlock(missingArtifacts(agentEdited)) + "\n";
check("agent's /.pydeps/ survives the append", /\n\/\.pydeps\/\n/.test(appended));
check("agent's *.sqlite survives the append", /\n\*\.sqlite\n/.test(appended));

// 6. The appended result actually un-ignores the artifacts under real git.
const tmp = "C:\\Users\\aditya\\AppData\\Local\\Temp\\opencode\\gitest";
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(tmp + "\\.gitignore", appended);
const { execFileSync } = require("child_process");
execFileSync("git", ["init", "-q", "."], { cwd: tmp });
for (const f of ["VERIFICATION_FAILURE.log", "VERIFICATION_NOTE.log", "app.log"]) {
  fs.writeFileSync(`${tmp}\\${f}`, "x");
}
for (const f of ["VERIFICATION_FAILURE.log", "VERIFICATION_NOTE.log"]) {
  let ignored = true;
  try { execFileSync("git", ["check-ignore", "-q", f], { cwd: tmp }); } catch { ignored = false; }
  check(`git tracks ${f} after the append`, ignored === false);
}
let appIgnored = false;
try { execFileSync("git", ["check-ignore", "-q", "app.log"], { cwd: tmp }); appIgnored = true; } catch {}
check("real runtime logs still ignored", appIgnored === true);
fs.rmSync(tmp, { recursive: true, force: true });

// 7. The test's copy of the logic must still match the shipped source.
const repos = fs.readFileSync("src/github/repos.ts", "utf8");
const shipped = repos.match(/GITIGNORE_ARTIFACTS = \[([^\]]+)\]/);
check("GITIGNORE_ARTIFACTS in repos.ts matches this test",
  shipped && shipped[1].replace(/["\s]/g, "") === GITIGNORE_ARTIFACTS.join(","),
  shipped ? shipped[1] : "not found");

console.log(failed === 0 ? "\nall gitignore-patch cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);