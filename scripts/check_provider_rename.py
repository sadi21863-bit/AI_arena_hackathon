# Validates the build-turn workflow after the OpenRouter rename.
#
# Why this exists: the provider switch renamed env vars inside a 1000-line YAML
# whose shell block cannot be typechecked. A rename that leaves one reference
# dangling does NOT fail the build -- the turn runs and silently expands an empty
# string, which is exactly the failure that ate event_41cbabb7 (19 turns on an
# empty key). So the check is structural: every variable the container command
# expands must be passed in via -e.
#
# Run: python scripts/check_provider_rename.py

import re
import subprocess
import sys

import yaml

WF = ".github/workflows/team-build-turn.yml"

# Git Bash is not on PATH on this machine, so resolve it explicitly.
BASH = next((p for p in (
    r"C:/Program Files/Git/bin/bash.exe",
    r"C:/Program Files/Git/usr/bin/bash.exe",
) if __import__("os").path.exists(p)), None)

d = yaml.safe_load(open(WF, encoding="utf-8"))
print("  YAML parses: OK")

# --- bash syntax of every run block in the file -------------------------------
if BASH is None:
    print("  bash -n: SKIPPED (no Git Bash found)")
    bad = 0
else:
    bad = 0
    for jn, jb in d["jobs"].items():
        for s in jb.get("steps", []):
            if "run" not in s:
                continue
            p = r"C:/Users/aditya/AppData/Local/Temp/opencode/step_%s.sh" % s.get("id", jn)
            open(p, "w", newline="\n").write(s["run"])
            r = subprocess.run([BASH, "-n", p], capture_output=True, text=True)
            if r.returncode:
                bad += 1
                print("  bash -n FAIL: job %s step %s\n%s" % (jn, s.get("id"), r.stderr))
    print("  bash -n on all run blocks:", "OK" if not bad else "%d FAILED" % bad)

# --- container env resolution -------------------------------------------------
src = open(WF, encoding="utf-8").read()
inner = re.search(r"sh -c '(.+?)' _", src, re.S).group(1)
used = sorted(set(re.findall(r"\$([A-Z_][A-Z_0-9]*)", inner)))
passed = set(re.findall(r"-e ([A-Z_][A-Z_0-9]*)=", src))

print("  container command expands:", used)
print("  passed via -e            :", sorted(passed))
missing = [v for v in used if v not in passed]
print("  UNRESOLVED               :", missing if missing else "none - every var is passed")

print("\n  secret refs in workflow  :", sorted(set(re.findall(r"secrets\.([A-Z_0-9]+)", src))))

stale = re.findall(r"ZEN_KEY_|ZEN_ACTIVE_KEY|ZEN_MODEL", src)
print("  stale ZEN_* identifiers  :", stale if stale else "none")

if bad or missing or stale:
    print("\n  RESULT: FAIL")
    sys.exit(1)
print("\n  RESULT: PASS")