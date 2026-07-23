/**
 * Event queue executor — claims items (queue.ts), dispatches by task_type,
 * calls the LLM via the inference router with the agent's own persona,
 * parses structured output (json-helpers.ts, ported from ideaconnect), and
 * writes results through Week 2's interaction/research functions.
 */

import type { Env } from "../env";
import { routeInference } from "../router";
import { extractJson } from "../agents/json-helpers";
import { getAgent, type AgentRow } from "../agents/personas";
import { deepResearch } from "../agents/research";
import { postIdea, critiqueIdea, reviseIdea } from "../agents/interactions";
import { recallMemory } from "../agents/memory";
import { createTeamRepo } from "../github/repos";
import { dispatchBuildTurn, listBuildTurnRuns } from "../github/dispatch";
import { scoreTarget } from "../judges/scoring";
import { handleTribunalReflect, handleTribunalCrossExamine, handleTribunalSynthesize } from "../tribunal/reflection";
import { claimNext, markCompleted, markFailed, resetStuckItems, enqueue, type QueueItem } from "./queue";
import { countPayloadFieldMatches, requirePayloadField } from "./payload-utils";

async function callAgent(env: Env, agent: AgentRow, taskType: Parameters<typeof routeInference>[1]["task_type"], instructions: string): Promise<string> {
  const prompt = `${agent.persona}\n\n${instructions}`;
  const result = await routeInference(env, { task_type: taskType, prompt, max_tokens: 700 });
  if (!result) throw new Error(`Inference exhausted for agent ${agent.id}`);
  return result.text;
}

async function handleResearch(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const payload = item.payload ? JSON.parse(item.payload) : {};
  const lens = payload.lens ?? agent.lens;
  // Deterministic queries from role/lens rather than an extra LLM round-trip
  // to generate them — keeps this task cheap; the agent's actual reasoning
  // happens when it later uses this research to write an idea.
  //
  // Four angles, not one (2026-07-21 budget review — 3 pooled Tavily
  // accounts give real room now; see research.ts's header comment for the
  // math): opportunities, review of prior failures, target-user validation,
  // and market/funding signals — broader grounding than a single query
  // could give. deepResearch() enforces its own per-event/monthly budget on
  // each call, so if any of these end up over budget it degrades
  // gracefully — nothing here needs to know or care.
  const queries = [
    `${agent.name}'s ${lens} lens: emerging opportunities, pain points, or gaps worth building a product around in 2026`,
    `${lens} lens: startups or products that recently failed, shut down, or were abandoned trying to solve this in 2025-2026, and why`,
    `${lens} lens: real evidence of who specifically feels this pain today and how they currently work around it, 2026`,
    `${lens} lens: recent funding, acquisitions, or market signals in 2025-2026 indicating real demand in this space`,
  ];

  for (const query of queries) {
    await deepResearch(env, { agentId: agent.id, eventId: item.event_id, lens, query });
  }
}

interface IdeaJson {
  title: string; one_liner: string; problem: string; solution: string; target_user: string; build_scope: string;
}

async function handleSubmitIdea(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const memories = await recallMemory(env, agent.id, `${agent.lens} opportunities and research findings`, 3);
  const context = memories.map((m) => `- ${m.text}`).join("\n") || "(no prior research recalled)";

  const text = await callAgent(env, agent, "design",
    `Recent research from your own lens:\n${context}\n\n` +
    `Submit ONE product idea grounded in that research. Respond with ONLY a JSON object: ` +
    `{"title": string, "one_liner": string, "problem": string, "solution": string, "target_user": string, "build_scope": string}. ` +
    `build_scope should be a short buildable-in-days scope, not a vague vision.`
  );

  const idea = extractJson<IdeaJson>(text);
  if (!idea?.title || !idea.problem || !idea.solution) throw new Error(`Malformed idea JSON from ${agent.id}: ${text.slice(0, 200)}`);

  const ideaId = await postIdea(env, {
    agentId: agent.id, eventId: item.event_id, title: idea.title, oneLiner: idea.one_liner,
    problem: idea.problem, solution: idea.solution, targetUser: idea.target_user, buildScope: idea.build_scope,
  });

  // Spec §4: "critique 3 ideas not their own" — queued per-idea rather than
  // as one big batch step, so critique flow starts as soon as ideas exist
  // instead of waiting for every agent to finish submitting first.
  const critic = await env.DB.prepare(
    `SELECT id FROM archive_agents WHERE id != ? ORDER BY RANDOM() LIMIT 1`
  ).bind(agent.id).first<{ id: string }>();
  if (critic) {
    await enqueue(env, { eventId: item.event_id, agentId: critic.id, taskType: "critique", payload: { ideaId }, priority: 6 });
  }
}

