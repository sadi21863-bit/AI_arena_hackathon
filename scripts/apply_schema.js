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
  { file: "schema_week8_agent_ratings.sql", sentinel: { type: "column", table: "archive_agents", name: "elo_rating" } },
  { file: "schema_week8_chronicle.sql", sentinel: { type: "table", name: "event_chronicle" } },
  { file: "schema_week9_conduct.sql", sentinel: { type: "column", table: "archive_ideas", name: "recycle_class" } },
];

/**
 * Runs wrangler's JS entry point directly under node, with NO shell.
 *
 * The obvious `npx wrangler ...` needs shell:true on Windows (npx.cmd is a
 * batch script and execFileSync throws EINVAL without it), and shell:true
 * string-concatenates argv — which is what forced every query through a temp
 * file to dodge quoting. Going straight to bin/wrangler.js removes the shell,
 * so arguments are passed through verbatim and `--command` is safe to use.
 * That matters for correctness, not just tidiness — see execSql below.
 */
const WRANGLER_BIN = path.join(__dirname, "..", "node_modules", "wrangler", "bin", "wrangler.js");

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Runs a query and returns wrangler's raw --json output.
 *
 * MUST use --command, never --file. Found live 2026-07-31, mid-deploy, against
 * production: `d1 execute --remote --file` does not return the query's rows at
 * all — it returns a batch SUMMARY, `[{"Total queries executed": 1, "Rows
 * read": 43, ...}]`. parseRows sees exactly one row and every sentinel check
 * therefore answers "present", for every table and column, including ones that
 * do not exist.
 *
 * The consequence was not a crash. `--baseline` would have recorded all 15
 * migrations as already applied — the four genuinely new ones included — then
 * printed "Nothing to do", leaving production without the new schema while the
 * tracking table asserted it was fully migrated. A silent no-op reported as
 * success, which is the exact failure shape docs/ARENA_BACKLOG.md opens by
 * warning about.
 *
 * `--command` returns real rows. assertQueryRows below makes a regression
 * loud rather than silent.
 */
function execSql(target, sql) {
  return wrangler(["d1", "execute", DB_NAME, target, "--json", "--command", sql]);
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

/**
 * Refuses to treat a batch summary as query results.
 *
 * `d1 execute --file` answers with `{"Total queries executed": N, "Rows read":
 * ...}` instead of the rows. Every sentinel check then reads as "present" and
 * the tool silently decides there is nothing to migrate. Detecting the summary
 * shape turns a wrong answer into a stopped run — the difference between
 * noticing at deploy time and noticing when production is missing columns.
 */
function assertQueryRows(rows, what) {
  if (rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, "Total queries executed"))) {
    console.error(
      `Refusing to continue: got a batch summary instead of rows when checking ${what}.\n` +
      `This means a query ran through --file rather than --command; every sentinel would read as present.`
    );
    process.exit(1);
  }
  return rows;
}

function sentinelPresent(target, sentinel) {
  if (sentinel.type === "column") {
    // PRAGMA returns nothing (not an error) for a table that doesn't exist,
    // which is the right answer here anyway: no table means no column.
    const out = execSql(target, `PRAGMA table_info(${sentinel.table});`);
    const rows = assertQueryRows(parseRows(out), `${sentinel.table}.${sentinel.name}`);
    return rows.some((r) => r.name === sentinel.name);
  }
  const out = execSql(
    target,
    `SELECT name FROM sqlite_master WHERE type='${sentinel.type}' AND name='${sentinel.name}';`
  );
  return assertQueryRows(parseRows(out), `${sentinel.type} ${sentinel.name}`).length > 0;
}

function appliedSet(target) {
  if (!sentinelPresent(target, { type: "table", name: "schema_migrations" })) return new Set();
  const rows = assertQueryRows(parseRows(execSql(target, "SELECT name FROM schema_migrations;")), "schema_migrations");
  return new Set(rows.map((r) => r.name));
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
