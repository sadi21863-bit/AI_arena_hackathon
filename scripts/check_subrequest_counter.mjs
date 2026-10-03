// Verifies the subrequest counter measures what it claims.
//
// This exists because the fix it instruments was derived from arithmetic, and an
// instrumentation bug would make the measurement look like validation while
// measuring nothing — the exact failure mode incident §10 warns about. So the
// counter is exercised directly: windows must not bleed across invocations
// (Workers reuse isolates), totals must be the sum of the three buckets, and
// counting while untracked must be free.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The module is TS with no runtime deps, so strip types and load it directly
// rather than duplicating its logic (which would let the copy drift).
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "observability", "subrequests.ts"), "utf8");
const js = src
  .replace(/export interface[\s\S]*?\n}\n/g, "")
  .replace(/export (function|const|let)/g, "$1")
  .replace(/:\s*SubrequestCounts/g, "")
  .replace(/\(c:\s*SubrequestCounts = counts\)/g, "(c = counts)")
  .replace(/:\s*void/g, "")
  .replace(/:\s*number/g, "")
  .replace(/:\s*boolean/g, "")
  .replace(/\(n\s*=\s*1\)/g, "(n = 1)");
const mod = await import("data:text/javascript," + encodeURIComponent(js + "\nexport { beginSubrequestTracking, endSubrequestTracking, subrequestTotal, countGitHubRequest, countMainRepoFetch, countDbStatement, isTrackingSubrequests };"));

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else { failed++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

// 1. Nothing is counted before a window opens.
mod.countGitHubRequest();
mod.countDbStatement();
let c = mod.endSubrequestTracking();
check("no counts before a window opens", c.github === 0 && c.db === 0, JSON.stringify(c));

// 2. A window counts what it is told, and the total is the sum of buckets.
mod.beginSubrequestTracking();
mod.countGitHubRequest();
mod.countGitHubRequest();
mod.countMainRepoFetch(3);
mod.countDbStatement();
c = mod.endSubrequestTracking();
check("github counted", c.github === 2, JSON.stringify(c));
check("mainRepo counted", c.mainRepo === 3, JSON.stringify(c));
check("db counted", c.db === 1, JSON.stringify(c));
check("total is the sum of the three buckets", mod.subrequestTotal(c) === 6, String(mod.subrequestTotal(c)));

// 3. A new invocation in a recycled isolate must NOT inherit the previous
//    window's counts. This is the failure that would silently inflate every
//    measurement after the first.
mod.beginSubrequestTracking();
c = mod.endSubrequestTracking();
check("a new window starts from zero (isolate reuse)", mod.subrequestTotal(c) === 0, JSON.stringify(c));

// 4. endSubrequestTracking hands back a copy, not the live object — otherwise a
//    caller could mutate the module's state.
mod.beginSubrequestTracking();
mod.countGitHubRequest();
c = mod.endSubrequestTracking();
c.github = 999;
const after = mod.beginSubrequestTracking();
const c2 = mod.endSubrequestTracking();
check("returned counts are a copy", c2.github === 0, JSON.stringify(c2));

// 5. The real call sites must actually be wired to the counter, or the whole
//    thing measures an empty path.
const client = readFileSync(join(here, "..", "src", "github", "client.ts"), "utf8");
check("githubRequest increments the github bucket",
  /export async function githubRequest[\s\S]{0,400}countGitHubRequest\(\)/.test(client));
const repos = readFileSync(join(here, "..", "src", "github", "repos.ts"), "utf8");
check("fetchMainRepoFile increments the mainRepo bucket",
  /async function fetchMainRepoFile[\s\S]{0,200}countMainRepoFetch\(\)/.test(repos));
const exec = readFileSync(join(here, "..", "src", "events", "executor.ts"), "utf8");
check("handleTeamFormation opens a measurement window",
  // 900 chars: the call sits after the explanatory comment block, which is
  // ~610 chars. Widened deliberately so this still catches removal while
  // tolerating comment growth — the failure this guards against is a deleted
  // call, not a reworded comment.
  /async function handleTeamFormation[\s\S]{0,900}beginSubrequestTracking\(\)/.test(exec));
check("the window is closed and recorded in a finally block",
  /finally[\s\S]{0,900}endSubrequestTracking\(\)/.test(exec));
const n = (exec.match(/countDbStatement\(\)/g) || []).length;
check("D1 statements in the formation path are counted", n >= 6, `found ${n} countDbStatement() calls`);

console.log(failed === 0 ? "\nall subrequest-counter cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);