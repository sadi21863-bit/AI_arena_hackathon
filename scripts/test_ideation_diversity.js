// One-off verification script for the ideation-diversity fix (executor.ts
// handleSubmitIdea, commit 185bba9): creates a real test ideathon event,
// fast-forwards its calendar date straight into the ideation_critique phase
// (same backdating pattern CLAUDE.md already documents for gate testing --
// day-math is real production code, only the calendar input is faked),
// drains the queue by ticking until all 12 agents' submit_idea + critique
// work completes, then prints each agent's 3 ideas side by side with a
// crude word-overlap score so duplicates jump out visually.
//
// Usage: node scripts/test_ideation_diversity.js
// Requires .admin_token.txt in the repo root (already provisioned in prod).

const fs = require("fs");
const path = require("path");

const API = "https://arena-api.sadi21863.workers.dev";
const TOKEN = fs.readFileSync(path.join(__dirname, "..", ".admin_token.txt"), "utf8").trim();

function authed(url, opts = {}) {
  return fetch(API + url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function wordSet(text) {
  return new Set((text || "").toLowerCase().match(/[a-z0-9]+/g) || []);
}

function jaccard(a, b) {
  const sa = wordSet(a), sb = wordSet(b);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function main() {
  console.log("Creating test ideathon event...");
  const createResp = await authed("/admin/events", { method: "POST", body: JSON.stringify({ type: "ideathon" }) });
  if (!createResp.ok) throw new Error(`create failed: ${createResp.status} ${await createResp.text()}`);
  const { id: eventId } = await createResp.json();
  console.log("Event:", eventId);

  // 60 hours ago lands daysElapsed at 2 (phaseForDay: <2 deep_research,
  // <3 ideation_critique) -- squarely inside ideation_critique with margin
  // on both sides, skipping deep_research entirely since this test only
  // needs to exercise submit_idea/critique, not the research budget.
  const backdated = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  console.log("Backdating start_date to", backdated, "(ideation_critique phase)...");
  const dateResp = await authed(`/admin/events/${eventId}/start-date`, { method: "PATCH", body: JSON.stringify({ startDate: backdated }) });
  if (!dateResp.ok) throw new Error(`start-date failed: ${dateResp.status} ${await dateResp.text()}`);

  console.log("Draining queue (submit_idea x36, critique x~108)...");
  let lastCounts = null;
  let stableTicks = 0;
  for (let i = 0; i < 120; i++) {
    const tickResp = await authed(`/admin/events/${eventId}/tick`, { method: "POST" });
    if (!tickResp.ok) {
      console.warn("tick failed:", tickResp.status, await tickResp.text());
    }
    const statusResp = await fetch(`${API}/events/${eventId}/queue-status`);
    const counts = await statusResp.json();
    const line = `pending=${counts.pending} in_progress=${counts.in_progress} completed=${counts.completed} failed=${counts.failed}`;
    if (line !== lastCounts) {
      console.log(`[tick ${i + 1}]`, line);
      lastCounts = line;
      stableTicks = 0;
    } else {
      stableTicks++;
    }
    if (counts.pending === 0 && counts.in_progress === 0 && counts.completed > 0) {
      console.log("Queue drained.");
      break;
    }
    if (stableTicks > 8) {
      console.log("No progress for a while, stopping early -- check /failed items manually if this looks wrong.");
      break;
    }
    await sleep(8000);
  }

  console.log("\nFetching ideas...");
  const ideasResp = await fetch(`${API}/ideas?event_id=${eventId}`);
  const ideas = await ideasResp.json();

  const byAgent = {};
  for (const idea of ideas) {
    (byAgent[idea.agent_id] = byAgent[idea.agent_id] || []).push(idea);
  }

  console.log(`\n${ideas.length} ideas from ${Object.keys(byAgent).length} agents:\n`);
  let flaggedPairs = 0;
  for (const [agentId, agentIdeas] of Object.entries(byAgent)) {
    console.log(`--- ${agentId} (${agentIdeas.length} ideas) ---`);
    agentIdeas.forEach((idea, i) => console.log(`  ${i + 1}. ${idea.title} -- ${idea.one_liner}`));
    for (let i = 0; i < agentIdeas.length; i++) {
      for (let j = i + 1; j < agentIdeas.length; j++) {
        const sim = jaccard(
          `${agentIdeas[i].title} ${agentIdeas[i].one_liner} ${agentIdeas[i].problem}`,
          `${agentIdeas[j].title} ${agentIdeas[j].one_liner} ${agentIdeas[j].problem}`
        );
        if (sim > 0.35) {
          console.log(`  ! POSSIBLE DUPLICATE (word-overlap ${sim.toFixed(2)}): "${agentIdeas[i].title}" vs "${agentIdeas[j].title}"`);
          flaggedPairs++;
        }
      }
    }
  }

  console.log(`\nEvent ID: ${eventId}`);
  console.log(`Flagged near-duplicate pairs (word-overlap > 0.35): ${flaggedPairs}`);
  console.log("This is a crude heuristic (word overlap, not embeddings) -- eyeball the printed titles/one-liners above too.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
