// Structural checks on the credential-failure guard added to
// team-build-turn.yml (2026-10-11).
//
// The failure it fixes: event_41cbabb7 burned 19 turns on dead Zen keys, and the
// harness reported each as "the agent emitted text without writing any files".
// The agent never ran. So the guard has to (a) exist, (b) exit before the
// misleading message, and (c) match the real 401 text.

import { readFileSync } from "node:fs";

const y = readFileSync(".github/workflows/team-build-turn.yml", "utf8");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else { failed++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const noFileGuard = y.indexOf('if [ -z "$CHANGED" ] && [ "$NOW_HEAD" = "$START_HEAD" ]; then');
check("the no-file-changes guard exists", noFileGuard > 0, "CHANGED guard not found");

const credIdx = y.indexOf("CREDENTIAL FAILURE");
check("credential guard present", credIdx > 0, "CREDENTIAL FAILURE message not found");
check("credential guard is INSIDE the no-file-changes branch",
  credIdx > noFileGuard, `credential guard at ${credIdx}, no-file guard at ${noFileGuard}`);

// Must exit BEFORE the misleading generic message, or it changes nothing.
const genericIdx = y.indexOf("the agent emitted text without writing any files");
check("generic 'emitted text' message still present (fallback)", genericIdx > 0);
check("credential guard EXITS before the generic message",
  credIdx < genericIdx && /CREDENTIAL FAILURE[\s\S]{0,400}exit 1/.test(y.slice(credIdx - 200, credIdx + 400)),
  "guard must exit 1 before the misleading echo");

// The pattern must match the string the provider actually returned.
for (const sig of ["Invalid credential", "401 Unauthorized", '"statusCode":401']) {
  check(`pattern includes the real provider signature: ${sig}`, y.includes(sig));
}

// And it must also appear in the crash/provider signature line, so the
// operator-facing signature print is not empty on an auth failure.
const sigLineIdx = y.indexOf("crash/provider-error signature");
check("auth patterns are in the provider-signature print too",
  y.indexOf("Invalid credential", sigLineIdx) > sigLineIdx,
  "the signature grep still prints EMPTY on a 401");

// Guard against an unbalanced shell construct.
const opens = (y.match(/if \[ -z "\$CHANGED" \]/g) || []).length;
check("exactly one CHANGED guard (not duplicated by a bad edit)", opens === 1, `found ${opens}`);

console.log(failed === 0 ? "\nall credential-guard cases passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);