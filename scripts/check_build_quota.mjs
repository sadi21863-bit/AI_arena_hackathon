// Verifies the free-tier dispatch quota probe behaves the way the scheduler's
// build cadence depends on (src/events/build-quota.ts).
//
// Same rationale as check_subrequest_counter.mjs: the logic is small but its
// failure modes are expensive and quiet — a probe that blocks when it should
// allow stalls an entire event, and a probe that allows against a spent pool
// re-dispatchs into a guaranteed 429 wall all day (the exact waste it exists
// to remove). So the decisions are asserted directly against the real module,
// loaded with its type annotations stripped — a copy would drift.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "events", "build-quota.ts"), "utf8");

// Targeted strips for THIS module's annotations. If build-quota.ts gains a
// construct not covered here, the import below fails loudly (SyntaxError) —
// which is the point: the checker must exercise the real file.
const js = src
  .replace(/export interface QuotaDecision \{[\s\S]*?\n\}\n/g, "")
  .replace(/export (const|function|async function)/g, "$1")
  .replace(/new Map<string, QuotaDecision>\(\)/g, "new Map()")
  .replace(/nowMs: number/g, "nowMs")
  .replace(/teamName: string/g, "teamName")
  .replace(/key1: string \| undefined/g, "key1")
  .replace(/key2: string \| undefined/g, "key2")
  .replace(/body: unknown/g, "body")
  .replace(/key: string \| undefined/g, "key")
  .replace(/nowMs: number = Date\.now\(\)/g, "nowMs = Date.now()")
  .replace(/\(body as \{ data\?: \{ free_model_daily_requests\?: \{ remaining\?: unknown \} \} \}\)/g, "body")
  .replace(/let decision: QuotaDecision/g, "let decision")
  .replace(/\): number \{/g, ") {")
  .replace(/\): string \| undefined \{/g, ") {")
  .replace(/\): QuotaDecision \{/g, ") {")
  .replace(/\): Promise<boolean> \{/g, ") {");

const mod = await import("data:text/javascript," + encodeURIComponent(js + "\nexport { QUOTA_DISPATCH_FLOOR, nextUtcMidnightAfter, openRouterKeyForTeam, quotaDecisionFor, buildDispatchBudgetAllows };"));
const { QUOTA_DISPATCH_FLOOR, nextUtcMidnightAfter, openRouterKeyForTeam, quotaDecisionFor, buildDispatchBudgetAllows } = mod;

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else { failed++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 15, 17, 0, 0); // 2026-10-15T17:00:00Z
const body = (remaining) => ({ data: { free_model_daily_requests: { used: 10, limit: 50, remaining } } });

// --- quotaDecisionFor: the allow/block boundary -----------------------------

const ok50 = quotaDecisionFor(body(50), NOW);
check("remaining 50 -> allowed", ok50.allowed === true);
check("allowed answer has a short TTL", ok50.holdUntilMs === NOW + 5 * MIN, String(ok50.holdUntilMs - NOW));

check("remaining at the floor -> allowed (inclusive)", quotaDecisionFor(body(QUOTA_DISPATCH_FLOOR), NOW).allowed === true);

const low = quotaDecisionFor(body(QUOTA_DISPATCH_FLOOR - 1), NOW);
check("below the floor -> blocked", low.allowed === false);
check("blocked answer holds until just past UTC midnight",
  low.holdUntilMs === nextUtcMidnightAfter(NOW) + MIN,
  `got ${new Date(low.holdUntilMs).toISOString()}`);
check("blocked answer holds past the reset, not before it", low.holdUntilMs > Date.UTC(2026, 9, 16, 0, 0, 0));

check("remaining 0 -> blocked", quotaDecisionFor(body(0), NOW).allowed === false);
check("negative remaining -> blocked", quotaDecisionFor(body(-5), NOW).allowed === false);

// --- quotaDecisionFor: fail-open on shapes it does not recognise ------------

