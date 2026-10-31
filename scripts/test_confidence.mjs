#!/usr/bin/env node
/**
 * Confidence-rule regression tests (2026-10-31).
 *
 * These are the rules the public `quality` label uses. A bad threshold change
 * would silently relabel historical events, so pin the behaviour:
 *   - <10 judged targets is low, even when the gate passed;
 *   - 12 inside the band is medium;
 *   - 36 inside the band is high;
 *   - failed gate or retrospective outside 0.60-0.95 is low;
 *   - a 2-team hackathon is low;
 *   - non-terminal / no-calibration is unrated.
 *
 * Run with: npm run test:confidence
 * (Node 22+ type stripping imports the TypeScript module directly.)
 */
import assert from "node:assert/strict";
import { computeEventConfidence, measureJudgeAgreement } from "../src/judges/confidence.ts";

const base = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const add = (a, b) => a.map((x, i) => x + b[i]);
const noise1 = [0, 2, -2, 1, -1, 2, -2, 1, -1, 2];
const noise2 = [-2, 1, 2, -1, 0, -2, 1, 2, -1, 0];
const noise3 = [1, -1, 0, 2, -2, 1, -1, 0, 2, -2];

function rowsFor(vectors) {
  const rows = [];
  for (let j = 0; j < vectors.length; j += 1) {
    for (let t = 0; t < vectors[j].length; t += 1) {
      rows.push({ judge_name: `J${j}`, target_id: `t${t}`, score: vectors[j][t] });
    }
  }
  return rows;
}

const inside = measureJudgeAgreement(rowsFor([base, add(base, noise1), add(base, noise2), add(base, noise3)]));
const above = measureJudgeAgreement(rowsFor([base, base, base, base]));
const below = measureJudgeAgreement(
  rowsFor([base, base.map((x) => 11 - x), base.map((x) => 11 - x), base.map((x) => 11 - x)]),
);
const insufficient = measureJudgeAgreement(rowsFor([[1, 2], [1, 2], [1, 2]]));

assert.equal(inside.band, "inside", "noisy but correlated judges should be inside the band");
assert.equal(above.band, "above", "identical judges should be above the band");
assert.equal(below.band, "below", "one anti-correlated judge among clones should be below the band");
assert.equal(insufficient.band, "insufficient_data", "two targets cannot produce a correlation");
assert.equal(insufficient.mean_correlation, null);

const q = (overrides = {}) =>
  computeEventConfidence({
    eventType: "ideathon",
    status: "judged",
    judgedPopulation: 10,
    preEvent: { correlation: 0.9, passed: true },
    retrospective: inside,
    ...overrides,
  });

assert.equal(q({ judgedPopulation: 7 }).level, "low", "small population is low even inside the band");
assert.equal(q({ judgedPopulation: 12 }).level, "medium", "12 inside the band is medium");
assert.equal(q({ judgedPopulation: 36 }).level, "high", "36 inside the band is high");
assert.equal(
  q({ judgedPopulation: 36, retrospective: { ...inside, band: "below", mean_correlation: 0.554 } }).level,
  "low",
  "large population cannot rescue a below-band retrospective",
);
assert.equal(
  q({ judgedPopulation: 36, retrospective: { ...inside, band: "above", mean_correlation: 0.99 } }).level,
  "low",
  "above-band over-agreement is low",
);
assert.equal(
  q({ judgedPopulation: 36, retrospective: { ...inside, band: "insufficient_data", mean_correlation: null } }).level,
  "medium",
  "unmeasured agreement keeps a large event medium",
);
assert.equal(
  q({ preEvent: { correlation: 0.483, passed: false } }).level,
  "low",
  "a failed gate is low",
);
assert.equal(
  q({ preEvent: null }).level,
  "unrated",
  "no calibration is unrated",
);
assert.equal(
  q({ status: "deep_research" }).level,
  "unrated",
  "an in-flight event is unrated",
);
assert.equal(
  q({
    eventType: "hackathon",
    status: "complete",
    judgedPopulation: 2,
    preEvent: { correlation: 0.9, passed: true, source: "parent" },
    retrospective: insufficient,
  }).level,
  "low",
  "a 2-team hackathon is low",
);

console.log("confidence tests passed");