interface CritiqueJson { strength: string; weakness: string; suggestion: string }

async function handleCritique(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const ideaId = requirePayloadField(item.payload, "ideaId", "critique");

  const idea = await env.DB.prepare(`SELECT * FROM archive_ideas WHERE id = ?`).bind(ideaId).first<Record<string, unknown>>();
  if (!idea) throw new Error(`Idea not found: ${ideaId}`);

  // Ground the critique in something real rather than pure LLM opinion —
  // budgetExceeded degrades to an empty result list, which the prompt
  // below handles fine either way (no special-casing needed here).
  const grounding = await deepResearch(env, {
    agentId: agent.id, eventId: item.event_id, lens: agent.lens,
    query: `existing products or direct competitors for: ${idea.title} — ${idea.one_liner}`,
    maxResults: 3,
  });
  const groundingText = grounding.results.length
    ? `Real competitor/precedent research:\n${grounding.results.map((r) => `- ${r.title}: ${r.snippet}`).join("\n")}\n\n`
    : "";

  const text = await callAgent(env, agent, "validate",
    `${groundingText}Critique this idea from your lens:\nTitle: ${idea.title}\nProblem: ${idea.problem}\nSolution: ${idea.solution}\n\n` +
    `Respond with ONLY a JSON object: {"strength": string, "weakness": string, "suggestion": string}. All three fields are required, spec §4.`
  );

  const critique = extractJson<CritiqueJson>(text);
  if (!critique?.strength || !critique.weakness || !critique.suggestion) {
    throw new Error(`Malformed critique JSON from ${agent.id}: ${text.slice(0, 200)}`);
  }

  await critiqueIdea(env, { agentId: agent.id, eventId: item.event_id, ideaId, ...critique });
}

async function handleArchitecture(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const ideaId = requirePayloadField(item.payload, "ideaId", "architecture");

  const idea = await env.DB.prepare(`SELECT * FROM archive_ideas WHERE id = ?`).bind(ideaId).first<Record<string, unknown>>();
  if (!idea) throw new Error(`Idea not found: ${ideaId}`);

  const text = await callAgent(env, agent, "architecture",
    `Produce a build plan for this idea (spec §3.1 — Day 4-5 Architecture: tech stack, 3 components, top 2 risks, fallback scope), under 200 words:\n` +
    `Title: ${idea.title}\nProblem: ${idea.problem}\nSolution: ${idea.solution}\nBuild scope so far: ${idea.build_scope}`
  );

  await reviseIdea(env, { ideaId, agentId: agent.id, eventId: item.event_id, buildScope: text.slice(0, 4000) });
  await env.DB.prepare(`UPDATE archive_ideas SET status = 'architecture_complete' WHERE id = ?`).bind(ideaId).run();
}

interface IdeaForBuild {
  id: string; agent_id: string; title: string; one_liner: string;
  problem: string; solution: string; build_scope: string;
}

