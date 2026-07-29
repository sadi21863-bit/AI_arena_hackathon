// Follow-up to drive_to_judged.js: all 6 architecture_complete ideas were
// already showing real ideathon_score/status='judged' (confirmed via
// GET /ideas) by the time that script's polling gave up, but the EVENT's
// own status hadn't been re-checked since the last idea flipped --
// ensureIdeathonJudging only re-evaluates "are there 0 unjudged ideas left"
// on its next call. One more tick should flip event.status to 'judged',
// then this confirms the auto-hackathon-creation fires for real.
//
// Usage: node scripts/finish_judging_and_check_hackathon.js <eventId>

const fs = require("fs");
const path = require("path");

const API = "https://arena-api.sadi21863.workers.dev";
const TOKEN = fs.readFileSync(path.join(__dirname, "..", ".admin_token.txt"), "utf8").trim();
const eventId = process.argv[2];
if (!eventId) { console.error("usage: node scripts/finish_judging_and_check_hackathon.js <eventId>"); process.exit(1); }

function authed(url, opts = {}) {
  return fetch(API + url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
}

async function main() {
  for (let i = 0; i < 5; i++) {
    const tickResp = await authed(`/admin/events/${eventId}/tick`, { method: "POST" });
    console.log(`tick ${i + 1} ->`, tickResp.status, await tickResp.text());
    const ev = await (await fetch(`${API}/events/${eventId}`)).json();
    console.log("event status:", ev.status);
    if (ev.status === "judged") break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const finalEv = await (await fetch(`${API}/events/${eventId}`)).json();
  if (finalEv.status !== "judged") {
    console.log("Still not judged -- stopping here, something else may be wrong.");
    return;
  }

  console.log("\nEvent is judged. Calling /admin/cadence/tick...");
  const cadenceResp = await authed("/admin/cadence/tick", { method: "POST" });
  console.log("cadence tick ->", cadenceResp.status, await cadenceResp.text());

  const hackathons = await (await fetch(`${API}/events?type=hackathon`)).json();
  const auto = hackathons.find((h) => h.parent_event_id === eventId);
  if (auto) console.log(`\nPASS: hackathon ${auto.id} auto-created for real, status=${auto.status}`);
  else console.log("\nFAIL: no hackathon found for this ideathon after cadence tick.");
}

main().catch((e) => { console.error(e); process.exit(1); });
