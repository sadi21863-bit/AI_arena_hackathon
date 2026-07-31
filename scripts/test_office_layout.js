#!/usr/bin/env node
/**
 * Tests the Agent Office's density maths (public/js/views/office.js).
 *
 * The bug this guards: a fixed 64px character placed on a percentage grid, so
 * an 11% row pitch was 63px in a 573px room and neighbours overlapped. The fix
 * derives BOTH the character size and the row pitch from the measured room, so
 * the gap stays proportional at every width.
 *
 * Verified here rather than in a browser because the invariant is arithmetic —
 * and because the preview pane could not be trusted to report layout (its
 * requestAnimationFrame was suspended and inline styles were not re-resolving,
 * so rendered measurements were stale). The DOM wiring is reviewed separately;
 * this pins the geometry.
 *
 *   node scripts/test_office_layout.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "views", "office.js"), "utf8");

// Pull the real constants out of the source so this cannot drift from it.
const num = (re, label) => {
  const m = SRC.match(re);
  assert.ok(m, `${label} not found in office.js — test is out of date with the source`);
  return parseFloat(m[1]);
};
const CHAR_RATIO = num(/room\.width \* ([\d.]+)\)\)\)/, "character/room ratio");
const CHAR_MIN = num(/Math\.max\((\d+), Math\.min\(64/, "character floor");
const CHAR_MAX = num(/Math\.min\((\d+), room\.width/, "character ceiling");
const COL_MULT = num(/charW \* ([\d.]+) \/ room\.width/, "column pitch multiplier");
const ROW_MULT = num(/charH \* ([\d.]+) \/ room\.height/, "row pitch multiplier");

/** Mirrors draw()'s sizing + spacing, in the same order. */
function layout(roomW, roomH, groupSize) {
  const charPx = Math.round(Math.max(CHAR_MIN, Math.min(CHAR_MAX, roomW * CHAR_RATIO)));
  const colPitchPct = (charPx * COL_MULT / roomW) * 100;
  const rowPitchPct = (charPx * ROW_MULT / roomH) * 100;
  const padX = (charPx / 2 / roomW) * 100 + 1;
  const fitPerRow = Math.max(1, Math.floor((100 - 2 * padX) / colPitchPct));
  const perRow = Math.max(1, Math.min(4, groupSize, fitPerRow));
  return {
    charPx, colPitchPct, rowPitchPct, padX, perRow,
    colPitchPx: (colPitchPct / 100) * roomW,
    rowWidthPx: (perRow - 1) * (colPitchPct / 100) * roomW + charPx,
  };
}

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

// Real widths: phone, small tablet, the 573px case that was measured
// overlapping, laptop, desktop, and an ultrawide column.
const WIDTHS = [335, 420, 573, 701, 780, 900, 1116, 1400];

console.log(`constants read from source: ratio=${CHAR_RATIO} min=${CHAR_MIN} max=${CHAR_MAX} col=${COL_MULT} row=${ROW_MULT}`);
console.log("\ncharacters never overlap horizontally");

for (const w of WIDTHS) {
  check(`room ${w}px — pitch exceeds character`, () => {
    const L = layout(w, Math.max(440, w * 9 / 16), 12);
    assert.ok(
      L.colPitchPx > L.charPx,
      `pitch ${L.colPitchPx.toFixed(1)}px must exceed character ${L.charPx}px`
    );
  });
}

check("the specific 573px case that was measured overlapping now clears", () => {
  const L = layout(573, 440, 12);
  // Before: 11% pitch = 63px against a 64px character -> overlap.
  const oldPitch = 0.11 * 573;
  assert.ok(oldPitch < 64, `sanity: the old pitch really was too small (${oldPitch.toFixed(1)}px)`);
  assert.ok(L.colPitchPx > L.charPx, `now ${L.colPitchPx.toFixed(1)}px pitch vs ${L.charPx}px character`);
});

console.log("\ncharacter size stays in range");

check("never below the floor, even at an absurdly narrow room", () => {
  assert.strictEqual(layout(200, 440, 12).charPx, CHAR_MIN);
});

check("never above the ceiling, even on an ultrawide", () => {
  assert.strictEqual(layout(3000, 900, 12).charPx, CHAR_MAX);
});

check("desktop keeps the original 64px look", () => {
  assert.strictEqual(layout(1116, 628, 12).charPx, 64);
});

console.log("\nrows fit inside the walls");

for (const w of WIDTHS) {
  check(`room ${w}px — a full row fits within the usable width`, () => {
    const L = layout(w, Math.max(440, w * 9 / 16), 12);
    const usablePx = w * (100 - 2 * L.padX) / 100;
    assert.ok(
      L.rowWidthPx <= usablePx + 1,
      `row ${L.rowWidthPx.toFixed(1)}px must fit usable ${usablePx.toFixed(1)}px (perRow=${L.perRow})`
    );
  });
}

check("a phone-width room still fits 4 per row, because characters shrink", () => {
  // This was originally asserted the other way round, expecting narrow rooms
  // to always drop to fewer per row. They don't need to: at 335px the
  // character hits its 36px floor, so a 4-wide row is ~182px inside a ~268px
  // usable width. Shrinking the character is the mechanism; narrowing the row
  // is only the fallback for when that is not enough.
  const L = layout(335, 447, 12);
  assert.strictEqual(L.charPx, CHAR_MIN, "should be at the character floor");
  assert.strictEqual(L.perRow, 4, `4 per row should still fit (row ${L.rowWidthPx.toFixed(0)}px)`);
});

check("the row-narrowing fallback engages when the room is genuinely too tight", () => {
  const L = layout(200, 440, 12);
  assert.ok(L.perRow < 4, `perRow should drop below 4 at 200px, got ${L.perRow}`);
  assert.ok(L.perRow >= 1, "must always place at least one per row");
});

check("gap scales with the character rather than being fixed", () => {
  const a = layout(1116, 628, 12), b = layout(573, 440, 12);
  const ratioA = a.colPitchPx / a.charPx, ratioB = b.colPitchPx / b.charPx;
  assert.ok(Math.abs(ratioA - ratioB) < 0.01, `pitch:character ratio must be constant (${ratioA.toFixed(3)} vs ${ratioB.toFixed(3)})`);
});

console.log("\nvertical spacing");

check("row pitch exceeds character height so labels have room", () => {
  const L = layout(1116, 628, 12);
  assert.ok((L.rowPitchPct / 100) * 628 > L.charPx, "rows must be further apart than a character is tall");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