/**
 * Team formation — spec §3.2 Day 1: "Team formation, repo init. First build
 * turns begin same day." Not agent-scoped (item.agent_id is null for this
 * task type) — it acts on the hackathon event as a whole.
 *
 * Picks the top 2 ideas from the parent ideathon by real judge score (spec
 * §3.1: "7 judges evaluate all ideas and architectures. Top 2 advance.") —
 * requires the parent ideathon to already be status='judged' (Week 5's
 * judge_idea phase), not just architecture_complete. Before Week 5 this
 * used critique_count as a stand-in proxy; that's gone now that real scores
 * exist.
 */
async function handleTeamFormation(env: Env, item: QueueItem): Promise<void> {
  const event = await env.DB.prepare(`SELECT parent_event_id FROM archive_events WHERE id = ?`)
    .bind(item.event_id).first<{ parent_event_id: string | null }>();
  if (!event?.parent_event_id) throw new Error(`Hackathon event ${item.event_id} has no parent_event_id set`);

  const parent = await env.DB.prepare(`SELECT status FROM archive_events WHERE id = ?`)
    .bind(event.parent_event_id).first<{ status: string }>();
  if (parent?.status !== "judged") {
    throw new Error(`Parent ideathon ${event.parent_event_id} isn't judged yet (status=${parent?.status}) — can't pick advancing ideas without real judge scores`);
  }

  const top2 = await env.DB.prepare(
    `SELECT id, agent_id, title, one_liner, problem, solution, build_scope
     FROM archive_ideas WHERE event_id = ? AND status = 'judged'
     ORDER BY ideathon_score DESC LIMIT 2`
  ).bind(event.parent_event_id).all<IdeaForBuild>();

  if (top2.results.length === 0) throw new Error(`No judged ideas found for parent event ${event.parent_event_id}`);

  // Per-team idempotency (2026-07-22 hardening — see the retry-safety gap
  // flagged at Week 4 gate-pass): a prior team_formation attempt for this
  // same event may have already gotten one or both teams partway through.
  // 'forming' = repo created (createTeamRepo is itself idempotent, see
  // src/github/repos.ts) but the first build-turn dispatch isn't confirmed
  // yet; 'building' = dispatch confirmed, this team is fully done and a
  // retry should skip it entirely rather than fire a duplicate CI run.
  const teamNames: Array<"alpha" | "beta"> = ["alpha", "beta"];
  for (let i = 0; i < top2.results.length; i++) {
    const idea = top2.results[i];
    const teamName = teamNames[i];

    let team = await env.DB.prepare(
      `SELECT id, repo_url, status FROM hackathon_teams WHERE event_id = ? AND team_name = ?`
    ).bind(item.event_id, teamName).first<{ id: string; repo_url: string; status: string }>();

    if (team?.status === "building") continue; // already fully formed — idempotent no-op

    if (!team) {
      const repo = await createTeamRepo(env, teamName, item.event_id, {
        title: idea.title, oneLiner: idea.one_liner, problem: idea.problem, solution: idea.solution, buildScope: idea.build_scope,
      });
      const teamId = `team_${crypto.randomUUID()}`;
      // repo_url stores "owner/repo", not the html URL — that's what every
      // GitHub API call needs; the html URL is trivially derivable
      // (https://github.com/<repo_url>) whenever display needs it.
      await env.DB.prepare(
        `INSERT INTO hackathon_teams (id, event_id, idea_id, team_name, repo_url, status) VALUES (?, ?, ?, ?, ?, 'forming')`
      ).bind(teamId, item.event_id, idea.id, teamName, repo.fullName).run();
      team = { id: teamId, repo_url: repo.fullName, status: "forming" };
    }

    await dispatchBuildTurn(env, {
      repoFullName: team.repo_url, team: teamName, turnId: `${team.id}_turn1`,
      taskPrompt: `Build this from scratch: ${idea.title} — ${idea.one_liner}. Problem: ${idea.problem}. Solution: ${idea.solution}. Scope: ${idea.build_scope}`,
    });
    await env.DB.prepare(`UPDATE hackathon_teams SET status = 'building' WHERE id = ?`).bind(team.id).run();
  }
}

