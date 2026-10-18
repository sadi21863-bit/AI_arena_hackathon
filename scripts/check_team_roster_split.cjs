// Guards the roster split of team formation against the call-site defect of
// 2026-10-17 (live event_693bc79b): assignTeamMembers was called ONCE PER TEAM
// inside the per-team loop, with a single-element `teams` array. The split is
// a round-robin over exactly the teams it is given (`i % input.teams.length`),
// so an array of one sends EVERY non-lead agent to that team — alpha got all
// 10 non-leads, then beta got all 10 again. Both teams ended up with 12-member
// rosters (verified live: SELECT team_id, COUNT(*) FROM hackathon_team_members
// returned 12 + 12) instead of the intended 6 + 6. The code around the call
// looked completely reasonable, which is why nothing caught it: it took a real
// event's member count to see it. That is the masking class this check closes.
//
// The fix: phase 1 ensures a team ROW exists for every team of the formation
// (repo_url staged NULL, status 'forming'), phase 2 makes ONE roster call with
// all of them, phase 3 does per-team work (one repo per invocation — the
// subrequest cap that killed earlier attempts). See executor.ts runTeamFormation.
//
// The check has two halves, because either alone could be gamed:
//
//   STATIC — the call site must pass the collected multi-team roster variable
//   (rosterTeams), must not build a per-team `[{ teamId: ... }]` literal, and
//   must run before any opener lookup or repo creation. Reverting to the old
//   shape fails these immediately.
//
//   BEHAVIORAL — a faithful mirror of assignTeamMembers' split math (the exact
//   algorithm is re-pinned below so this mirror can't silently drift from the
//   implementation) is run under BOTH calling conventions. The new convention
//   must produce the intended disjoint 6 + 6 rosters — the exact sets the
//   repair SQL for event_693bc79b uses — while the old convention must
//   reproduce the live 12 + 12 damage and FAIL the same expectation, so this
//   check demonstrably catches the defect class it was written for.
//
// Run from the repo root: node scripts/check_team_roster_split.cjs

const fs = require("fs");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------------------
// STATIC — the call-site structure in the formation handler.
// ---------------------------------------------------------------------------
const exec = fs.readFileSync("src/events/executor.ts", "utf8");
const slice = exec.slice(
  exec.indexOf("async function handleTeamFormation"),
  exec.indexOf("async function handleDispatchBuildTurn")
);
check("formation handler slice found", slice.length > 0);

const assignIdx = slice.indexOf("assignTeamMembers(");
const callCount = (slice.match(/assignTeamMembers\(/g) || []).length;
check("exactly ONE assignTeamMembers call in the formation handler",
  callCount === 1, `found ${callCount} — one per team is the live bug`);
check("the call passes the collected roster variable (teams: rosterTeams)",
  /assignTeamMembers\(env,\s*\{[^}]*teams:\s*rosterTeams[^}]*\}\s*\)/.test(slice),
  "the roster argument must be the all-teams array, not a fresh literal");
