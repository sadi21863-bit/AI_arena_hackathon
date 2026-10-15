// Structural checks on the provider-access failure guard in
// team-build-turn.yml (added 2026-10-11, corrected 2026-10-13).
//
// The failure it fixes: event_41cbabb7 burned 19 turns where the agent never
// ran, and the harness reported each as "the agent emitted text without writing
// any files". So the guard has to (a) exist, (b) exit before the misleading
// message, and (c) match the real rejection text.
//
// CORRECTION 2026-10-13: the original guard printed "CREDENTIAL FAILURE ...
// until the pool keys are replaced". That advice was WRONG and cost real time.
// The keys were never expired — they authenticate (/models returns 200). The
// free tier rejects headless clients with 403 FreeTierError, and the "401
// Invalid credential" string is an upstream wrapper around that. The guard is
// now "PROVIDER ACCESS FAILURE" and explicitly tells the operator not to rotate
// a working key. The check below locks that in: re-introducing rotate-your-keys
// advice now fails the test instead of quietly misleading the next operator.

import { readFileSync } from "node:fs";

const y = readFileSync(".github/workflows/team-build-turn.yml", "utf8");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`PASS  ${label}`);
  else { failed++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const noFileGuard = y.indexOf('if [ -z "$CHANGED" ] && [ "$NOW_HEAD" = "$START_HEAD" ]; then');
check("the no-file-changes guard exists", noFileGuard > 0, "CHANGED guard not found");

const credIdx = y.indexOf("PROVIDER ACCESS FAILURE");
check("provider-access guard present", credIdx > 0, "PROVIDER ACCESS FAILURE message not found");
check("provider-access guard is INSIDE the no-file-changes branch",
  credIdx > noFileGuard, `guard at ${credIdx}, no-file guard at ${noFileGuard}`);

// Must exit BEFORE the misleading generic message, or it changes nothing.
const genericIdx = y.indexOf("the agent emitted text without writing any files");
check("generic 'emitted text' message still present (fallback)", genericIdx > 0);
check("provider-access guard EXITS before the generic message",
  credIdx < genericIdx && /PROVIDER ACCESS FAILURE[\s\S]{0,900}exit 1/.test(y.slice(credIdx - 200, credIdx + 900)),
  "guard must exit 1 before the misleading echo");

// REGRESSION LOCK: the corrected diagnosis must not decay back into
// "replace/rotate the keys", which is what sent event_41cbabb7's operator down
// the wrong path for a day.
//
// The "Do NOT rotate the keys" warning is stripped BEFORE this test, otherwise
// the check matches its own negation — a guard that says the opposite of the
// advice it forbids would pass here, which is worse than no check at all.
const guardBlock = y.slice(credIdx, credIdx + 900);
const withoutNegation = guardBlock.replace(/Do NOT rotate the keys/gi, "");
check("guard does NOT tell the operator to replace/rotate keys",
  !/keys are replaced|rotate the keys|replace the pool keys/i.test(withoutNegation),
  "rotate-your-keys advice is back in the guard");
check("guard DOES tell the operator not to rotate a working key",
  /Do NOT rotate the keys/i.test(guardBlock));

// The pattern must match what the provider actually returned -- including the
// 403 free-tier shapes, which are the real underlying rejection.
for (const sig of ["Invalid credential", "401 Unauthorized", '"statusCode":401', "FreeTierError", "FreeUsageLimitError"]) {
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