/** Subsequent daily build turns — spec §3.2 Day 2-3 "build turns continue." */
async function handleDispatchBuildTurn(env: Env, item: QueueItem): Promise<void> {
  const teamId = requirePayloadField(item.payload, "teamId", "dispatch_build_turn");

  const team = await env.DB.prepare(`SELECT * FROM hackathon_teams WHERE id = ?`)
    .bind(teamId).first<{ repo_url: string; team_name: "alpha" | "beta"; idea_id: string }>();
  if (!team) throw new Error(`Team not found: ${teamId}`);

  const idea = await env.DB.prepare(`SELECT title, build_scope FROM archive_ideas WHERE id = ?`)
    .bind(team.idea_id).first<{ title: string; build_scope: string }>();

  // countPayloadFieldMatches, not `payload LIKE '%"teamId":"..."%'` — D1
  // throws "LIKE or GLOB pattern too complex" on any pattern containing a
  // literal `"` (found live 2026-07-22, see payload-utils.ts).
  const completedDispatches = await env.DB.prepare(
    `SELECT payload FROM event_queue WHERE task_type = 'dispatch_build_turn' AND status = 'completed'`
  ).all<{ payload: string | null }>();
  const priorTurns = countPayloadFieldMatches(completedDispatches.results, "teamId", teamId);

  await dispatchBuildTurn(env, {
    repoFullName: team.repo_url, team: team.team_name,
    turnId: `${teamId}_turn${priorTurns + 2}`, // +2: turn 1 already happened on formation day
    taskPrompt: `Continue building "${idea?.title}". Review the existing code in this repo and continue implementing the remaining scope: ${idea?.build_scope}`,
  });
}

/** Ideathon judging — spec §13: all 7 judges score one architecture_complete idea. */
async function handleJudgeIdea(env: Env, item: QueueItem): Promise<void> {
  const ideaId = requirePayloadField(item.payload, "ideaId", "judge_idea");

  const idea = await env.DB.prepare(`SELECT * FROM archive_ideas WHERE id = ?`).bind(ideaId).first<Record<string, unknown>>();
  if (!idea) throw new Error(`Idea not found: ${ideaId}`);

  const prompt =
    `IDEA: ${idea.title}\nOne-liner: ${idea.one_liner}\nProblem: ${idea.problem}\n` +
    `Solution: ${idea.solution}\nBuild plan: ${idea.build_scope}`;
  const total = await scoreTarget(env, { eventId: item.event_id, targetType: "idea", targetId: ideaId, phase: "ideathon", prompt });

  await env.DB.prepare(`UPDATE archive_ideas SET ideathon_score = ?, status = 'judged' WHERE id = ?`).bind(total, ideaId).run();
}

/**
 * Hackathon judging — spec §13, weighted with the idea's ideathon score per
 * spec §3.2 ("Judging weights: Ideathon 30%, Hackathon 70%"). Grounds the
 * judges' prompt with real build-turn run outcomes (github/dispatch.ts) —
 * full diff review is Week 6 Observatory territory for humans, but pass/
 * fail counts across turns is real signal a judge LLM can use today.
 */
