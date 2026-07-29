// Drives a specific real ideathon event through its remaining day-gated
// phases (collaboration -> architecture -> ready_for_judging -> judged) by
// progressively backdating start_date and draining the queue at each step
// -- same "compressed schedule verification" pattern CLAUDE.md documents,
// just applied one phase at a time instead of jumping straight to the end.
// Jumping straight to ready_for_judging would skip collaboration and
// architecture entirely (ensurePhaseWorkQueued only queues work for
// whatever phase daysElapsed currently computes to), leaving ideas without
// real build_scope going into judging -- so each boundary must be crossed
// and drained in order.
//
// Usage: node scripts/drive_to_judged.js <eventId>

const fs = require("fs");
const path = require("path");

const API = "https://arena-api.sadi21863.workers.dev";
const TOKEN = fs.readFileSync(path.join(__dirname, "..", ".admin_token.txt"), "utf8").trim();
const eventId = process.argv[2];
if (!eventId) { console.error("usage: node scripts/drive_to_judged.js <eventId>"); process.exit(1); }

function authed(url, opts = {}) {
  return fetch(API + url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function backdate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const resp = await authed(`/admin/events/${eventId}/start-date`, { method: "PATCH", body: JSON.stringify({ startDate: d }) });
  if (!resp.ok) throw new Error(`start-date failed: ${resp.status} ${await resp.text()}`);
  console.log(`Backdated to ${d} (~${daysAgo} days ago)`);
}

async function drainUntil(predicate, label, maxTicks = 80) {
  let lastLine = null, stable = 0;
  for (let i = 0; i < maxTicks; i++) {
    const tickResp = await authed(`/admin/events/${eventId}/tick`, { method: "POST" });
    const tickBody = await tickResp.json().catch(() => ({}));
    const ev = await (await fetch(`${API}/events/${eventId}`)).json();
    const q = await (await fetch(`${API}/events/${eventId}/queue-status`)).json();
    const line = `phase=${ev.status} pending=${q.pending} in_progress=${q.in_progress} completed=${q.completed} failed=${q.failed}`;
    if (line !== lastLine) { console.log(`  [${label} tick ${i + 1}]`, line, tickBody.phase ? `(tick reported: ${tickBody.phase})` : ""); lastLine = line; stable = 0; }
    else stable++;
    if (predicate(ev, q)) { console.log(`  ${label}: done.`); return ev; }
    if (stable > 10) { console.log(`  ${label}: no progress for a while, moving on (check manually if this looks wrong).`); return ev; }
    await sleep(6000);
  }
  console.log(`  ${label}: hit max ticks, moving on.`);
  return (await (await fetch(`${API}/events/${eventId}`)).json());
}

async function main() {
  console.log(`Driving ${eventId} to judged...\n`);

  console.log("=== Step 1: -> collaboration phase (daysElapsed=3) ===");
  await backdate(3.5);
  await drainUntil((ev, q) => ev.status !== "collaboration" || (q.pending === 0 && q.in_progress === 0), "collaboration");

  console.log("\n=== Step 2: -> architecture phase (daysElapsed=4.5) ===");
  await backdate(4.5);
  await drainUntil((ev, q) => ev.status === "ready_for_judging" || ev.status === "judged" || (ev.status === "architecture" && q.pending === 0 && q.in_progress === 0), "architecture");

  console.log("\n=== Step 3: -> ready_for_judging / judged (daysElapsed=6.5) ===");
  await backdate(6.5);
  const final = await drainUntil((ev) => ev.status === "judged", "judging", 120);

  console.log(`\nFinal status: ${final.status}`);
  if (final.status === "judged") {
    console.log("\n=== Confirming auto-hackathon-creation fires ===");
    const cadenceResp = await authed("/admin/cadence/tick", { method: "POST" });
    console.log("cadence tick ->", cadenceResp.status, await cadenceResp.text());
    const hackathons = await (await fetch(`${API}/events?type=hackathon`)).json();
    const auto = hackathons.find((h) => h.parent_event_id === eventId);
    if (auto) console.log(`PASS: hackathon ${auto.id} auto-created, status=${auto.status}`);
    else console.log("FAIL: no hackathon found for this ideathon after cadence tick.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
