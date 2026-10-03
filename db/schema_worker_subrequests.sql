-- Worker subrequest accounting (2026-10-03).
--
-- Why: the `team_formation` subrequest overrun (incident §10 in
-- docs/INCIDENT_2026-09-23_HARNESS.md) was diagnosed from ARITHMETIC over the
-- code, not measurement — "156 per item against a cap of 50". That model drove
-- a real fix (78 -> 40 per team) but nothing confirmed it, and a wrong model
-- would mean the fix is wrong too. This table makes the next formation report
-- actual counts, so the claim stops being a model.
--
-- Cloudflare exposes no subrequest counter to the Worker, so this counts the
-- calls that ARE subrequests: GitHub API calls (every githubRequest is one
-- fetch), raw.githubusercontent fetches of harness/scaffold files, and D1
-- statements — all three draw on the same per-invocation budget.
--
-- Scope note: this counts what the arena issues, which is the overwhelming
-- majority of an invocation's subrequests. It cannot see subrequests made
-- inside Cloudflare's own internals, so treat the total as a floor-consistent
-- figure rather than an exact replica of the platform's own accounting.
CREATE TABLE IF NOT EXISTS worker_subrequest_log (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  github_calls INTEGER NOT NULL DEFAULT 0,
  main_repo_fetches INTEGER NOT NULL DEFAULT 0,
  db_statements INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL DEFAULT 50,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_worker_subrequest_log_event
  ON worker_subrequest_log (event_id, created_at);