/**
 * Per-invocation subrequest accounting.
 *
 * Cloudflare gives a Worker no subrequest counter, so this counts the calls that
 * draw on the per-invocation budget: GitHub API calls, raw.githubusercontent
 * fetches, and D1 statements. That total is what incident §10's
 * `team_formation` fix was reasoned about — it moved a modelled 78 subrequests
 * per team to a modelled 40 — and nothing had ever confirmed the model. This
 * makes the next run report a measured number instead.
 *
 * Scope, stated plainly: this counts what the arena issues, which is the bulk of
 * an invocation's subrequests. It cannot see subrequests Cloudflare makes
 * internally on our behalf, so a logged total is a lower bound on the platform's
 * own accounting, never a larger number. A run that logs 38 and still hits the
 * cap would mean something outside this module is issuing requests, which is
 * exactly the case worth catching.
 *
 * State is module-scoped because Workers reuse isolates across invocations. Every
 * measurement resets explicitly at the start of the task it describes, so a
 * recycled isolate cannot attribute one invocation's calls to another's total.
 */

export interface SubrequestCounts {
  github: number;
  mainRepo: number;
  db: number;
}

let counts: SubrequestCounts = { github: 0, mainRepo: 0, db: 0 };
let tracking = false;

/** Begins a fresh measurement window. Any prior counts are discarded. */
export function beginSubrequestTracking(): void {
  counts = { github: 0, mainRepo: 0, db: 0 };
  tracking = true;
}

/** Ends tracking and returns the totals for the window just measured. */
export function endSubrequestTracking(): SubrequestCounts {
  tracking = false;
  return { ...counts };
}

export function subrequestTotal(c: SubrequestCounts = counts): number {
  return c.github + c.mainRepo + c.db;
}

/** True while a measurement window is open — hot-path counters check this first. */
export function isTrackingSubrequests(): boolean {
  return tracking;
}

export function countGitHubRequest(n = 1): void {
  if (tracking) counts.github += n;
}

export function countMainRepoFetch(n = 1): void {
  if (tracking) counts.mainRepo += n;
}

export function countDbStatement(n = 1): void {
  if (tracking) counts.db += n;
}