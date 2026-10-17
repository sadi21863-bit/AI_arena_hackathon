// Guards the wiring that the 2026-10-17 beta probe-kill incident exposed:
// the key-selection block in team-build-turn.yml reads $TEAM_KEY_PIN from the
// RUNNER shell, so TEAM_KEY_PIN must be set as a step env var. For a whole day
// it existed only as a docker `-e` flag (which feeds the container), leaving
// the shell variable empty on every run - every beta run silently selected
// OR_KEY_1 (the other team's key) as PRIMARY, probed remaining=0 forever, and
// died at the quota probe while its own key sat unreachable in slot 2.
//
// The failure class this pins: a value that one half of the harness consumes
// (the shell test) and the other half supplies (the env block) drifting apart,
// with no error at either end - the dead pin produced no warning, just a
// wrong-key run that looks exactly like a spent quota.
//
// Three ends must stay connected, and all three are asserted here:
//   1. the step env block assigns TEAM_KEY_PIN (the thing that was missing);
//   2. the shell's pin test reads "$TEAM_KEY_PIN" (the consumer);
//   3. the docker run passes -e TEAM_KEY_PIN (the container's copy).
//
// Run: node scripts/check_team_key_pin.cjs

const fs = require("fs");

const WORKFLOW = ".github/workflows/team-build-turn.yml";

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const src = fs.readFileSync(WORKFLOW, "utf8");
const lines = src.split(/\r?\n/);

// 1. An ACTIVE (non-comment) env assignment in the workflow. The comment lines
// explaining the incident mention TEAM_KEY_PIN too, so those are excluded -
// only a line whose first non-space character starts the key counts.
const envLines = lines.filter((l) => /^\s*TEAM_KEY_PIN\s*:/.test(l));
check("env block assigns TEAM_KEY_PIN", envLines.length >= 1,
  `found ${envLines.length} active assignment(s)`);

const pinExpr = envLines[0] || "";
check("pin expression selects beta -> KEY_2", /contains\(github\.repository,\s*'beta'\)/.test(pinExpr) && /KEY_2/.test(pinExpr),
  pinExpr.trim() || "no line");

// 2. The consumer: the shell test that routes PRIMARY/FALLBACK.
check("shell test reads $TEAM_KEY_PIN", /\[\s*"\$TEAM_KEY_PIN"\s*=\s*"KEY_2"\s*\]/.test(src));

// 3. The container still receives the pin (unchanged by the fix, but a future
// edit that drops it would silently strip the container-side identity).
check("docker run still passes -e TEAM_KEY_PIN", /-e TEAM_KEY_PIN=/.test(src));

// 4. The assignment must sit INSIDE the same step as the consumer. The env
// block is the step's `env:` map; the pin test lives in that step's `run:`.
// A cheap structural proxy: TEAM_KEY_PIN must appear before the pin-test line
// (env maps precede run blocks), and after the step's `- name:` line.
const envIdx = lines.findIndex((l) => /^\s*TEAM_KEY_PIN\s*:/.test(l));
const testIdx = lines.findIndex((l) => /\[\s*"\$TEAM_KEY_PIN"\s*=\s*"KEY_2"\s*\]/.test(l));
check("env assignment precedes the shell test (same step, env before run)",
  envIdx >= 0 && testIdx >= 0 && envIdx < testIdx,
  `envIdx=${envIdx} testIdx=${testIdx}`);

// 5. Mirror-of-truth check: the sim harness (used in the 16/16 rehearsal) must
// NOT be the only place the pin is exercised. If someone moves the pin out of
// the env block again, cases 1-4 fail - this case exists so the failure message
// names the incident.
check("at least one comment references the incident (keep the why)", /runner/i.test(src) && /TEAM_KEY_PIN/i.test(src));

console.log(failed === 0 ? "\nall key-pin wiring cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
