/**
 * Applies db/*.sql to a D1 database in a known order, once each.
 *
 * Why this exists: db/ accumulated ten loose schema files over Weeks 1-8, each
 * applied to production by hand as it landed. Nothing recorded what had been
 * applied, the order lived only in git history, and most of the files are not
 * idempotent (bare CREATE TABLE / ALTER TABLE ADD COLUMN), so re-running them
 * errors. Auditing live prod on 2026-07-30 confirmed the practical consequence:
 * there was no reliable path from an empty database to current production, and
 * no way to answer "is migration X in?" without inspecting sqlite_master by
 * hand. See db/schema_migrations.sql and db/APPLY_ORDER.md.
 *
 * Usage:
 *   node scripts/apply_schema.js --local              # fresh local DB: run everything
 *   node scripts/apply_schema.js --remote             # run only what's missing
 *   node scripts/apply_schema.js --remote --status    # report, change nothing
 *   node scripts/apply_schema.js --remote --baseline  # record what's already present
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DB_NAME = "arena-db";
const DB_DIR = path.join(__dirname, "..", "db");
const isWindows = process.platform === "win32";

/**
 * Canonical apply order. This list is the source of truth — db/APPLY_ORDER.md
 * documents it for humans, but the script reads this.
 *
 * Order is not alphabetical and not arbitrary: schema.sql creates the tables
 * the ALTER TABLE files modify, schema_hackathon_events.sql must precede
 * schema_week5_tribunal.sql (which ALTERs hackathon_teams), and
 * schema_week5b / schema_week8_judge_model_tracking ALTER judge_scores, created
 * by schema_week5_tribunal.sql.
 *
 * `sentinel` is a database object the file creates, used to detect whether the
 * file has already been applied to a database that predates tracking. It makes
 * --baseline self-verifying: a migration is recorded as already-present only if
 * its sentinel is genuinely there, so a brand-new migration sitting in this
 * list can't be silently marked as done and skipped forever. Types:
 *   table  — sqlite_master row
 *   index  — sqlite_master row
 *   column — PRAGMA table_info, for the ALTER-only migrations that create no
 *            new object of their own
 *
 * `seed_agents.sql` is deliberately absent — it is data, not schema, and
 * re-running it against a live archive would be a data change, not a no-op.
 * Apply it by hand exactly once when bootstrapping a new database.
 */
const MIGRATIONS = [
  { file: "schema_migrations.sql", sentinel: { type: "table", name: "schema_migrations" } },
  { file: "schema.sql", sentinel: { type: "table", name: "archive_events" } },
  { file: "schema_week3_event_queue.sql", sentinel: { type: "table", name: "event_queue" } },
  { file: "schema_research_budget.sql", sentinel: { type: "table", name: "research_calls" } },
  { file: "schema_hackathon_events.sql", sentinel: { type: "table", name: "hackathon_teams" } },
  { file: "schema_week5_tribunal.sql", sentinel: { type: "table", name: "judge_scores" } },
  { file: "schema_week5b_judge_scores_unique.sql", sentinel: { type: "index", name: "idx_judge_scores_unique" } },
  { file: "schema_week8_cron_heartbeat.sql", sentinel: { type: "table", name: "cron_heartbeat" } },
  { file: "schema_week8_judge_model_tracking.sql", sentinel: { type: "column", table: "judge_scores", name: "provider" } },
  { file: "schema_build_turns.sql", sentinel: { type: "table", name: "build_turns" } },
  { file: "schema_team_members.sql", sentinel: { type: "table", name: "hackathon_team_members" } },
  { file: "schema_week8_event_id_indexes.sql", sentinel: { type: "index", name: "idx_event_queue_event" } },
  { file: "schema_week8_stall_tracking.sql", sentinel: { type: "column", table: "archive_events", name: "last_progress_at" } },
];

