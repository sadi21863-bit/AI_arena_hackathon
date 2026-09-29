// Frozen replay bundle per completed arena (issue #5).
//
// Writes one static folder per event: <out>/<event_id>/<table>.json +
// manifest.json (exported_at, per-table row counts, source database).
// Runnable by hand — no Worker code, no new dependencies (drives the
// existing wrangler CLI, same credential path as every D1 read here).
//
// Usage:
//   node scripts/export_arena_bundle.js --event event_a988b3dd-... [--out ./bundles] [--force]
//
// Refuses events that are not `complete` unless --force is given (a bundle
// is a frozen record; exporting mid-flight freezes a moving target).
// Re-run any time: output is deterministic per database state, manifest
// records exactly when it was taken.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Table -> how to scope rows to one event. `event` row uses id match.
const TABLES = {
  event: { table: "archive_events", column: "id" },
  ideas: { table: "archive_ideas", column: "event_id" },
  interactions: { table: "archive_interactions", column: "event_id" },
  queue: { table: "event_queue", column: "event_id" },
  queue_journal: { table: "queue_journal", column: "event_id" },
  teams: { table: "hackathon_teams", column: "event_id" },
  team_members: { table: "hackathon_team_members", column: null }, // joined via teams below
  turns: { table: "build_turns", column: "event_id" },
  scores: { table: "judge_scores", column: "event_id" },
  calibration: { table: "calibration_runs", column: "event_id" },
  tribunal: { table: "tribunal_reflections", column: "event_id" },
  chronicle: { table: "event_chronicle", column: "event_id" },
  research: { table: "research_calls", column: "event_id" },
};

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[3] !== undefined) {
      out[m[1]] = m[3];
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[m[1]] = argv[++i];
    } else {
      out[m[1]] = true;
    }
  }
  return out;
}

// npx is not on PATH for spawned processes on Windows — resolve it next
// to the running node binary (npx.cmd ships alongside node.exe).
const NPX =
  process.platform === "win32" ? path.join(path.dirname(process.execPath), "npx.cmd") : "npx";

function query(sql) {
  // shell:true because npx is a .cmd shim on Windows (Node cannot spawn
  // .cmd directly — EINVAL). The only interpolated value anywhere is the
  // event id, allow-listed in main(), so no shell metacharacters can enter.
  const raw = execFileSync(
    `"${NPX}" --yes wrangler d1 execute arena-db --remote --command "${sql}" --json`,
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], shell: true }
  );
  const start = raw.indexOf("[");
  const parsed = JSON.parse(raw.slice(start));
  return parsed[0].results || [];
}

