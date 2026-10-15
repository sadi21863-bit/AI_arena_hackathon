// Structural checks on the pre-dispatch credential repair (added 2026-10-15).
//
// The failure it fixes: setTeamRepoSecrets ran only at createTeamRepo, so a
// team repo created before a provider switch never gained the new key — the
// live shape on 2026-10-13, when existing repos lacked OPEN_ROUTER_API_KEY
// until a human set it by hand. The fix has three properties at once:
//   (a) dispatchTurnIfNeeded repairs missing secrets before dispatching,
//   (b) the repair is skipped for a repo that was just created (the pair of
//       pre-dispatch repairs shares one subrequest budget — incident §10), and
//   (c) provisioning and the /headroom reporting lists are derived from one
//       BUILD_SECRET_SPEC, so they cannot disagree again (they did once: the
//       `_2` failover keys were provisioned but unreported).
// Each is one deletion or re-hardcode away from regressing silently, so each
// is locked here. Behavioural notes that CAN'T be checked structurally (the
// steady-state cost of one list call, the name-only rotation blind spot) are
// documented at ensureTeamRepoSecrets in src/github/repos.ts.

import { readFileSync } from "node:fs";

const repos = readFileSync("src/github/repos.ts", "utf8");
const turns = readFileSync("src/events/build-turns.ts", "utf8");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else { failed++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

// --- (a) the repair is wired into the dispatch path ---
check("ensureTeamRepoSecrets is exported",
  /export async function ensureTeamRepoSecrets\(/.test(repos));

const justCreatedIdx = turns.indexOf("if (!input.justCreated) {");
const repairIdx = turns.indexOf("ensureTeamRepoSecrets(env, input.repoFullName)");
check("dispatchTurnIfNeeded calls the repair", repairIdx > 0, "call not found");
check("the repair is inside the !justCreated branch",
  repairIdx > justCreatedIdx && justCreatedIdx > 0,
  `justCreated at ${justCreatedIdx}, repair at ${repairIdx}`);

// Best-effort, like the harness sync: a repo we could not repair is no worse
// dispatched than not (the workflow's credential guard fails loudly anyway).
check("a failed repair still dispatches",
  /credential sync failed[\s\S]{0,220}\(dispatching anyway\)/.test(turns));

// --- steady-state cost: list first, public key only when repairing ---
const ensStart = repos.indexOf("export async function ensureTeamRepoSecrets(");
const ens = repos.slice(ensStart, ensStart + 2600);
const emptyIdx = ens.indexOf("if (missing.length === 0) return [];");
const pkIdx = ens.indexOf("actions/secrets/public-key");
check("the repair lists before it fetches the public key",
  emptyIdx > 0 && pkIdx > emptyIdx, `missing-guard at ${emptyIdx}, public key at ${pkIdx}`);
check("the in-sync path returns before any PUT",
  /if \(missing\.length === 0\) return \[\];[\s\S]{0,260}actions\/secrets\/public-key/.test(ens));
check("only MISSING names are (re)sealed — present values are left alone",
  /missing\.map\(\(s\) => setRepoSecret\(/.test(ens));
// Unset Worker env values must not count as "missing", or every dispatch
// retries setting a secret that cannot be set.
check("expected follows the env filter used by provisioning",
  /expected = BUILD_SECRET_SPEC\.filter\(\(s\) => !!s\.value\(env\)\)/.test(ens));

// --- (c) one spec: provisioning and reporting derive from the same list ---
check("setTeamRepoSecrets consumes BUILD_SECRET_SPEC",
  /async function setTeamRepoSecrets[\s\S]{0,400}BUILD_SECRET_SPEC/.test(repos));
check("REQUIRED_BUILD_SECRETS is derived, not hardcoded",
  /export const REQUIRED_BUILD_SECRETS: readonly string\[\] = BUILD_SECRET_SPEC\.filter/.test(repos));
check("OPTIONAL_BUILD_SECRETS is derived, not hardcoded",
  /export const OPTIONAL_BUILD_SECRETS: readonly string\[\] = BUILD_SECRET_SPEC\.filter/.test(repos));
check("the hardcoded wanted array has not come back",
  !/const wanted: Array</.test(repos), "a second, driftable secret list exists again");

console.log(failed === 0 ? "\nall credential-repair cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
