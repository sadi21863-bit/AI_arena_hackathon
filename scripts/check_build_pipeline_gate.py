#!/usr/bin/env python3
"""
Loop gate: build_pipeline (spec §8, §17).

Unlike the other gates, this one doesn't read a local results file — it asks
GitHub directly for the status of the most recent run of
.github/workflows/team-build-turn.yml, since that's the actual source of
truth for "did the build-turn pattern work end to end."

Usage:
    export GITHUB_TOKEN=...        # needs actions:read on the repo
    export GITHUB_REPO=owner/repo
    python3 scripts/check_build_pipeline_gate.py

Run this AFTER manually triggering the workflow at least once (via the GitHub
UI's "Run workflow" button, or `gh workflow run team-build-turn.yml`) — this
script only checks the result, it doesn't trigger the run itself.
"""

import json
import os
import sys
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
STATE_PATH = ROOT / ".arena" / "state.json"
WORKFLOW_FILE = "team-build-turn.yml"


def load_state():
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save_state(state):
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def github_get(url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def main():
    state = load_state()
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPO")

    if not token or not repo:
        print("Set GITHUB_TOKEN and GITHUB_REPO (owner/repo) first.")
        state["gates"]["build_pipeline"]["status"] = "not_run"
        save_state(state)
        sys.exit(1)

    try:
        runs_url = f"https://api.github.com/repos/{repo}/actions/workflows/{WORKFLOW_FILE}/runs?per_page=1"
        data = github_get(runs_url, token)
    except Exception as e:
        print(f"GitHub API call failed: {e}")
        state["gates"]["build_pipeline"]["status"] = "fail"
        state["gates"]["build_pipeline"]["details"] = {"error": str(e)}
        save_state(state)
        sys.exit(1)

    runs = data.get("workflow_runs", [])
    if not runs:
        print(
            f"No runs found for {WORKFLOW_FILE} yet. Trigger it manually first: "
            f"gh workflow run {WORKFLOW_FILE} -f team=alpha -f turn_id=spike-001"
        )
        state["gates"]["build_pipeline"]["status"] = "not_run"
        save_state(state)
        sys.exit(1)

    latest = runs[0]
    passed = latest.get("status") == "completed" and latest.get("conclusion") == "success"

    details = {
        "run_id": latest.get("id"),
        "status": latest.get("status"),
        "conclusion": latest.get("conclusion"),
        "html_url": latest.get("html_url"),
        "run_started_at": latest.get("run_started_at"),
    }

    state["gates"]["build_pipeline"]["status"] = "pass" if passed else "fail"
    state["gates"]["build_pipeline"]["checked_at"] = datetime.now(timezone.utc).isoformat()
    state["gates"]["build_pipeline"]["details"] = details

    if passed and state.get("current_gate") == "build_pipeline":
        state["current_gate"] = "week1_cloudflare_foundation"
        state["gates"]["week1_cloudflare_foundation"]["status"] = "ready"

    save_state(state)

    print(f"build_pipeline: {'PASS' if passed else 'FAIL'}")
    print(json.dumps(details, indent=2))
    if not passed:
        print(f"\nCheck the run directly: {details.get('html_url')}")
        print(
            "Common first-run failures: git push step failing due to branch protection "
            "rules on the default branch (use a bot-writable branch or a PAT with bypass "
            "permission), or docker/Dockerfile.arena-team-base failing to build (check the "
            "job log's 'Build team base image' step for the actual Docker error)."
        )
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
