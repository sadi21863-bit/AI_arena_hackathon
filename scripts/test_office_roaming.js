#!/usr/bin/env node
/**
 * Tests P6's idle-roaming rules (public/js/views/office.js).
 *
 * The rule that matters is who is NOT allowed to wander. An abandoned agent is
 * greyed out because the scheduler gave up on it; a character that strolls
 * around looks content, which would quietly undo P1's whole point. That is a
 * correctness property wearing a cosmetic disguise, and it is invisible in a
 * screenshot.
 *
 * Verified here because the preview pane reports
 * `prefers-reduced-motion: reduce`, under which roaming is deliberately
 * skipped entirely — so the enabled path cannot be exercised in that browser.
 * (The disabled path WAS confirmed live: no pet, no drift.)
 *
 *   node scripts/test_office_roaming.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "views", "office.js"), "utf8");

/* --- canRoam, lifted from source so it cannot drift --------------------- */
const canRoamSrc = SRC.match(/function canRoam\(agent\) \{[\s\S]*?\n  \}/);
assert.ok(canRoamSrc, "canRoam not found in office.js — test is out of date with the source");

const ctx = {
  // canRoam calls taskInfo; a task_type of null/unknown means "no real task".
  taskInfo: (t) => (t ? { zone: "x" } : null),
  module: {},
};
vm.createContext(ctx);
vm.runInContext(canRoamSrc[0].replace(/^\s*function/, "function") + "\nmodule.exports = canRoam;", ctx);
const canRoam = ctx.module.exports;

/* --- the landmark classes a set's props are filtered by ----------------- */
const landmarkLine = SRC.match(/\["couch",[^\]]*\]/);
assert.ok(landmarkLine, "loiter landmark list not found in office.js");
const LANDMARKS = JSON.parse(landmarkLine[0].replace(/'/g, '"'));

/* --- every SET must offer somewhere to loiter --------------------------- */
const setsBlock = SRC.match(/const SETS = \{[\s\S]*?\n\};/);
assert.ok(setsBlock, "SETS not found in office.js");
const setsCtx = { module: {} };
vm.createContext(setsCtx);
vm.runInContext(setsBlock[0] + "\nmodule.exports = SETS;", setsCtx);
const SETS = setsCtx.module.exports;

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

console.log("who may wander");

check("a plainly idle agent may roam", () => {
  assert.strictEqual(canRoam({ task_type: null, abandoned: false, failed_attempts: 0 }), true);
});

check("an agent with a real task stays at the task", () => {
  assert.strictEqual(canRoam({ task_type: "critique", abandoned: false, failed_attempts: 0 }), false);
});

check("an ABANDONED agent never wanders — it would look content", () => {
  // The P1 regression this guards: a greyed-out, given-up-on agent strolling
  // between the couch and the cooler reads as fine.
  assert.strictEqual(canRoam({ task_type: null, abandoned: true, failed_attempts: 6 }), false);
});

check("an abandoned agent stays put even with no failure count recorded", () => {
  assert.strictEqual(canRoam({ task_type: null, abandoned: true, failed_attempts: 0 }), false);
});

check("a struggling agent stays put — a wandering warning reads as careless", () => {
  assert.strictEqual(canRoam({ task_type: null, abandoned: false, failed_attempts: 2 }), false);
});

check("missing failure fields are treated as no failures", () => {
  assert.strictEqual(canRoam({ task_type: null }), true);
});

console.log("\nevery set can host loitering");

for (const [id, set] of Object.entries(SETS)) {
  check(`${id} has at least one loiter landmark`, () => {
    const spots = (set.props || []).filter((p) => LANDMARKS.includes(p.cls));
    assert.ok(spots.length > 0, `${id} has no ${LANDMARKS.join("/")} prop to loiter at`);
  });
}

check("loiter spots stay inside the room once offset below the prop", () => {
  for (const [id, set] of Object.entries(SETS)) {
    for (const p of (set.props || []).filter((x) => LANDMARKS.includes(x.cls))) {
      const y = Math.min(92, p.y + 7);
      assert.ok(y <= 92 && y >= 0, `${id}: spot at y=${y} is outside the room`);
    }
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
