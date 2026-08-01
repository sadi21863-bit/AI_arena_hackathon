#!/usr/bin/env node
/**
 * Arena health check — looks for the failures that DON'T raise errors.
 *
 * Every serious fault found on 2026-07-31/08-01 was silent and green. The
 * build-turn runaway dispatched 226 turns in a day against a ceiling of 6, for
 * roughly fourteen hours, while the cron ticked cleanly, `last_error` was null,
 * zero queue items failed, and the stall watchdog saw constant progress.
 * Nothing threw. It was visible only by comparing a QUANTITY against what it
 * was supposed to be bounded by.
 *
 * So this checks amounts, ratios and freshness — not error fields. Every check
 * below exists because something it would have caught actually happened.
 *
 * Read-only, public endpoints only: no admin token, no D1 access, no secrets.
 * Safe to run from anywhere, including CI or a cron.
 *
 *   node scripts/health_check.js
 *   node scripts/health_check.js --json      # machine-readable
 *
 * Exit 0 = clean, 1 = at least one FAIL.
 */

"use strict";

const API = process.env.ARENA_API || "https://arena-api.sadi21863.workers.dev";
const GH = "https://api.github.com";

/** Mirrors MAX_BUILD_TURNS_PER_DAY in src/events/scheduler.ts. */
const MAX_BUILD_TURNS_PER_DAY = 6;
/** Cron is every 5 minutes; three missed ticks is a real signal, one is noise. */
const CRON_STALE_MINUTES = 16;
/** ARENA_CADENCE_SLOT_MS is 10 days; nothing new in 13 means the cadence stopped. */
const CADENCE_STALE_DAYS = 13;
/** Past this, a queue that is mostly failures is not "self-healing", it is stuck. */
const QUEUE_FAILURE_RATIO = 0.25;

const json = process.argv.includes("--json");
const results = [];
const add = (level, check, detail) => results.push({ level, check, detail });
const ok = (c, d) => add("ok", c, d);
const warn = (c, d) => add("warn", c, d);
const fail = (c, d) => add("fail", c, d);

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": "arena-health-check" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const hoursSince = (ts) => {
  if (!ts) return Infinity;
  const d = new Date(String(ts).includes("T") ? ts : String(ts).replace(" ", "T") + "Z");
  return (Date.now() - d.getTime()) / 36e5;
};

/* ------------------------------------------------------------------ checks */

/** The cron is the engine. A stale tick means nothing else below is meaningful. */
async function checkCron(headroom) {
  const cron = headroom.cron;
  if (!cron) return fail("cron", "no heartbeat recorded at all");
  const mins = hoursSince(cron.last_tick_at) * 60;
  if (cron.last_error) fail("cron", `last tick reported an error: ${cron.last_error}`);
  else if (mins > CRON_STALE_MINUTES) fail("cron", `last tick ${mins.toFixed(0)}m ago (expected every 5m)`);
  else ok("cron", `ticking, last ${mins.toFixed(0)}m ago, no error`);

  // A tick that starts but never finishes leaves these apart — the failure the
  // heartbeat was added for, which a "last_error is null" check alone misses.
  if (cron.last_tick_at !== cron.last_success_at) {
    warn("cron", `last tick did not complete (tick=${cron.last_tick_at} success=${cron.last_success_at})`);
  }
}

/** Free tiers are the hard ceiling on everything the Arena does. */
function checkQuota(headroom) {
  for (const tier of headroom.usage || []) {
    const pct = tier.cap ? (tier.used / tier.cap) * 100 : 0;
    const label = `${tier.provider}/${String(tier.model_id).split("/").pop()}`;
    if (pct >= 90) fail("quota", `${label} at ${pct.toFixed(0)}% (${tier.used}/${tier.cap})`);
    else if (pct >= 70) warn("quota", `${label} at ${pct.toFixed(0)}% (${tier.used}/${tier.cap})`);
  }
  if (!results.some((r) => r.check === "quota")) ok("quota", "all tiers under 70%");
}

/**
 * Is the competition actually still running? An Arena that has created nothing
 * for longer than a cadence slot has stopped, and stopping is silent: no error,
 * no failed item, just an absence.
 */
