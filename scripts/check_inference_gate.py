#!/usr/bin/env python3
"""
Loop gate: inference_pool (spec §6, §17).

Reads week0-spike/inference_pool_results.json (written by
inference_pool_probe.js against real Groq / Workers AI accounts) and decides
pass/fail, then writes the result to .arena/state.json.

Pass condition: Groq — the primary tier (§6) — returned at least one
successful call for the judging-shaped and architecture-shaped prompts.
Workers AI is the fallback; its success isn't required to pass this gate, but
its status is recorded either way so an outage during the actual spike
doesn't get silently lost.
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
RESULTS_PATH = ROOT / "week0-spike" / "inference_pool_results.json"
STATE_PATH = ROOT / ".arena" / "state.json"

REQUIRED_TASKS_FOR_PASS = {"judging", "architecture"}


def load_state():
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save_state(state):
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def main():
    state = load_state()

    if not RESULTS_PATH.exists():
        print(f"No {RESULTS_PATH} yet — run `node week0-spike/inference_pool_probe.js` with real API keys first.")
        state["gates"]["inference_pool"]["status"] = "not_run"
        save_state(state)
        sys.exit(1)

    data = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    results = data.get("results", [])

    by_provider = {}
    for r in results:
        by_provider.setdefault(r["provider"], []).append(r)

    groq_ok_tasks = {r["task"] for r in by_provider.get("groq", []) if r.get("ok")}
    groq_passed = REQUIRED_TASKS_FOR_PASS.issubset(groq_ok_tasks)

    workers_ai_tested = "workers_ai" in by_provider
    workers_ai_any_ok = any(r.get("ok") for r in by_provider.get("workers_ai", []))

    details = {
        "groq_ok_tasks": sorted(groq_ok_tasks),
        "groq_required_tasks": sorted(REQUIRED_TASKS_FOR_PASS),
        "workers_ai_tested": workers_ai_tested,
        "workers_ai_any_ok": workers_ai_any_ok,
    }

    state["gates"]["inference_pool"]["status"] = "pass" if groq_passed else "fail"
    state["gates"]["inference_pool"]["checked_at"] = datetime.now(timezone.utc).isoformat()
    state["gates"]["inference_pool"]["details"] = details

    if groq_passed and state.get("current_gate") == "inference_pool":
        state["current_gate"] = "build_pipeline"

    save_state(state)

    print(f"inference_pool: {'PASS' if groq_passed else 'FAIL'}")
    print(json.dumps(details, indent=2))
    if not groq_passed:
        print(
            "\nGroq (the primary tier per spec §6) failed on judging and/or architecture prompts. "
            "Check the raw console output from inference_pool_probe.js for the actual error — likely "
            "an invalid key or a model ID that's changed since the spec was written (§5 models rotate; "
            "verify against console.groq.com/docs/models before assuming this is a real capacity problem)."
        )
    if workers_ai_tested and not workers_ai_any_ok:
        print(
            "\nNote: this gate only requires Groq to pass, but Workers AI (the fallback tier) failing "
            "during the spike is still worth investigating before Week 1 — see CLAUDE.md's standing "
            "rules on real vs. estimated budget numbers."
        )
    sys.exit(0 if groq_passed else 1)


if __name__ == "__main__":
    main()
