/**
 * Worker entry point — spec §10.
 *
 * Week 2 scope adds the agent system's own routes (agents, ideas, critique)
 * on top of Week 0/1's health checks and inference passthrough. Still not
 * the full §10 table — /events/*, /archive/query, and /admin/* are later
 * weeks' scope per the roadmap (§17).
 */

import { routeInference, DAILY_CAPS, type TaskType } from "./router";
import type { Env } from "./env";
import { requireAgentToken, requireAdminToken } from "./auth";
import { listAgents, getAgent, isAgentId } from "./agents/personas";
import { postIdea, critiqueIdea, type PostIdeaInput, type CritiqueInput } from "./agents/interactions";
import { recallMemory, queryArchive, type MemoryType } from "./agents/memory";
import { deepResearch, type DeepResearchInput } from "./agents/research";
import { ensurePhaseWorkQueued, type EventRow } from "./events/scheduler";
import { processQueue } from "./events/executor";
import { listBuildTurnRuns } from "./github/dispatch";

export type { Env };

// Every public GET route above exists specifically so the Observatory
// frontend (Cloudflare Pages, a DIFFERENT origin from this Worker) can
// render live data — found live (2026-07-23, Week 6): the Worker never set
// any CORS headers, so every one of those fetch() calls from the browser
// failed outright with a generic "Failed to fetch" (curl/PowerShell
// testing throughout this whole project never caught it, since CORS is a
// browser-enforced restriction, not a server-side one — it only breaks in
// an actual browser). `*` rather than a specific origin: every route this
// applies to is already public/unauthenticated read data, so there's
// nothing a wildcard origin exposes that a direct curl request couldn't
// already read.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const response = await handleRequest(request, env);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  /**
   * spec §17's "event engine" — periodically checks every non-terminal
   * event's phase and drains a batch of due work. Self-healing (ported
   * from ideaconnect's ensureDailyWorkQueued precedent): idempotent per
   * phase, so a missed or overlapping tick never stalls or duplicates work.
   *
   * Terminal status is type-dependent, not a shared status string: an
   * ideathon is done at 'judged' (spec §3.1), but a hackathon's 'judged' is
   * a MID-point — judged -> tribunal -> complete (spec §3.2/§14) — so a
   * blanket status exclusion would silently stop every hackathon right at
   * judging, before Tribunal ever runs. 'ready_for_judging' used to be
   * excluded here too (Week 3, back when nothing happened past it); Week
   * 5's judging/Tribunal work all runs FROM that status now.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const events = await env.DB.prepare(
      `SELECT * FROM archive_events
       WHERE (type = 'ideathon' AND status != 'judged')
          OR (type = 'hackathon' AND status != 'complete')`
    ).all<EventRow>();

    for (const event of events.results) {
      await ensurePhaseWorkQueued(env, event);
      await processQueue(env);
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", spec_version: "8.0" });
    }

    // Week 0 smoke-test route for the inference_pool gate, per spec §10's
    // "Agent token" auth requirement — found live (2026-07-22 code review):
    // this had been left unauthenticated since Week 0, letting anyone
    // exhaust the shared daily Groq/Workers-AI budget a real event depends
    // on. Auth added; route otherwise unchanged.
    if (url.pathname === "/inference" && request.method === "POST") {
      if (!requireAgentToken(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = await request.json<{ task_type: TaskType; prompt: string }>();
      const result = await routeInference(env, { task_type: body.task_type, prompt: body.prompt });
      if (!result) {
        return Response.json({ error: "all_tiers_exhausted_or_failed" }, { status: 503 });
      }
      return Response.json(result);
    }

    if (url.pathname === "/agents" && request.method === "GET") {
      return Response.json(await listAgents(env));
    }

    // Observatory Agent Graph (spec §11: "relationship visualization").
    // Public — real archive_interactions edges (critiques, collaborations),
    // not the semantic-text Vectorize index /archive/query hits. Optional
    // ?event_id= scopes to one event; unscoped returns the whole archive's
    // relationship graph, matching spec's "queryable... across all events"
    // vision (§15). Placed BEFORE the /agents/:id pattern below — that
    // regex matches any single path segment, so "/agents/graph" was being
    // swallowed as a lookup for an agent literally named "graph" (found
    // live, 2026-07-23: returned 404 not_found instead of ever reaching
    // this handler).
    if (url.pathname === "/agents/graph" && request.method === "GET") {
      const eventId = url.searchParams.get("event_id");
      const edges = await (eventId
        ? env.DB.prepare(
            `SELECT actor_id, target_id, type, COUNT(*) as weight FROM archive_interactions x
             JOIN archive_ideas i ON x.target_id = i.id
             WHERE x.event_id = ? AND x.actor_id IS NOT NULL
             GROUP BY actor_id, target_id, type`
          ).bind(eventId)
        : env.DB.prepare(
            `SELECT actor_id, target_id, type, COUNT(*) as weight FROM archive_interactions
             WHERE actor_id IS NOT NULL GROUP BY actor_id, target_id, type`
          )
      ).all<{ actor_id: string; target_id: string; type: string; weight: number }>();

      // Fold per-idea critique edges into agent-to-agent edges (target_id is
      // an idea id, not an agent id, in archive_interactions) — the graph
      // is agent relationships, so resolve each critiqued idea back to its
      // author and aggregate by (critic, author).
      const ideaAuthors = await env.DB.prepare(`SELECT id, agent_id FROM archive_ideas`).all<{ id: string; agent_id: string }>();
      const authorById = new Map(ideaAuthors.results.map((i) => [i.id, i.agent_id]));

      const agentEdges = new Map<string, { source: string; target: string; type: string; weight: number }>();
      for (const e of edges.results) {
        const targetAgent = authorById.get(e.target_id) ?? e.target_id; // form_alliance/propose_collaboration target IS an agent id already
        if (!targetAgent || targetAgent === e.actor_id) continue; // no self-loops
        const key = `${e.actor_id}|${targetAgent}|${e.type}`;
        const existing = agentEdges.get(key);
        agentEdges.set(key, { source: e.actor_id, target: targetAgent, type: e.type, weight: (existing?.weight ?? 0) + e.weight });
      }

      return Response.json({ nodes: await listAgents(env), edges: [...agentEdges.values()] });
    }

    const agentMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
    if (agentMatch && request.method === "GET") {
      const agent = await getAgent(env, agentMatch[1]);
      if (!agent) return Response.json({ error: "not_found" }, { status: 404 });

      // spec §10: GET /agents/{id} is "Agent profile + memory" — ?recall=
      // is optional since embedding a query costs an AI call every request.
      const recallQuery = url.searchParams.get("recall");
      const memory = recallQuery ? await recallMemory(env, agentMatch[1], recallQuery) : undefined;

      return Response.json({ ...agent, memory });
    }

    // Observatory Headroom Dashboard (spec §11: "live provider usage
    // against daily caps"). Public — aggregate usage numbers only, no
    // secrets, no reason to gate this behind admin auth the way spec's
    // /admin/metrics is for the fuller admin view.
    if (url.pathname === "/headroom" && request.method === "GET") {
      const today = new Date().toISOString().slice(0, 10);
      const usage = await env.DB.prepare(
        `SELECT provider, model_id, SUM(units_used) as used FROM provider_usage_log WHERE day = ? GROUP BY provider, model_id`
      ).bind(today).all<{ provider: string; model_id: string; used: number }>();
      const usedByGroqModel = new Map(usage.results.filter((r) => r.provider === "groq").map((r) => [r.model_id, r.used]));
      // workers_ai's cap is one pool SHARED across all its models (router.ts),
      // so usage sums across every workers_ai row, not a per-model lookup.
      const workersAiUsed = usage.results.filter((r) => r.provider === "workers_ai").reduce((sum, r) => sum + r.used, 0);

      // Iterate DAILY_CAPS (router.ts's single source of truth), not the
      // usage query results — a model with zero calls today should still
      // show as "full headroom," not be silently absent from the dashboard.
      const tiers = Object.entries(DAILY_CAPS).map(([key, cap]) => {
        if (key === "workers_ai") {
          return { provider: "workers_ai", model_id: "(shared across all Workers AI models)", cap, used: workersAiUsed };
        }
        const model = key.slice("groq:".length);
        return { provider: "groq", model_id: model, cap, used: usedByGroqModel.get(model) ?? 0 };
      });
      return Response.json({ day: today, usage: tiers });
    }

    if (url.pathname === "/ideas" && request.method === "GET") {
      const eventId = url.searchParams.get("event_id");
      const query = eventId
        ? env.DB.prepare(`SELECT * FROM archive_ideas WHERE event_id = ? ORDER BY created_at DESC`).bind(eventId)
        : env.DB.prepare(`SELECT * FROM archive_ideas ORDER BY created_at DESC LIMIT 100`);
      const result = await query.all();
      return Response.json(result.results);
    }

    if (url.pathname === "/ideas" && request.method === "POST") {
      if (!requireAgentToken(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = await request.json<PostIdeaInput>();
      if (!isAgentId(body.agentId)) return Response.json({ error: "unknown_agent_id" }, { status: 400 });
      const id = await postIdea(env, body);
      return Response.json({ id }, { status: 201 });
    }

    const critiqueMatch = url.pathname.match(/^\/ideas\/([^/]+)\/critique$/);
    if (critiqueMatch && request.method === "POST") {
      if (!requireAgentToken(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = await request.json<Omit<CritiqueInput, "ideaId">>();
      if (!isAgentId(body.agentId)) return Response.json({ error: "unknown_agent_id" }, { status: 400 });
      const id = await critiqueIdea(env, { ...body, ideaId: critiqueMatch[1] });
      return Response.json({ id }, { status: 201 });
    }

    // Not in spec §10's API table — Deep Research (§3.1) is meant to be
    // triggered internally by the Week 3 event engine, which can just call
    // deepResearch() directly since it's the same Worker. This route exists
    // for verification and manual triggering, gated the same as the other
    // agent-write routes.
    if (url.pathname === "/research" && request.method === "POST") {
      if (!requireAgentToken(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = await request.json<DeepResearchInput>();
      if (!isAgentId(body.agentId)) return Response.json({ error: "unknown_agent_id" }, { status: 400 });
      const result = await deepResearch(env, body);
      return Response.json(result);
    }

    // spec §10/§15: "Semantic archive search (Vectorize)." Public — same
    // Vectorize index every idea/critique/reflection already gets embedded
    // into (Week 2 agent memory, Week 5 tribunal reflections), just without
    // recallMemory's mandatory agent_id scoping.
    if (url.pathname === "/archive/query" && request.method === "POST") {
      const body = await request.json<{ query: string; topK?: number; eventId?: string; agentId?: string; type?: MemoryType }>();
      if (!body.query) return Response.json({ error: "query is required" }, { status: 400 });
      const results = await queryArchive(env, body.query, { agentId: body.agentId, eventId: body.eventId, type: body.type }, body.topK ?? 10);
      return Response.json(results);
    }

    // Observatory event picker (Replay/Diff/Tribunal views all need "let
    // the user choose which event" — spec §10 lists per-id GET /events/{id}
    // but not a list route; added for Week 6's frontend, same public trust
    // level as everything else here). Optional ?type=ideathon|hackathon.
    if (url.pathname === "/events" && request.method === "GET") {
      const type = url.searchParams.get("type");
      const events = await (type
        ? env.DB.prepare(`SELECT * FROM archive_events WHERE type = ? ORDER BY created_at DESC LIMIT 20`).bind(type)
        : env.DB.prepare(`SELECT * FROM archive_events ORDER BY created_at DESC LIMIT 20`)
      ).all();
      return Response.json(events.results);
    }

    const eventMatch = url.pathname.match(/^\/events\/([^/]+)$/);
    if (eventMatch && request.method === "GET") {
      const event = await env.DB.prepare(`SELECT * FROM archive_events WHERE id = ?`).bind(eventMatch[1]).first<{ type: string }>();
      if (!event) return Response.json({ error: "not_found" }, { status: 404 });
      // Surfaces calibration's pass/fail (spec §13/§16) — found live
      // (2026-07-22 code review) that this was computed and stored but
      // never exposed anywhere, defeating the point of the check.
      const calibration = event.type === "ideathon"
        ? await env.DB.prepare(`SELECT correlation, passed FROM calibration_runs WHERE event_id = ?`).bind(eventMatch[1]).first<{ correlation: number; passed: number }>()
        : null;
      return Response.json({ ...event, calibration: calibration ? { correlation: calibration.correlation, passed: !!calibration.passed } : null });
    }

    // Observatory Tribunal Report (spec §11/§14). Public — reflections are
    // already agent-authored public archive content, same trust level as
    // ideas/critiques elsewhere in this API.
    const tribunalMatch = url.pathname.match(/^\/events\/([^/]+)\/tribunal$/);
    if (tribunalMatch && request.method === "GET") {
      const reflections = await env.DB.prepare(
        `SELECT id, agent_id, reflection_type, target_agent_id, content, created_at FROM tribunal_reflections WHERE event_id = ? ORDER BY created_at ASC`
      ).bind(tribunalMatch[1]).all();
      return Response.json(reflections.results);
    }

    // Observatory Replay Player (spec §11) — chronological interaction
    // timeline for one event: ideas submitted + every interaction on them,
    // in the order they actually happened.
    const timelineMatch = url.pathname.match(/^\/events\/([^/]+)\/timeline$/);
    if (timelineMatch && request.method === "GET") {
      const ideas = await env.DB.prepare(
        `SELECT id, agent_id, title, one_liner, status, ideathon_score, created_at as ts, 'idea' as kind FROM archive_ideas WHERE event_id = ?`
      ).bind(timelineMatch[1]).all();
      const interactions = await env.DB.prepare(
        `SELECT id, actor_id, target_id, type, content, timestamp as ts FROM archive_interactions WHERE event_id = ? ORDER BY timestamp ASC`
      ).bind(timelineMatch[1]).all();
      const merged = [...ideas.results, ...interactions.results].sort((a: any, b: any) => String(a.ts).localeCompare(String(b.ts)));
      return Response.json(merged);
    }

    // Observatory Diff Viewer (spec §11) needs each team's repo_url to pull
    // real commits from GitHub's public API client-side. The existing
    // per-team data lives behind /admin/events/:id/build-status (admin-
    // gated, since it also polls GitHub Actions run status on every call) —
    // this is a lighter, public-safe subset: just id/name/repo/status, no
    // GitHub API calls made server-side.
    const teamsMatch = url.pathname.match(/^\/events\/([^/]+)\/teams$/);
    if (teamsMatch && request.method === "GET") {
      const teams = await env.DB.prepare(
        `SELECT id, team_name, repo_url, status, idea_id, hackathon_score, final_score FROM hackathon_teams WHERE event_id = ?`
      ).bind(teamsMatch[1]).all();
      return Response.json(teams.results);
    }

    // spec §7.1: bearer-token, hashed, admin-only. Not in spec §10's table
    // as written (it lists /admin/models, /admin/trigger-build,
    // /admin/metrics — none of which is "start an event"), but the event
    // engine needs some way to create one, and this is the same auth class.
    if (url.pathname === "/admin/events" && request.method === "POST") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = await request.json<{ type: "ideathon" | "hackathon"; parentEventId?: string }>();
      if (body.type === "hackathon" && !body.parentEventId) {
        return Response.json({ error: "hackathon events require parentEventId (the ideathon it advanced from)" }, { status: 400 });
      }
      const id = `event_${crypto.randomUUID()}`;
      const initialStatus = body.type === "hackathon" ? "team_formation" : "deep_research";
      await env.DB.prepare(
        `INSERT INTO archive_events (id, type, start_date, status, parent_event_id, created_at) VALUES (?, ?, datetime('now'), ?, ?, datetime('now'))`
      ).bind(id, body.type, initialStatus, body.parentEventId ?? null).run();
      return Response.json({ id }, { status: 201 });
    }

    // Manual trigger for the same work the cron handler (scheduled()) does
    // automatically — lets phase advancement + queue draining be verified
    // and debugged without waiting for the real schedule.
    const tickMatch = url.pathname.match(/^\/admin\/events\/([^/]+)\/tick$/);
    if (tickMatch && request.method === "POST") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const event = await env.DB.prepare(`SELECT * FROM archive_events WHERE id = ?`).bind(tickMatch[1]).first<EventRow>();
      if (!event) return Response.json({ error: "not_found" }, { status: 404 });
      const phase = await ensurePhaseWorkQueued(env, event);
      const result = await processQueue(env);
      return Response.json({ phase, ...result });
    }

    // Observatory build view (spec §11): "polls GitHub Actions job status
    // and log artifacts per turn rather than holding a live connection to
    // a container." Reports every team's recent runs for a hackathon event.
    const buildStatusMatch = url.pathname.match(/^\/admin\/events\/([^/]+)\/build-status$/);
    if (buildStatusMatch && request.method === "GET") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const teams = await env.DB.prepare(`SELECT id, team_name, repo_url, status FROM hackathon_teams WHERE event_id = ?`)
        .bind(buildStatusMatch[1]).all<{ id: string; team_name: string; repo_url: string; status: string }>();

      const results = await Promise.all(teams.results.map(async (team) => ({
        teamId: team.id,
        teamName: team.team_name,
        repo: team.repo_url,
        status: team.status,
        runs: await listBuildTurnRuns(env, team.repo_url, 5),
      })));

      return Response.json(results);
    }

    return new Response("Not found", { status: 404 });
}