function wrangler(args) {
  return execFileSync(isWindows ? "npx.cmd" : "npx", ["wrangler", ...args], {
    encoding: "utf8",
    shell: isWindows,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Runs SQL via a temp file rather than --command. Deliberate: passing SQL
 * inline needs shell quoting, and on Windows execFileSync with shell:true
 * string-concatenates arguments, so any quote or space in the statement
 * corrupts the command. A file path has neither problem.
 */
function execSql(target, sql) {
  const tmp = path.join(__dirname, `.apply_schema_${process.pid}.sql`);
  fs.writeFileSync(tmp, sql);
  try {
    return wrangler(["d1", "execute", DB_NAME, target, "--json", "--file", tmp]);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function execMigration(target, file) {
  return wrangler(["d1", "execute", DB_NAME, target, "--file", path.join("db", file)]);
}

/** wrangler --json writes diagnostics to stderr, but guard anyway. */
function parseRows(stdout) {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  return JSON.parse(stdout.slice(start)).flatMap((r) => r.results ?? []);
}

function sentinelPresent(target, sentinel) {
  if (sentinel.type === "column") {
    // PRAGMA returns nothing (not an error) for a table that doesn't exist,
    // which is the right answer here anyway: no table means no column.
    const out = execSql(target, `PRAGMA table_info(${sentinel.table});`);
    return parseRows(out).some((r) => r.name === sentinel.name);
  }
  const out = execSql(
    target,
    `SELECT name FROM sqlite_master WHERE type='${sentinel.type}' AND name='${sentinel.name}';`
  );
  return parseRows(out).length > 0;
}

function appliedSet(target) {
  if (!sentinelPresent(target, { type: "table", name: "schema_migrations" })) return new Set();
  return new Set(parseRows(execSql(target, "SELECT name FROM schema_migrations;")).map((r) => r.name));
}

function record(target, files, method) {
  if (files.length === 0) return;
  const values = files.map((f) => `('${f}', '${method}')`).join(",\n  ");
  execSql(target, `INSERT OR IGNORE INTO schema_migrations (name, method) VALUES\n  ${values};`);
}

function main() {
  const args = process.argv.slice(2);
  const target = args.includes("--remote") ? "--remote" : args.includes("--local") ? "--local" : null;
  if (!target) {
    console.error("Specify --remote or --local.");
    process.exit(1);
  }
  const statusOnly = args.includes("--status");
  const baseline = args.includes("--baseline");

  for (const { file } of MIGRATIONS) {
    if (!fs.existsSync(path.join(DB_DIR, file))) {
      console.error(`Listed in MIGRATIONS but missing from db/: ${file}`);
      process.exit(1);
    }
  }

  const applied = appliedSet(target);
  const pending = MIGRATIONS.filter((m) => !applied.has(m.file));

  console.log(`${DB_NAME} ${target}: ${applied.size} recorded, ${pending.length} pending`);

  if (statusOnly) {
    // Check every migration's sentinel, recorded or not — that's what surfaces
    // drift in both directions (recorded but missing, or present but
    // unrecorded) rather than just echoing the tracking table back.
    for (const m of MIGRATIONS) {
      const rec = applied.has(m.file);
      const present = sentinelPresent(target, m.sentinel);
      const flag = rec === present ? "" : rec ? "  <-- RECORDED BUT SENTINEL MISSING" : "  <-- PRESENT BUT UNRECORDED";
      console.log(`  ${rec ? "[x]" : "[ ]"} ${present ? "present" : "absent "}  ${m.file}${flag}`);
    }
    return;
  }

  for (const m of MIGRATIONS) console.log(`  ${applied.has(m.file) ? "[x]" : "[ ]"} ${m.file}`);

  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (baseline) {
    // Record only the migrations whose sentinel is genuinely in the database.
    // Anything else stays pending for a normal run — so this is safe to use on
    // a database that is partway through, and safe to re-run after adding new
    // migrations to the list.
    const alreadyThere = pending.filter((m) => m.file !== "schema_migrations.sql" && sentinelPresent(target, m.sentinel));
    if (alreadyThere.length === 0) {
      console.error("Refusing to baseline: none of the pending migrations' objects exist, so this database is not already migrated.");
      process.exit(1);
    }
    // schema_migrations itself has to be created for real, not asserted.
    if (!applied.has("schema_migrations.sql")) execMigration(target, "schema_migrations.sql");
    record(target, ["schema_migrations.sql", ...alreadyThere.map((m) => m.file)], "baseline");

    const stillPending = pending.filter((m) => m.file !== "schema_migrations.sql" && !alreadyThere.includes(m));
    console.log(`\nRecorded ${alreadyThere.length} migration(s) as baseline. Nothing was executed.`);
    if (stillPending.length > 0) {
      console.log(`Still pending (run without --baseline to apply): ${stillPending.map((m) => m.file).join(", ")}`);
    }
    return;
  }

  for (const { file } of pending) {
    console.log(`\n--- applying ${file}`);
    execMigration(target, file);
    record(target, [file], "applied");
  }
  console.log(`\nApplied ${pending.length} migration(s).`);
}

main();
