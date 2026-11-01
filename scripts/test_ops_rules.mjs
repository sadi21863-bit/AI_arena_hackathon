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
import {
  QUOTA_POSTURE_DAY_THRESHOLD,
  QUOTA_POSTURE_EVENT_THRESHOLD,
  quotaPostureReviewDue,
  quotaPostureTrigger,
} from "../src/observability/quota-posture.ts";

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

// Quota posture: two distinct events OR three distinct UTC days in the window.
assert.equal(QUOTA_POSTURE_EVENT_THRESHOLD, 2);
assert.equal(QUOTA_POSTURE_DAY_THRESHOLD, 3);
assert.equal(quotaPostureReviewDue(0, 0), false);
assert.equal(quotaPostureReviewDue(1, 2), false);
assert.equal(quotaPostureReviewDue(2, 0), true);
assert.equal(quotaPostureReviewDue(0, 3), true);
assert.equal(quotaPostureTrigger(2, 3), "events", "events wins when both thresholds are crossed");
assert.equal(quotaPostureTrigger(1, 3), "days");
assert.equal(quotaPostureTrigger(1, 2), null);

console.log("ops rule tests passed");