check("no per-team `teams: [{ teamId: ... }]` literal remains",
  !/teams:\s*\[\s*\{[^}]*teamId/.test(slice),
  "a single-element teams literal assigns every non-lead to that one team (i % 1)");

const nextAuthorIdx = slice.indexOf("nextBuildAuthor(");
check("roster call precedes the opener lookup",
  assignIdx !== -1 && nextAuthorIdx !== -1 && assignIdx < nextAuthorIdx,
  `assignIdx=${assignIdx} nextBuildAuthorIdx=${nextAuthorIdx} — turn 1 must know its author`);

const createRepoIdx = slice.indexOf("createTeamRepo(");
check("roster call precedes any repo creation (phase 2 before phase 3)",
  assignIdx !== -1 && createRepoIdx !== -1 && assignIdx < createRepoIdx,
  `assignIdx=${assignIdx} createTeamRepoIdx=${createRepoIdx}`);

check("every team row participates: building-skip still pushes to the roster",
  /status === "building"\)\s*\{[\s\S]{0,600}?rosterTeams\.push/.test(slice),
  "a retry that finds one team 'building' must still give it to the one roster call");
const pushCount = (slice.match(/rosterTeams\.push/g) || []).length;
check("staged and pre-existing teams both join the roster (>= 2 pushes)",
  pushCount >= 2, `found ${pushCount}`);

// ---------------------------------------------------------------------------
// BEHAVIORAL — mirror of assignTeamMembers' split, under both conventions.
// ---------------------------------------------------------------------------
const tm = fs.readFileSync("src/events/team-members.ts", "utf8");
check("team-members.ts still rounds-robins over input.teams (mirror is faithful)",
  /i % input\.teams\.length/.test(tm) && /const claimed = new Set<string>/.test(tm) &&
  /rest\.forEach\(\(id, i\) =>/.test(tm));
check("team-members.ts documents the all-teams precondition",
  /PRECONDITION/.test(tm) && /EVERY team/.test(tm));

const personas = fs.readFileSync("src/agents/personas.ts", "utf8");
const agentIds = [...personas.matchAll(/id:\s*"(agent_[a-z]+)"/g)].map((m) => m[1]);
check("personas.ts yields the 12-agent roster in order",
  agentIds.length === 12 && agentIds[0] === "agent_alex" && agentIds.includes("agent_ellis"),
  `got ${agentIds.length}`);

// The live event's leading pair (alpha built Alex's idea, beta built Ellis's —
// same pair whose rosters the repair SQL will rebuild).
const ALPHA_LEAD = "agent_alex";
const BETA_LEAD = "agent_ellis";

// Faithful mirror of assignTeamMembers (team-members.ts): leads claimed in
// team order, remaining agents round-robined across the teams given.
function splitOnce(teams, ids) {
  const claimed = new Set();
  const leadOf = new Map();
  for (const t of teams) {
    const leads = [t.ideaAgentId, t.ideaCoAgentId].filter((id) => !!id && !claimed.has(id));
    leads.forEach((id) => claimed.add(id));
    leadOf.set(t.id, leads);
  }
  const rest = ids.filter((id) => !claimed.has(id));
  const per = new Map(teams.map((t) => [t.id, []]));
  rest.forEach((id, i) => per.get(teams[i % teams.length].id).push(id));
  const roster = new Map();
  for (const t of teams) roster.set(t.id, [...(leadOf.get(t.id) || []), ...per.get(t.id)]);
  return roster;
}

// New convention: ONE call with the whole formation (findings above).
const newRosters = splitOnce(
  [
    { id: "alpha", ideaAgentId: ALPHA_LEAD, ideaCoAgentId: null },
    { id: "beta", ideaAgentId: BETA_LEAD, ideaCoAgentId: null },
  ],
  agentIds
);

// Old convention: one call PER TEAM, each seeing a single-element array.
const oldAlpha = splitOnce([{ id: "alpha", ideaAgentId: ALPHA_LEAD, ideaCoAgentId: null }], agentIds);
const oldBeta = splitOnce([{ id: "beta", ideaAgentId: BETA_LEAD, ideaCoAgentId: null }], agentIds);

// The intended split — must equal the repair SQL's keep-sets for event_693bc79b.
const EXPECTED_ALPHA = ["agent_alex", "agent_blake", "agent_drew", "agent_gale", "agent_iris", "agent_kai"];
const EXPECTED_BETA = ["agent_casey", "agent_ellis", "agent_finn", "agent_hale", "agent_jade", "agent_leo"];
const sameSet = (a, b) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

const alphaRoster = newRosters.get("alpha");
const betaRoster = newRosters.get("beta");
check("new convention: alpha is the exact intended 6", sameSet(alphaRoster, EXPECTED_ALPHA),
  `got ${[...alphaRoster].sort()}`);
check("new convention: beta is the exact intended 6", sameSet(betaRoster, EXPECTED_BETA),
  `got ${[...betaRoster].sort()}`);

const overlap = alphaRoster.filter((id) => betaRoster.includes(id));
check("new convention: rosters are disjoint", overlap.length === 0, `overlap: ${overlap}`);
check("new convention: every agent has exactly one team",
  new Set([...alphaRoster, ...betaRoster]).size === 12,
  `union ${new Set([...alphaRoster, ...betaRoster]).size}`);

// The old convention must reproduce the live damage and be rejected by the
// exact same expectation — proving this check fails on the defect, not just
// passes on the fix.
const oldAlphaRoster = oldAlpha.get("alpha");
const oldBetaRoster = oldBeta.get("beta");
check("old convention reproduces the live 12 + 12 damage",
  oldAlphaRoster.length === 12 && oldBetaRoster.length === 12,
  `got ${oldAlphaRoster.length} + ${oldBetaRoster.length}`);
check("old convention FAILS the intended-split expectation (masking class)",
  !sameSet(oldAlphaRoster, EXPECTED_ALPHA) && !sameSet(oldBetaRoster, EXPECTED_BETA),
  "if this ever passes, the expectations no longer discriminate the bug");

console.log(failed === 0 ? "\nall team_roster split cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