check("missing free_model_daily_requests -> allowed (paid key shape)", quotaDecisionFor({ data: {} }, NOW).allowed === true);
check("null body -> allowed", quotaDecisionFor(null, NOW).allowed === true);
check("string remaining -> allowed (never trust a mis-typed field)", quotaDecisionFor(body("12"), NOW).allowed === true);

// --- nextUtcMidnightAfter ---------------------------------------------------

check("midnight math: 17:00Z -> next 00:00Z",
  nextUtcMidnightAfter(NOW) === Date.UTC(2026, 9, 16, 0, 0, 0),
  new Date(nextUtcMidnightAfter(NOW)).toISOString());
check("midnight math: 23:59Z -> next 00:00Z",
  nextUtcMidnightAfter(Date.UTC(2026, 9, 15, 23, 59, 0)) === Date.UTC(2026, 9, 16, 0, 0, 0));
check("midnight math: 00:01Z -> same day's 00:00Z is past, rolls forward",
  nextUtcMidnightAfter(Date.UTC(2026, 9, 16, 0, 1, 0)) === Date.UTC(2026, 9, 17, 0, 0, 0));

// --- openRouterKeyForTeam: mirrors the workflow's TEAM_KEY_PIN --------------

check("beta with key 2 -> key 2", openRouterKeyForTeam("beta", "k1", "k2") === "k2");
check("beta without key 2 -> key 1", openRouterKeyForTeam("beta", "k1", undefined) === "k1");
check("alpha -> key 1", openRouterKeyForTeam("alpha", "k1", "k2") === "k1");

// --- buildDispatchBudgetAllows: fetch, cache, fail-open ---------------------

let fetchCalls = 0;
let nextFetch = { ok: true, json: async () => body(40) };
globalThis.fetch = async () => { fetchCalls++; return nextFetch; };

check("no key -> allowed without probing", (await buildDispatchBudgetAllows(undefined, NOW)) === true && fetchCalls === 0);

// Allowed answers cache for the short TTL: one probe serves repeated ticks.
fetchCalls = 0;
nextFetch = { ok: true, json: async () => body(40) };
check("healthy pool -> allowed", (await buildDispatchBudgetAllows("pool-a", NOW)) === true);
check("second ask within TTL -> no second probe", (await buildDispatchBudgetAllows("pool-a", NOW + MIN)) === true && fetchCalls === 1, `fetchCalls=${fetchCalls}`);

// A spent pool holds until the reset even if the provider would now answer
// differently — remaining only decreases within a UTC day, so re-asking
// before midnight cannot change the answer.
fetchCalls = 0;
nextFetch = { ok: true, json: async () => body(0) };
check("spent pool -> blocked", (await buildDispatchBudgetAllows("pool-b", NOW)) === false);
nextFetch = { ok: true, json: async () => body(45) };
check("spent pool stays blocked before midnight", (await buildDispatchBudgetAllows("pool-b", NOW + 3 * 60 * MIN)) === false);
check("...without re-probing (the day cannot give budget back)", fetchCalls === 1, `fetchCalls=${fetchCalls}`);
check("spent pool unblocks after the UTC reset", (await buildDispatchBudgetAllows("pool-b", Date.UTC(2026, 9, 16, 0, 1, 1))) === true);
check("...and that took a real second probe", fetchCalls === 2, `fetchCalls=${fetchCalls}`);

// Fail-open: network/HTTP/parse trouble must never hold a healthy build.
fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error("network down"); };
check("fetch throws -> allowed (fail-open)", (await buildDispatchBudgetAllows("pool-c", NOW)) === true);
globalThis.fetch = async () => { fetchCalls++; return { ok: false, json: async () => ({}) }; };
check("HTTP error -> allowed (fail-open)", (await buildDispatchBudgetAllows("pool-d", NOW)) === true);
globalThis.fetch = async () => { fetchCalls++; return { ok: true, json: async () => "not json at all" }; };
check("odd body -> allowed (fail-open)", (await buildDispatchBudgetAllows("pool-e", NOW)) === true);

console.log(failed === 0 ? "\nall build-quota cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