function checkCadence(events) {
  const ideathons = events.filter((e) => e.type === "ideathon");
  if (!ideathons.length) return fail("cadence", "no ideathon has ever been created");
  const newest = ideathons[0];
  const days = hoursSince(newest.start_date) / 24;
  const active = events.filter((e) => !e.abandoned_at &&
    ((e.type === "ideathon" && e.status !== "judged") || (e.type === "hackathon" && e.status !== "complete")));

  if (active.length) ok("cadence", `${active.length} event(s) in flight`);
  else if (days > CADENCE_STALE_DAYS) fail("cadence", `nothing in flight and newest ideathon is ${days.toFixed(1)}d old`);
  else ok("cadence", `idle between cycles (newest ideathon ${days.toFixed(1)}d old)`);
}

/** The watchdog firing is not itself a failure — but it is never routine. */
function checkAbandoned(events) {
  const dead = events.filter((e) => e.abandoned_at);
  if (!dead.length) return ok("abandoned", "no events abandoned");
  for (const e of dead) warn("abandoned", `${e.id.slice(0, 18)} (${e.status}): ${e.abandoned_reason || "no reason recorded"}`);
}

/**
 * THE runaway check. Counts dispatches per team per UTC day against the same
 * ceiling the scheduler is supposed to enforce. This is the check that would
 * have caught 226-in-a-day on the first tick instead of the next morning.
 */
