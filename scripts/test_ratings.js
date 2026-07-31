#!/usr/bin/env node
/**
 * Tests for N-5's Elo math (src/agents/ratings.ts).
 *
 * The properties that matter are the ones that would be invisible if wrong:
 * a rating system with a sign error or an asymmetric update still produces
 * plausible-looking numbers on a leaderboard, and nobody would notice for
 * several events.
 *
 *   node scripts/test_ratings.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Evaluate the real function bodies rather than reimplementing them, so this
// cannot drift from the source it claims to test.
const source = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "ratings.ts"), "utf8");
const pick = (name, pattern) => {
  const m = source.match(pattern);
  assert.ok(m, `${name} not found in ratings.ts — test is out of date with the source`);
  return m[0];
};

const js = [
  pick("expectedScore", /export function expectedScore[\s\S]*?\n\}/),
  pick("updateRating", /export function updateRating[\s\S]*?\n\}/),
  pick("meanRating", /export function meanRating[\s\S]*?\n\}/),
]
  .join("\n")
  .replace(/export /g, "")
  .replace(/:\s*number\[\]/g, "")
  .replace(/:\s*number/g, "")
  .replace(/\bk = K_FACTOR\b/, "k = 24")
  .replace(/DEFAULT_RATING/g, "1200");

const context = { module: {} };
vm.createContext(context);
vm.runInContext(js + "\nmodule.exports = { expectedScore, updateRating, meanRating };", context);
const { expectedScore, updateRating, meanRating } = context.module.exports;

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

console.log("expectedScore");

check("equal ratings are a coin flip", () => {
  assert.ok(near(expectedScore(1200, 1200), 0.5));
});

check("expectations are complementary (no probability is invented or lost)", () => {
  assert.ok(near(expectedScore(1500, 1300) + expectedScore(1300, 1500), 1));
});

check("a 400-point favourite is expected to win ~10 of 11", () => {
  assert.ok(near(expectedScore(1600, 1200), 10 / 11, 1e-6));
});

check("higher rating always means higher expectation", () => {
  assert.ok(expectedScore(1400, 1200) > expectedScore(1300, 1200));
});

console.log("updateRating");

check("winning raises, losing lowers", () => {
  assert.ok(updateRating(1200, 1200, 1) > 1200);
  assert.ok(updateRating(1200, 1200, 0) < 1200);
});

check("an even match moves exactly K/2", () => {
  assert.ok(near(updateRating(1200, 1200, 1) - 1200, 12));
  assert.ok(near(1200 - updateRating(1200, 1200, 0), 12));
});

check("a draw between equals moves nobody", () => {
  assert.ok(near(updateRating(1200, 1200, 0.5), 1200));
});

check("beating a stronger opponent gains more than beating a weaker one", () => {
  const vsStrong = updateRating(1200, 1600, 1) - 1200;
  const vsWeak = updateRating(1200, 800, 1) - 1200;
  assert.ok(vsStrong > vsWeak, `expected ${vsStrong} > ${vsWeak}`);
});

check("losing to a stronger opponent costs less than losing to a weaker one", () => {
  const toStrong = 1200 - updateRating(1200, 1600, 0);
  const toWeak = 1200 - updateRating(1200, 800, 0);
  assert.ok(toStrong < toWeak, `expected ${toStrong} < ${toWeak}`);
});

check("an even match is zero-sum between the two sides", () => {
  const winnerGain = updateRating(1300, 1100, 1) - 1300;
  const loserLoss = 1100 - updateRating(1100, 1300, 0);
  assert.ok(near(winnerGain, loserLoss, 1e-9), `${winnerGain} vs ${loserLoss}`);
});

check("ratings stay finite at extreme gaps", () => {
  assert.ok(Number.isFinite(updateRating(3000, 100, 1)));
  assert.ok(Number.isFinite(updateRating(100, 3000, 0)));
});

console.log("meanRating");

check("averages a roster", () => {
  assert.ok(near(meanRating([1100, 1300]), 1200));
});

check("an empty roster falls back to the default rather than NaN", () => {
  // A NaN here would silently poison every rating in the event.
  assert.strictEqual(meanRating([]), 1200);
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
