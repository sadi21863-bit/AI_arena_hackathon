#!/usr/bin/env node
/**
 * Tests for N-3's position-bias control (src/judges/runoff.ts combineVerdicts).
 *
 * The runoff's whole claim to being trustworthy is that a verdict only counts
 * when it survives an ordering flip. "We ran it twice" proves nothing if the
 * combining rule quietly accepts one ordering's answer, and that failure would
 * be invisible in production — it would just look like a confident promotion.
 *
 * combineVerdicts is pure, but lives in a .ts file the Worker build consumes,
 * so this re-implements nothing: it strips the types and evaluates the real
 * function body rather than a copy that could drift from it.
 *
 *   node scripts/test_runoff.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "judges", "runoff.ts"), "utf8");

// Pull out combineVerdicts and drop its TypeScript annotations. If the
// function is renamed or restructured this throws rather than silently
// testing nothing.
const match = source.match(/export function combineVerdicts\(([\s\S]*?)\n\}/);
assert.ok(match, "combineVerdicts not found in runoff.ts — test is out of date with the source");

const body = ("function combineVerdicts(" + match[1] + "\n}")
  .replace(/:\s*string \| null/g, "")
  .replace(/:\s*string/g, "")
  .replace(/\)\s*:\s*RunoffVerdict/, ")");

const context = { module: {} };
vm.createContext(context);
vm.runInContext(body + "\nmodule.exports = combineVerdicts;", context);
const combineVerdicts = context.module.exports;

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

console.log("combineVerdicts — a verdict must survive the ordering flip");

check("both orderings pick entry A -> a", () => {
  assert.strictEqual(combineVerdicts("idea_a", "idea_a", "idea_a"), "a");
});

check("both orderings pick entry B -> b", () => {
  assert.strictEqual(combineVerdicts("idea_b", "idea_b", "idea_a"), "b");
});

check("disagreement is inconclusive, NOT a win for the first ordering", () => {
  // The exact shape of position bias: the judge picked whichever entry was
  // shown first, both times. Accepting either answer here would make the
  // runoff worse than no runoff.
  assert.strictEqual(combineVerdicts("idea_a", "idea_b", "idea_a"), "inconclusive");
});

check("reverse-ordering disagreement is also inconclusive", () => {
  assert.strictEqual(combineVerdicts("idea_b", "idea_a", "idea_a"), "inconclusive");
});

check("a missing forward verdict is inconclusive", () => {
  assert.strictEqual(combineVerdicts(null, "idea_a", "idea_a"), "inconclusive");
});

check("a missing reverse verdict is inconclusive", () => {
  assert.strictEqual(combineVerdicts("idea_a", null, "idea_a"), "inconclusive");
});

check("both missing is inconclusive", () => {
  assert.strictEqual(combineVerdicts(null, null, "idea_a"), "inconclusive");
});

check("a consistent win for an id that is neither a nor the flip still resolves to b", () => {
  // Defensive: compareOnce only ever returns one of the two entry ids, but the
  // rule must not accidentally report "a" for anything that isn't a.
  assert.strictEqual(combineVerdicts("idea_other", "idea_other", "idea_a"), "b");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