async function checkDispatchRate(event) {
  let turns;
  try { turns = await get(`${API}/events/${encodeURIComponent(event.id)}/build-turns`); }
  catch { return warn("dispatch-rate", `could not read build turns for ${event.id.slice(0, 18)}`); }
  if (!turns.length) return;

  const today = new Date().toISOString().slice(0, 10);
  const perDay = new Map();
  for (const t of turns) {
    const day = String(t.dispatched_at || "").slice(0, 10);
    if (!day) continue;
    const key = `${t.team_id}|${day}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  // TODAY breaching the cap is a live fault. A past day breaching it is history
  // on an event still in flight — real, worth stating, but already over. If
  // both read FAIL then this check screams forever about a fixed problem, and
  // a monitor that always fails is one nobody reads.
  let worstToday = 0, worstEver = 0, worstEverDay = "";
  for (const [key, n] of perDay) {
    const day = key.split("|")[1];
    if (day === today && n > worstToday) worstToday = n;
    if (n > worstEver) { worstEver = n; worstEverDay = day; }
  }

  if (worstToday > MAX_BUILD_TURNS_PER_DAY) {
    fail("dispatch-rate", `TODAY: ${worstToday} turns for one team (cap is ${MAX_BUILD_TURNS_PER_DAY}) — dispatching is running away now`);
  } else if (worstEver > MAX_BUILD_TURNS_PER_DAY) {
    warn("dispatch-rate", `historical: ${worstEver} turns for one team on ${worstEverDay} (cap is ${MAX_BUILD_TURNS_PER_DAY}); today is ${worstToday}, within cap`);
  } else {
    ok("dispatch-rate", `peak ${worstEver} turns/team/day, within the cap of ${MAX_BUILD_TURNS_PER_DAY}`);
  }

  // The route caps at 200 rows, and a healthy event produces a couple of dozen
  // — so hitting the cap is a signal in its own right, not merely a truncated
  // view. Warning rather than failing, because by the time you can see it the
  // turns have already been dispatched.
  if (turns.length >= 200) {
    warn("dispatch-rate", `${event.id.slice(0, 18)}: build-turns hit its 200-row limit — more turns recorded than any healthy event needs`);
  }
}

/**
 * Does a "successful" turn correspond to real work? A turn recorded as success
 * that produced no commit is the P0-0a shape, and it is exactly what a green
 * CI conclusion hides.
 */
async function checkTurnsProducedWork(event) {
  let teams, turns;
  try {
    teams = await get(`${API}/events/${encodeURIComponent(event.id)}/teams`);
    turns = await get(`${API}/events/${encodeURIComponent(event.id)}/build-turns`);
  } catch { return; }
  if (!teams.length) return;

  for (const team of teams) {
    const succeeded = turns.filter((t) => t.team_id === team.id && t.conclusion === "success").length;
    if (!succeeded) continue;
    let commits = [];
    try { commits = await get(`${GH}/repos/${team.repo_url}/commits?per_page=100`); } catch { continue; }
    const buildCommits = commits.filter((c) => /^Build turn /.test(c.commit.message)).length;
    if (buildCommits < succeeded) {
      fail("turns-vs-commits", `${team.team_name}: ${succeeded} successful turns but only ${buildCommits} build commits — success recorded without work`);
    } else {
      ok("turns-vs-commits", `${team.team_name}: ${succeeded} successful turns, ${buildCommits} build commits`);
    }
  }
}

/** A queue that is mostly failures is not self-healing, whatever the cron says. */
async function checkQueue(event) {
  let q;
  try { q = await get(`${API}/events/${encodeURIComponent(event.id)}/queue-status`); } catch { return; }
  const done = (q.completed ?? 0) + (q.failed ?? 0);
  if (!done) return;
  const ratio = (q.failed ?? 0) / done;
  if (ratio > QUEUE_FAILURE_RATIO) {
    fail("queue", `${event.id.slice(0, 18)}: ${q.failed}/${done} items failed (${(ratio * 100).toFixed(0)}%)`);
  } else {
    ok("queue", `${event.id.slice(0, 18)}: ${q.failed} failed of ${done}`);
  }
}

/**
 * Judging that has started but stopped, and a judge scoring with a model other
 * than the one pinned for the event — the P0-2 failure, which silently mixes
 * model families into one weighted ranking.
 */
async function checkJudging(event) {
  if (!["ready_for_judging", "judged"].includes(event.status)) return;
  let j;
  try { j = await get(`${API}/events/${encodeURIComponent(event.id)}/judging`); } catch { return; }

  const deviants = (j.judges || []).filter((x) => x.modelDeviates).map((x) => x.name);
  if (deviants.length) fail("judge-model", `${deviants.join(", ")} scored with a model other than the pinned ${j.pinned?.model || "(none)"}`);

  if (j.calibration && !j.calibration.passed) {
    warn("calibration", `correlation ${Number(j.calibration.correlation).toFixed(2)} failed its threshold — ranking is low-confidence`);
  }

  const scored = (j.judges || []).reduce((s, x) => s + x.scored, 0);
  const expected = (j.judges || []).reduce((s, x) => s + x.expected, 0);
  const stalledFor = hoursSince(event.last_progress_at);
  if (expected && scored < expected && stalledFor > 3) {
    fail("judging", `${scored}/${expected} scores after ${stalledFor.toFixed(1)}h without progress`);
  } else if (expected) {
    ok("judging", `${scored}/${expected} scores`);
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  let headroom, events;
  try {
    [headroom, events] = await Promise.all([get(`${API}/headroom`), get(`${API}/events`)]);
  } catch (err) {
    console.error(`Could not reach the Arena API: ${err.message}`);
    process.exit(1);
  }

  await checkCron(headroom);
  checkQuota(headroom);
  checkCadence(events);
  checkAbandoned(events);

  // Only events still in flight are worth checking in detail; a completed
  // event's numbers are history, and re-flagging them forever would train
  // whoever reads this to ignore it.
  const live = events.filter((e) => !e.abandoned_at &&
    ((e.type === "ideathon" && e.status !== "judged") || (e.type === "hackathon" && e.status !== "complete")));

  for (const e of live) {
    await checkQueue(e);
    await checkJudging(e);
    if (e.type === "hackathon") {
      await checkDispatchRate(e);
      await checkTurnsProducedWork(e);
    }
  }

  const fails = results.filter((r) => r.level === "fail");
  const warns = results.filter((r) => r.level === "warn");

  if (json) {
    console.log(JSON.stringify({ ok: fails.length === 0, fails: fails.length, warns: warns.length, results }, null, 2));
  } else {
    const mark = { ok: "  ok  ", warn: " WARN ", fail: " FAIL " };
    for (const r of results) console.log(`${mark[r.level]} ${r.check.padEnd(18)} ${r.detail}`);
    console.log(
      fails.length ? `\n${fails.length} FAIL, ${warns.length} warning(s) — investigate the counts above, not just the error fields.`
        : warns.length ? `\nclean, with ${warns.length} warning(s)`
        : "\nclean"
    );
  }
  process.exit(fails.length ? 1 : 0);
}

main();
