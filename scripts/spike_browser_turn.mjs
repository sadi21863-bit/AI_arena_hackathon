// Dispatches the agent_power live spike turn and checks its evidence.
//
// Why this exists: docs/SPEC_AGENT_EMPOWERMENT_2026-08-11.md ships Playwright
// MCP + chromium + the ui-verify skill, but its "NOT yet verified" list needs
// real infra: the Docker image build and a live turn whose opencode-turn.log
// shows browser_navigate / browser_snapshot and none of the P0-0a crash
// signatures. Docker is unavailable on the dev machine, so the only honest
// proof is a dispatched turn.
//
// This wraps the spec's own runbook (SPEC §4 "Spike run") and adds what the
// spec's command cannot do by itself: sync the harness first (a manual
// dispatch otherwise runs whatever stale workflow the team repo has - the
// first OpenRouter verification attempt burned 120 minutes proving that),
// poll the run, download the log artifact, and grep for the evidence.
//
// Target repo is alpha's from terminal event_41cbabb7: the event is complete,
// so burning a turn there cannot affect a live product.
//
// Quota: build turns draw on the 50 req/day/key OpenRouter pool. Do NOT run
// this while a hackathon is building - those turns own the pool. The ideathon
// days between events are the free window (no build turns are dispatched).
//
// Usage:
//   node scripts/spike_browser_turn.mjs [--turn-id spike-ui-002] [--dry-run]
//   node scripts/spike_browser_turn.mjs --run <runId>     # evidence check only
//
// Exit codes: 0 evidence PASS, 1 evidence FAIL, 2 setup/API error,
//             3 artifact unavailable, 4 quota-killed before browser evidence.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = "AI-arena-hackathon/arena-team-alpha-d28b420c";
const WORKFLOW = "team-build-turn.yml";
const MODEL = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";

// Verbatim from SPEC_AGENT_EMPOWERMENT_2026-08-11.md §4 "Spike run".
const SPIKE_PROMPT =
  "Build a tiny single-page web app with one interactive button, add a test, " +
  "and verify the page in the browser.";

const dotenv = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Za-z_][A-Za-z_0-9]*\s*=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const token = dotenv.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN missing from .env - cannot dispatch.");
  process.exit(2);
}

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const runOnly = getArg("--run");
const turnId = getArg("--turn-id") || "spike-ui-002";

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

const api = async (method, p, body) => {
  const res = await fetch(`https://api.github.com${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const syncHarness = () => {
  console.log(`  syncing harness into ${REPO}`);
  const r = spawnSync(process.execPath, ["scripts/sync_team_harness.mjs", REPO], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("  harness sync failed - aborting (a stale workflow would prove nothing)");
    process.exit(2);
  }
};

const dispatch = async () => {
  await api("POST", `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    ref: "main",
    inputs: { team: "alpha", turn_id: turnId, task_prompt: SPIKE_PROMPT, model: MODEL },
  });
  console.log(`  dispatched turn_id=${turnId} model=${MODEL}`);
  console.log(`  prompt: "${SPIKE_PROMPT}"`);

  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const runs = await api("GET", `/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=20`);
    const run = (runs.workflow_runs || []).find((r) => (r.display_title || "").includes(turnId));
    if (run) return run;
  }
  console.error("  dispatched, but no run appeared within 3 minutes - check the repo's Actions tab");
  process.exit(2);
};

const poll = async (run) => {
  let last = null;
  const started = Date.now();
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const cur = await api("GET", `/repos/${REPO}/actions/runs/${run.id}`);
    const stamp = `${cur.status}/${cur.conclusion}`;
    if (stamp !== last) {
      console.log(`  [${((Date.now() - started) / 60_000).toFixed(1)}m] ${stamp}  ${cur.html_url}`);
      last = stamp;
      if (cur.status === "completed") {
        const jobs = await api("GET", `/repos/${REPO}/actions/runs/${run.id}/jobs`);
        for (const j of jobs.jobs || []) {
          console.log(`      job ${j.name}: ${j.conclusion}`);
          for (const s of j.steps || []) {
            if (s.conclusion && s.conclusion !== "success") {
              console.log(`        step ${s.number} ${s.name}: ${s.conclusion}`);
            }
          }
        }
        return cur;
      }
    }
    await sleep(20_000);
  }
  console.error("  run still not complete after 45m - check it manually");
  process.exit(2);
};

const downloadLogs = (runId) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arena-spike-${turnId}-`));
  const r = spawnSync(
    "gh",
    ["run", "download", String(runId), "-R", REPO, "-n", `build-turn-${turnId}`, "-D", dir],
    { stdio: "inherit", env: { ...process.env, GH_TOKEN: token } },
  );
  if (r.status !== 0) {
    console.error(`  artifact download failed - fetch it manually: gh run download ${runId} -R ${REPO} -n build-turn-${turnId}`);
    return null;
  }
  return dir;
};

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};

const analyse = (dir) => {
  const files = walk(dir).filter((f) => f.endsWith(".log"));
  const logs = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const count = (re) => (logs.match(re) || []).length;
  const evidence = {
    files: files.map((f) => path.basename(f)),
    browser_navigate: count(/browser_navigate/g),
    browser_snapshot: count(/browser_snapshot/g),
    browser_take_screenshot: count(/browser_take_screenshot/g),
    crash_signatures: count(/expected 'id'|InvalidResponseData/g),
    quota_signatures: count(/FreeUsageLimitError|free-models-per-day|free_model_daily|429 Too Many/g),
  };
  return evidence;
};

const main = async () => {
  let run;
  if (runOnly) {
    run = await api("GET", `/repos/${REPO}/actions/runs/${runOnly}`);
    console.log(`  checking existing run ${run.id} (${run.display_title})`);
  } else if (dryRun) {
    console.log(`  dry run - would sync ${REPO}, then dispatch:`);
    console.log(`    turn_id: ${turnId}`);
    console.log(`    model:   ${MODEL}`);
    console.log(`    prompt:  "${SPIKE_PROMPT}"`);
    return;
  } else {
    syncHarness();
    run = await dispatch();
    run = await poll(run);
  }

  if (run.status !== "completed") {
    console.error(`  run is ${run.status}, not completed - wait, then rerun with --run ${run.id}`);
    process.exit(2);
  }

  const dir = downloadLogs(run.id);
  if (!dir) process.exit(3);

  const evidence = analyse(dir);
  console.log(`  artifacts: ${dir}`);
  console.log(`  evidence: ${JSON.stringify(evidence, null, 2)}`);

  if (evidence.crash_signatures > 0) {
    console.error("  FAIL: P0-0a crash signature present in the turn log");
    process.exit(1);
  }
  if (evidence.browser_navigate > 0 && evidence.browser_snapshot > 0) {
    console.log("  PASS: the live turn exercised the Playwright browser (navigate + snapshot)");
    process.exit(0);
  }
  if (evidence.quota_signatures > 0) {
    console.error("  INCOMPLETE: quota signature before browser evidence - rerun after UTC midnight");
    process.exit(4);
  }
  console.error("  FAIL: no browser_navigate/browser_snapshot evidence in the turn log");
  process.exit(1);
};

main().catch((err) => {
  console.error(`  error: ${err.message}`);
  process.exit(2);
});
