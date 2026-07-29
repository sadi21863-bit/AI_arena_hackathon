// One-off verification script for ensureArenaCadence (scheduler.ts) --
// checks both new auto-creation behaviors added on top of the existing
// per-event phase engine:
//   1. A judged ideathon with no hackathon yet gets one auto-created.
//   2. Once a cycle (ideathon judged + its hackathon complete) is fully
//      done, the next ideathon auto-starts once the calendar reaches one
//      month past the previous ideathon's start_date -- not before.
//
// Uses only synthetic throwaway events (created and deleted by this
// script) so it never touches real production event history. Flips
// status directly via `wrangler d1 execute --remote` for the two states
// (`judged`, `complete`) that don't have an admin HTTP route of their own
// -- everything else goes through the real admin API, same as the ideation
// diversity test script.
//
// Usage: node scripts/test_arena_cadence.js
// Requires .admin_token.txt in the repo root and `npx wrangler` configured
// (same account this repo already deploys to).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const API = "https://arena-api.sadi21863.workers.dev";
const TOKEN = fs.readFileSync(path.join(__dirname, "..", ".admin_token.txt"), "utf8").trim();

function authed(url, opts = {}) {
  return fetch(API + url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
}

function d1(sql) {
  const isWindows = process.platform === "win32";
  execFileSync(
    isWindows ? "npx.cmd" : "npx",
    ["wrangler", "d1", "execute", "arena-db", "--remote", "--command", sql],
    { stdio: "inherit", shell: isWindows }
  );
}

async function createEvent(type, parentEventId) {
  const body = { type };
  if (parentEventId) body.parentEventId = parentEventId;
  const resp = await authed("/admin/events", { method: "POST", body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`create ${type} failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).id;
}

async function deleteEvent(id) {
  const resp = await authed(`/admin/events/${id}`, { method: "DELETE" });
  const text = await resp.text();
  console.log(`  cleanup ${id}: ${resp.status} ${text}`);
}

async function getEvents(type) {
  const resp = await fetch(`${API}/events?type=${type}`);
  return resp.json();
}

async function main() {
  const created = [];
  try {
    console.log("=== Test 1: judged ideathon with no hackathon gets one auto-created ===");
    const ideathonA = await createEvent("ideathon");
    created.push(ideathonA);
    console.log("Created test ideathon:", ideathonA);

    console.log("Flipping its status to judged (direct D1 -- no HTTP route sets this status directly)...");
    d1(`UPDATE archive_events SET status='judged' WHERE id='${ideathonA}'`);

    console.log("Calling POST /admin/cadence/tick...");
    let tick = await authed("/admin/cadence/tick", { method: "POST" });
    console.log("  ->", tick.status, await tick.text());

    const hackathons = await getEvents("hackathon");
    const autoHackathon = hackathons.find((h) => h.parent_event_id === ideathonA);
    if (!autoHackathon) {
      console.log("FAIL: no hackathon was auto-created for the judged test ideathon.");
    } else {
      console.log(`PASS: hackathon ${autoHackathon.id} auto-created, status=${autoHackathon.status}`);
      created.push(autoHackathon.id);
    }

    console.log("\n=== Test 2: next ideathon only auto-starts once cycle is done AND >=1 month has passed ===");
    if (autoHackathon) {
      console.log("Sub-test 2a: cycle done but calendar gate NOT yet reached -- should NOT create a new ideathon.");
      d1(`UPDATE archive_events SET status='complete' WHERE id='${autoHackathon.id}'`);
      // ideathonA's start_date is "now" (just created) -- next slot is ~1 month away, so this should be a no-op.
      const beforeCount = (await getEvents("ideathon")).length;
      tick = await authed("/admin/cadence/tick", { method: "POST" });
      console.log("  ->", tick.status, await tick.text());
      const afterCount = (await getEvents("ideathon")).length;
      if (afterCount === beforeCount) {
        console.log(`PASS: ideathon count unchanged (${beforeCount}) -- correctly waited for the monthly gate.`);
      } else {
        console.log(`FAIL: ideathon count changed ${beforeCount} -> ${afterCount} -- should not have fired yet.`);
      }

      console.log("\nSub-test 2b: backdate ideathonA's start_date >1 month back -- should NOW auto-create the next ideathon.");
      const overAMonthAgo = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      const dateResp = await authed(`/admin/events/${ideathonA}/start-date`, { method: "PATCH", body: JSON.stringify({ startDate: overAMonthAgo }) });
      console.log("  start-date PATCH ->", dateResp.status);

      const before2 = new Set((await getEvents("ideathon")).map((e) => e.id));
      tick = await authed("/admin/cadence/tick", { method: "POST" });
      console.log("  cadence tick ->", tick.status, await tick.text());
      const after2 = await getEvents("ideathon");
      const newOnes = after2.filter((e) => !before2.has(e.id));
      if (newOnes.length === 1) {
        console.log(`PASS: next ideathon auto-created (${newOnes[0].id}) once the monthly gate + completed cycle both held.`);
        created.push(newOnes[0].id);
      } else {
        console.log(`FAIL: expected exactly 1 new ideathon, got ${newOnes.length}.`);
      }
    } else {
      console.log("Skipping test 2 -- test 1 already failed.");
    }
  } finally {
    console.log("\n=== Cleanup (deleting synthetic test events, in reverse creation order) ===");
    for (const id of created.reverse()) {
      await deleteEvent(id);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