function main() {
  const { event, out = "./bundles", force } = args();
  if (!event || !/^[A-Za-z0-9_-]+$/.test(event)) {
    console.error("usage: node scripts/export_arena_bundle.js --event <id> [--out ./bundles] [--force]");
    process.exit(2);
  }
  const eventRows = query(`SELECT status, parent_event_id FROM archive_events WHERE id='${event}'`);
  if (eventRows.length === 0) {
    console.error(`unknown event ${event}`);
    process.exit(2);
  }
  if (eventRows[0].status !== "complete" && !force) {
    console.error(`event ${event} is '${eventRows[0].status}', not 'complete' — refusing (pass --force to export anyway)`);
    process.exit(1);
  }
  const dir = path.join(out, event);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { event_id: event, status: eventRows[0].status, exported_at: new Date().toISOString(), source: "arena-db (remote)", tables: {}, caveats: [] };

  // A failed calibration must survive into the frozen artifact as a caveat,
  // not just as a `passed: 0` row someone has to know to look for. Closes the
  // residual half of P2-7 (ARENA_BACKLOG.md:385): the soft-flag was already
  // surfaced in the Observatory, but the bundle is the durable published
  // result, and its "Done when" asks for a visible consequence where a reader
  // of the results would see it.
  //
  // The band is two-sided and the two sides mean opposite things, so the side
  // is named rather than flattened into "low confidence" — an over-correlation
  // is an overfit signal about the anchors, not doubt about the ranking.
  const CAL_MIN = 0.6;
  const CAL_MAX = 0.95;
  const calEvent = eventRows[0].parent_event_id || event;
  for (const row of query(`SELECT correlation, passed FROM calibration_runs WHERE event_id='${calEvent}'`)) {
    const corr = Number(row.correlation);
    const high = corr > CAL_MAX;
    const low = corr < CAL_MIN;
    if (row.passed) {
      // The stored verdict was computed under whatever band was in force at the
      // time, and the 0.95 ceiling postdates some of these rows — event
      // c35a0401 stored passed=1 at 0.994. Trusting the stored flag alone would
      // ship a bundle claiming "calibration passed" for a correlation today's
      // band rejects, so say so instead of silently deferring.
      if (high || low) {
        manifest.caveats.push({
          code: "calibration_band_drift",
          severity: "stored-verdict-disputed",
          correlation: corr,
          band: { min: CAL_MIN, max: CAL_MAX },
          failedSide: high ? "high" : "low",
          message: `This event's calibration was recorded as PASSED at correlation ${corr.toFixed(3)}, but the current ${CAL_MIN}-${CAL_MAX} band would reject it (${high ? "above the ceiling" : "below the floor"}). The stored verdict predates the current band; the raw number is in calibration.json.`,
        });
      }
      continue;
    }
    manifest.caveats.push({
      code: "calibration_failed",
      severity: high ? "ranking-untested" : "low-confidence",
      correlation: corr,
      band: { min: CAL_MIN, max: CAL_MAX },
      failedSide: high ? "high" : "low",
      message: high
        ? `Judge calibration correlation ${corr.toFixed(3)} exceeded the ${CAL_MAX} ceiling: the judges agreed far too closely for the 3 anchors, which points at the anchors being too easy to separate rather than at the ranking. Treat the recorded order as untested.`
        : `Judge calibration correlation ${corr.toFixed(3)} fell below the ${CAL_MIN} floor: the judges disagreed, so the recorded ranking is low-confidence.`,
    });
  }
  if (manifest.caveats.length === 0) {
    const anyCal = query(`SELECT 1 AS ok FROM calibration_runs WHERE event_id='${calEvent}' LIMIT 1`);
    if (anyCal.length === 0) {
      manifest.caveats.push({
        code: "calibration_absent",
        severity: "unverified",
        message: "No calibration run exists for this event, so judge agreement was never measured against the anchors. The ranking is unverified.",
      });
    }
  }
  if (manifest.caveats.length) {
    console.log(`\nCAVEATS (${manifest.caveats.length}) — carry these into any writeup of this event:`);
    for (const c of manifest.caveats) console.log(`  [${c.severity}] ${c.message}`);
  } else {
    console.log("\nno caveats: calibration passed");
  }
  // team_members has no event_id: scope to this event's team ids.
  const teamIds = query(`SELECT id FROM hackathon_teams WHERE event_id='${event}'`).map((r) => r.id);
  for (const [name, spec] of Object.entries(TABLES)) {
    let rows;
    if (name === "team_members") {
      rows = teamIds.length === 0 ? [] : query(`SELECT * FROM hackathon_team_members WHERE team_id IN (${teamIds.map((t) => `'${t}'`).join(",")})`);
    } else {
      rows = query(`SELECT * FROM ${spec.table} WHERE ${spec.column}='${event}'`);
    }
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rows, null, 2));
    manifest.tables[name] = rows.length;
    console.log(`${name}.json: ${rows.length} rows`);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // Hackathon events borrow their ideas/research/calibration from the parent
  // ideathon — export those too so the bundle is self-contained.
  if (eventRows[0].parent_event_id) {
    const parent = eventRows[0].parent_event_id;
    if (!/^[A-Za-z0-9_-]+$/.test(parent)) {
      console.error(`parent event id looks unsafe, skipping parent export: ${parent}`);
    } else {
      for (const [name, table] of [["parent_ideas", "archive_ideas"], ["parent_research", "research_calls"], ["parent_calibration", "calibration_runs"]]) {
        const rows = query(`SELECT * FROM ${table} WHERE event_id='${parent}'`);
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rows, null, 2));
        manifest.tables[name] = rows.length;
        console.log(`${name}.json: ${rows.length} rows (parent ${parent})`);
      }
      manifest.parent_event_id = parent;
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    }
  }
  console.log(`bundle written to ${dir}`);
}

main();
