#!/usr/bin/env python3
"""Gate bookkeeping for `agent_power` (owner decision D3, 2026-11-27).

The decision is a document, not a measurement: single-turn stays the default,
team-turn stays opt-in via the `[team]` marker, and the comparison moves to a
separate experiment. This script refuses to write `.arena/state.json` unless
both the spec and CHANGELOG contain that decision. It replaces only the
`agent_power` gate block, preserving every other byte of the file.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "docs" / "SPEC_AGENT_EMPOWERMENT_2026-08-11.md"
CHANGELOG = ROOT / "CHANGELOG.md"
STATE = ROOT / ".arena" / "state.json"

REQUIRED_SPEC = [
    "single-turn is the default",
    "team-turn stays opt-in",
    "team_vs_single_experiment",
    "not measurable with sufficient confidence",
    "neither arm is claimed passed or failed",
]
REQUIRED_CHANGELOG = [
    "`agent_power` decision recorded (D3)",
    "team_vs_single_experiment",
]
START = '    "agent_power": {'


def render_gate(gate: dict) -> str:
    rendered = json.dumps(gate, indent=2, ensure_ascii=False).splitlines()
    return '    "agent_power": ' + rendered[0] + "\n" + "\n".join("    " + line for line in rendered[1:])


def main() -> int:
    spec = SPEC.read_text(encoding="utf-8")
    changelog = CHANGELOG.read_text(encoding="utf-8")
    raw = STATE.read_text(encoding="utf-8")

    missing = [p for p in REQUIRED_SPEC if p.lower() not in spec.lower()]
    missing += [p for p in REQUIRED_CHANGELOG if p.lower() not in changelog.lower()]
    if missing:
        print("REFUSED: decision text missing: " + "; ".join(missing))
        return 1

    original = json.loads(raw)
    if "agent_power" not in original.get("gates", {}):
        print("REFUSED: no agent_power gate in state.json")
        return 1

    start = raw.find(START)
    if start < 0:
        print("REFUSED: agent_power block not found as expected")
        return 1
    # agent_power is the last gate; its closing brace is followed by the
    # closing braces of "gates" and the root object.
    tail = "\n    }\n  }\n}"
    end = raw.find(tail, start)
    if end < 0:
        print("REFUSED: agent_power block end not found as expected")
        return 1
    end += len("\n    }")

    gate = dict(original["gates"]["agent_power"])
    gate["status"] = "pass"
    gate["checked_at"] = datetime.now(timezone.utc).isoformat()
    detail = gate.get("details", {})
    gate["details"] = {
        "definition": detail.get("definition", ""),
        "decision": "single-turn default; team-turn opt-in via the [team] marker",
        "reason": "comparison not currently measurable with sufficient confidence (last cycle had 0 successful turns)",
        "pending": ["team_vs_single_experiment"],
        "resolved": detail.get("resolved", []),
        "context": detail.get("context", ""),
    }

    expected = raw[:start] + render_gate(gate) + raw[end:]
    parsed = json.loads(expected)
    other_original = {k: v for k, v in original["gates"].items() if k != "agent_power"}
    other_expected = {k: v for k, v in parsed["gates"].items() if k != "agent_power"}
    if other_original != other_expected or original.get("current_gate") != parsed.get("current_gate"):
        print("REFUSED: script would change more than the agent_power gate")
        return 1

    STATE.write_text(expected, encoding="utf-8")
    print("agent_power gate recorded as pass (decision only; experiment pending)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