async function handleJudgeTeam(env: Env, item: QueueItem): Promise<void> {
  const teamId = requirePayloadField(item.payload, "teamId", "judge_team");

  const team = await env.DB.prepare(`SELECT id, idea_id, repo_url, team_name FROM hackathon_teams WHERE id = ?`)
    .bind(teamId).first<{ id: string; idea_id: string; repo_url: string; team_name: string }>();
  if (!team) throw new Error(`Team not found: ${teamId}`);

  const idea = await env.DB.prepare(`SELECT title, one_liner, problem, solution, build_scope, ideathon_score FROM archive_ideas WHERE id = ?`)
    .bind(team.idea_id).first<{ title: string; one_liner: string; problem: string; solution: string; build_scope: string; ideathon_score: number | null }>();

  const runs = await listBuildTurnRuns(env, team.repo_url, 10);
  const succeeded = runs.filter((r) => r.conclusion === "success").length;
  const failed = runs.filter((r) => r.conclusion === "failure").length;
  const runsSummary = runs.length
    ? `${runs.length} GitHub Actions build turns: ${succeeded} succeeded, ${failed} failed.`
    : "No build-turn run history available.";

  const prompt =
    `TEAM ${team.team_name} built: ${idea?.title} — ${idea?.one_liner}\nProblem: ${idea?.problem}\n` +
    `Original solution/plan: ${idea?.solution}\nBuild plan: ${idea?.build_scope}\n` +
    `Repo: https://github.com/${team.repo_url}\n${runsSummary}`;
  const hackathonTotal = await scoreTarget(env, { eventId: item.event_id, targetType: "team", targetId: teamId, phase: "hackathon", prompt });

  const ideathonScore = idea?.ideathon_score ?? 0;
  const finalScore = ideathonScore * 0.3 + hackathonTotal * 0.7; // spec §3.2 weights

  await env.DB.prepare(
    `UPDATE hackathon_teams SET hackathon_score = ?, final_score = ?, status = 'judged' WHERE id = ?`
  ).bind(hackathonTotal, finalScore, teamId).run();
}

async function handleTribunalReflectItem(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const event = await env.DB.prepare(`SELECT parent_event_id FROM archive_events WHERE id = ?`)
    .bind(item.event_id).first<{ parent_event_id: string | null }>();
  if (!event?.parent_event_id) throw new Error(`Hackathon event ${item.event_id} missing parent_event_id for tribunal`);
  await handleTribunalReflect(env, item.event_id, event.parent_event_id, agent);
}

async function handleTribunalCrossExamineItem(env: Env, item: QueueItem, agent: AgentRow): Promise<void> {
  const targetAgentId = requirePayloadField(item.payload, "targetAgentId", "tribunal_cross_examine");
  await handleTribunalCrossExamine(env, item.event_id, agent, targetAgentId);
}

// Default 3, not 5: found live (2026-07-22) that judge_idea/judge_team
// items each cost ~14 subrequests (7 parallel judge calls + 7 parallel
// DB inserts, scoring.ts's scoreTarget) — 5 of those in one batch hit
// Cloudflare's "Too many subrequests by single Worker invocation" limit
// partway through. 3 x 14 = 42, safely under it, and every other task
// type here is 1-3 subrequests so the throughput cost elsewhere is minor
// (the cron re-ticks every 5 minutes regardless).
export async function processQueue(env: Env, limit = 3): Promise<{ processed: number; failed: number }> {
  await resetStuckItems(env);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < limit; i++) {
    const item = await claimNext(env);
    if (!item) break;

    try {
      const agent = item.agent_id ? await getAgent(env, item.agent_id) : null;
      if (item.agent_id && !agent) throw new Error(`Unknown agent_id: ${item.agent_id}`);

      switch (item.task_type) {
        case "research": await handleResearch(env, item, agent!); break;
        case "submit_idea": await handleSubmitIdea(env, item, agent!); break;
        case "critique": await handleCritique(env, item, agent!); break;
        case "architecture": await handleArchitecture(env, item, agent!); break;
        case "team_formation": await handleTeamFormation(env, item); break;
        case "dispatch_build_turn": await handleDispatchBuildTurn(env, item); break;
        case "judge_idea": await handleJudgeIdea(env, item); break;
        case "judge_team": await handleJudgeTeam(env, item); break;
        case "tribunal_reflect": await handleTribunalReflectItem(env, item, agent!); break;
        case "tribunal_cross_examine": await handleTribunalCrossExamineItem(env, item, agent!); break;
        case "tribunal_synthesize": await handleTribunalSynthesize(env, item.event_id, agent!); break;
      }
      await markCompleted(env, item.id);
      processed++;
    } catch (err) {
      await markFailed(env, item.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return { processed, failed };
}
