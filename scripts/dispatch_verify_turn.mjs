// Dispatches one build turn to a team repo to verify the OpenRouter switch
// end-to-end.
//
// The prompt is assembled from the REAL builder in src/events/executor.ts
// (dispatchTurnIfNeeded, ~line 725) rather than invented here, and the idea
// fields are lifted verbatim from the target repo's README. An improvised
// prompt would prove less: the arena's prompt shape is itself a known risk
// (2026-07-28: a prompt ending in build_scope's architecture essay made the
// model continue the essay as prose instead of writing files).
//
// Target repo is from event_41cbabb7, which is terminal -- nothing depends on
// its output, so burning a turn there is safe.
//
// Usage: node scripts/dispatch_verify_turn.mjs

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
const REPO = "AI-arena-hackathon/arena-team-alpha-d28b420c";
// Overridable so the retry after a harness fix is not the same turn_id as the
// run it supersedes (turn_id is the correlation key in the build-turn report).
const TURN_ID = process.argv[2] || "openrouter-verify-001";

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

// Verbatim from the target repo's README.md idea brief.
const oneLiner =
  "One-tap curb-side pickup that locks in a reliable slot and keeps you in the know even when traffic or staffing shift - no app maze, no last-minute alerts.";
const problem =
  "Retailer pickup apps force users through multiple screens and often only reveal a moved slot minutes before arrival, causing missed pickups. In 2026, 68% of urban shoppers still hit this friction because their apps lack single-click reservation and fail to update proactively.";
const solution =
  "A lightweight SDK retailers embed into their existing app. It pulls inventory and open windows from the retailer's API and merges that with traffic and staffing data. The user picks a store and a broad morning/afternoon/evening preference; the service recommends the narrowest possible slot, reserves it in one tap, and confirms instantly. If traffic or staffing forces a shift, an AI-driven fallback recalculates the optimal slot from historical patterns and notifies before the window ends. It falls back to a plain slot when live data is missing.";

// Same shape and ordering as executor.ts:725-733.
const taskPrompt =
  `This is a build turn for "SnapPick - One-tap Grocery Pickup Scheduling". The repository was scaffolded with AGENTS.md, BACKLOG.md, and arena.config.json (workspace pointers) - read all three first, then work from the backlog. If VERIFICATION_FAILURE.log or VERIFICATION_NOTE.log exists at the repo root, read them first - they record what the previous turn's verification found and must be addressed. If the repo has a .arena/skills/ directory, review it - agent-authored skills there apply to this turn.\n\n` +
  `1. PLAN (1-2 sentences): state which backlog item you will implement this turn and the files it touches.\n` +
  `2. IMPLEMENT: write real project files with your file-writing tools. Build the core of what the idea promises - the primary flow working beats breadth.\n` +
  `3. SELF-VERIFY before finishing: run the checks the repo declares (npm test / npx tsc --noEmit / pytest) and fix what fails. Then write VERIFICATION_REPORT.md at the repo root using the verification-loop skill's ladder (build, typecheck, lint, test, security, diff): one row per phase with the real command, the real exit code, and PASS / FAIL / SKIPPED (reason) - never a phase marked PASS because there was nothing to check. Its Verdict line reads READY only when every applicable phase passed. If no test suite exists yet, add at least one test this turn, and end your final message with the TDD EVIDENCE block from the test-driven-development skill (RED failure, GREEN pass, suite counts, tests added). A check run before your last edit proves nothing. The build verification step after you finish will fail the turn if the code does not build or tests fail.\n` +
  `3.5 REVIEW your own diff before finishing: load and run the baked code-review-and-quality and security-and-hardening skills against your changes and fix what they flag. This is not optional - the sandbox's egress filtering exists because of these rules, and a turn that ships an unreviewed change has not finished.\n` +
  `4. UPDATE BACKLOG.md: move what you did to "Done", add follow-up items.\n\n` +
  `What to build: ${oneLiner}\nProblem it solves: ${problem}\nSolution: ${solution}\n\n` +
  `Reference architecture notes below are guidance only - use them to inform what you build, do not restate or summarize them:\n` +
  `Node.js/Express backend exposing a slot engine and an idempotent reservation endpoint, with the traffic and staffing feeds stubbed behind interfaces so the deterministic heuristic fallback can be exercised without network access. Test the slot-recommendation and reservation-confirmation flow with a real test suite.`;

const res = await fetch(
  `https://api.github.com/repos/${REPO}/actions/workflows/team-build-turn.yml/dispatches`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({
      ref: "main",
      inputs: { team: "alpha", turn_id: TURN_ID, task_prompt: taskPrompt },
    }),
  },
);

console.log(`  dispatch to ${REPO}`);
console.log(`  turn_id: ${TURN_ID}`);
console.log(`  model:   openrouter/nvidia/nemotron-3-super-120b-a12b:free (workflow default)`);
console.log(`  prompt:  ${taskPrompt.length} chars`);
console.log(`  HTTP ${res.status} ${res.status === 204 ? "(accepted)" : await res.text()}`);
// process.exit() here crashes Node on Windows teardown (libuv assertion in
// async.c) AFTER a successful dispatch, which makes a 204 read as a failure to
// any caller checking the exit code. Setting exitCode and letting the event
// loop drain is the reliable form.
process.exitCode = res.status === 204 ? 0 : 1;