#!/usr/bin/env node
/**
 * Ops-rule regression tests (2026-11-01).
 *
 * Two rules are easy to get subtly wrong and hard to notice in production:
 *   - the agreement statistic (an earlier version summed expected agreement
 *     over every cell, so kappa silently came back undefined);
 *   - the quota-posture revisit proxy (the thresholds are a documented owner
 *     prompt, so a changed number should fail a test, not a review).
 *
 * Run with: npm run test:ops
 */
import assert from "node:assert/strict";
import { agreementBand, cohenKappa } from "./lib/agreement.mjs";
import { openRouterAccountForTeam, openRouterKeyForTeam } from "../src/events/build-quota.ts";
import { accountIndependence, probeOpenRouterAccounts } from "../src/observability/quota-accounts.ts";
import {
  QUOTA_POSTURE_BOTH_ACCOUNTS_DAYS_THRESHOLD,
  QUOTA_POSTURE_DAY_THRESHOLD,
  QUOTA_POSTURE_EVENT_THRESHOLD,
  quotaPostureReviewDue,
  quotaPostureTrigger,
} from "../src/observability/quota-posture.ts";
import { findOverScopedIdeas } from "./lib/scope_audit.mjs";

// Cohen's kappa: known 2x2 example. fail=0, weak=1, pass=2.
// A: fail, fail, pass, pass; B: fail, fail, pass, weak.
// po = 3/4; pe = (2/4)(2/4) + (2/4)(1/4) = 0.375; kappa = 0.6.
const known = cohenKappa([
  [0, 0],
  [0, 0],
  [2, 2],
  [2, 1],
]);
assert.equal(known.unweighted, 0.6, "known 2x2 kappa should be 0.6");
assert.equal(known.po, 0.75, "observed agreement should be 0.75");
assert.equal(known.pe, 0.375, "expected agreement should be 0.375");

const perfect = cohenKappa([
  [0, 0],
  [1, 1],
  [2, 2],
]);
assert.equal(perfect.unweighted, 1, "identical verdicts should give kappa 1");

const degenerate = cohenKappa([
  [1, 1],
  [1, 1],
]);
assert.equal(degenerate.unweighted, null, "a constant category makes kappa undefined, not zero");
assert.equal(degenerate.quadratic, null);

assert.equal(agreementBand(0.138), "slight");
assert.equal(agreementBand(0.63), "substantial");
assert.equal(agreementBand(null), "undefined");

// Two independent accounts, pinned one per team (measured 2026-11-01).
assert.equal(openRouterAccountForTeam("beta", "key2"), 2);
assert.equal(openRouterAccountForTeam("alpha", "key2"), 1);
assert.equal(openRouterAccountForTeam("gamma", "key2"), 1, "only beta is pinned to account 2");
assert.equal(openRouterAccountForTeam("beta"), 1, "missing key 2 means beta spends account 1");
assert.equal(openRouterAccountForTeam("beta", ""), 1, "empty key 2 is not configured");
assert.equal(openRouterKeyForTeam("beta", "k1", "k2"), "k2");
assert.equal(openRouterKeyForTeam("beta", "k1", undefined), "k1", "unset key 2 falls back to key 1");
assert.equal(openRouterKeyForTeam("alpha", "k1", "k2"), "k1");

// Independence must never be claimed from a missing or failed probe.
assert.equal(accountIndependence(null, "abc"), null);
assert.equal(accountIndependence("abc", null), null);
assert.equal(accountIndependence("abc", "def"), true);
assert.equal(accountIndependence("abc", "abc"), false);

// The admin probe must never echo key material, and must not claim
// independence when the provider returns the same (or no) account id.
const realFetch = globalThis.fetch;
const fetchStub = (sameAccount) => async (_url, init) => {
  const auth = init?.headers?.Authorization ?? "";
  const id = sameAccount ? "user_same" : auth.includes("k1") ? "user_a" : "user_b";
  return new Response(
    JSON.stringify({
      data: {
        creator_user_id: id,
        workspace_id: `ws_${id}`,
        is_free_tier: true,
        free_model_daily_requests: { used: 1, limit: 50, remaining: 49 },
      },
    }),
    { status: 200 },
  );
};

globalThis.fetch = fetchStub(false);
const twoAccounts = await probeOpenRouterAccounts({
  OPEN_ROUTER_API_KEY: "k1-secret",
  OPEN_ROUTER_API_KEY_2: "k2-secret",
});
assert.equal(twoAccounts.independent, true);
assert.match(twoAccounts.verdict, /two independent accounts/);
assert.equal(twoAccounts.accounts[0].daily_remaining, 49);
assert.equal(JSON.stringify(twoAccounts).includes("k1-secret"), false, "probe must not echo key 1");
assert.equal(JSON.stringify(twoAccounts).includes("k2-secret"), false, "probe must not echo key 2");

globalThis.fetch = fetchStub(true);
const sameAccount = await probeOpenRouterAccounts({
  OPEN_ROUTER_API_KEY: "k1-secret",
  OPEN_ROUTER_API_KEY_2: "k2-secret",
});
assert.equal(sameAccount.independent, false);
assert.match(sameAccount.verdict, /SAME account/);

globalThis.fetch = realFetch;

// Quota posture: both accounts on the same UTC day, OR two distinct events,
// OR three distinct UTC days in the window.
assert.equal(QUOTA_POSTURE_BOTH_ACCOUNTS_DAYS_THRESHOLD, 1);
assert.equal(QUOTA_POSTURE_EVENT_THRESHOLD, 2);
assert.equal(QUOTA_POSTURE_DAY_THRESHOLD, 3);
assert.equal(quotaPostureReviewDue(0, 0, 0), false);
assert.equal(quotaPostureReviewDue(0, 1, 2), false);
assert.equal(quotaPostureReviewDue(1, 0, 0), true, "both accounts on one day is an arena-wide squeeze");
assert.equal(quotaPostureReviewDue(0, 2, 0), true);
assert.equal(quotaPostureReviewDue(0, 0, 3), true);
assert.equal(quotaPostureTrigger(1, 2, 3), "both_accounts_same_day", "same-day both accounts wins");
assert.equal(quotaPostureTrigger(0, 2, 3), "events", "events wins over days");
assert.equal(quotaPostureTrigger(0, 1, 3), "days");
assert.equal(quotaPostureTrigger(0, 1, 2), null);

// Architecture over-scope tripwire: a banned term is a warning, but a
// sentence that explicitly excludes it is compliant (the prompt tells the
// model to list these under "out of scope").
assert.deepEqual(
  findOverScopedIdeas([{ id: "a", title: "K8s app", build_scope: "Deploy the service on Kubernetes with a multi-region database." }]).map((i) => i.id),
  ["a"],
);
assert.deepEqual(
  findOverScopedIdeas([{ id: "b", title: "Scoped", build_scope: "One repo, one command. Out of scope: Kubernetes, blockchain, custom model training." }]),
  [],
);
assert.deepEqual(
  findOverScopedIdeas([{ id: "c", title: "Negated", build_scope: "No Kubernetes. No multi-cloud. The app writes to SQLite." }]),
  [],
);
assert.deepEqual(
  findOverScopedIdeas([{ id: "d", title: "Plain", build_scope: "Static frontend plus a small Node service with SQLite storage." }]),
  [],
);
assert.deepEqual(findOverScopedIdeas([{ id: "e", title: "Empty", build_scope: "" }]), []);

console.log("ops rule tests passed");
