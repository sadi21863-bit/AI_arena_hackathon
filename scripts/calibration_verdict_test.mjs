// Calibration-failure rendering test — 2026-09-29.
//
// Why this exists: the Live view hardcoded "below the 0.6 threshold" for every
// calibration failure. The first live failure was an OVER-correlation
// (0.959 > the 0.95 ceiling), so readers were told the judges disagreed when
// they had agreed too closely — pointing an operator at the wrong remedy for
// the one signal that had never fired before.
//
// This exercises the real fmt.js implementation against both failure sides,
// both boundaries, the live value, and a pre-band payload from an older API.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { calibrationVerdict, score } from "../public/js/core/fmt.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Read the bounds from the server module rather than importing it — it pulls in
// Cloudflare types and can't be loaded by bare Node. Parsing the two exported
// constants still means this test fails if the server's band ever drifts.
const src = readFileSync(join(root, "src/judges/calibration.ts"), "utf8");
const min = Number(src.match(/CALIBRATION_MIN\s*=\s*([\d.]+)/)?.[1]);
const max = Number(src.match(/CALIBRATION_MAX\s*=\s*([\d.]+)/)?.[1]);
if (!Number.isFinite(min) || !Number.isFinite(max)) {
  console.log("FAIL  could not read CALIBRATION_MIN/CALIBRATION_MAX from src/judges/calibration.ts");
  process.exit(1);
}
const CALIBRATION_MIN = min;
const CALIBRATION_MAX = max;
const calibrationFailureSide = (c) =>
  c < CALIBRATION_MIN ? "low" : c > CALIBRATION_MAX ? "high" : null;

console.log(`band from source: ${CALIBRATION_MIN}–${CALIBRATION_MAX}\n`);

const cases = [
  { label: "live event d9d7a33f (0.959)", c: 0.9590826633241769, passed: 0, expect: /above the 0.95 ceiling/ },
  { label: "low side (0.42)", c: 0.42, passed: 0, expect: /below the 0.6 floor/ },
  { label: "in-band pass (0.81)", c: 0.81, passed: 1, expect: /inside the 0.6–0.95 band/ },
  { label: "exact ceiling (0.95)", c: 0.95, passed: 1, expect: /inside/ },
  { label: "exact floor (0.6)", c: 0.6, passed: 1, expect: /inside/ },
  { label: "just over ceiling (0.951)", c: 0.951, passed: 0, expect: /ceiling/ },
  { label: "just under floor (0.599)", c: 0.599, passed: 0, expect: /floor/ },
];

let failed = 0;
for (const t of cases) {
  const cal = {
    correlation: t.c,
    passed: !!t.passed,
    failedSide: calibrationFailureSide(t.c),
    band: { min: CALIBRATION_MIN, max: CALIBRATION_MAX },
  };
  const out = calibrationVerdict(cal);
  const ok = t.expect.test(out);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${t.label.padEnd(28)} -> ${out}`);
}

// A payload from before `band`/`failedSide` existed must still be described
// correctly — the helper falls back rather than printing a wrong direction.
const legacy = calibrationVerdict({ correlation: 0.42, passed: false });
const legacyOk = /below the 0.6 floor/.test(legacy);
if (!legacyOk) failed++;
console.log(`${legacyOk ? "PASS" : "FAIL"}  ${"legacy payload, no band".padEnd(28)} -> ${legacy}`);

const missing = calibrationVerdict(null);
const missingOk = missing === "no calibration recorded";
if (!missingOk) failed++;
console.log(`${missingOk ? "PASS" : "FAIL"}  ${"no calibration".padEnd(28)} -> ${missing}`);

if (score(0.9590826633241769) !== "0.96") {
  failed++;
  console.log(`FAIL  score() formatting -> ${score(0.9590826633241769)} (expected 0.96)`);
} else {
  console.log(`PASS  score() formatting          -> ${score(0.9590826633241769)}`);
}

console.log(failed === 0 ? "\nall calibration-verdict cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
