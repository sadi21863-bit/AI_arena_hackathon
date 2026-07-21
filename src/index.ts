/**
 * Worker entry point — spec §10.
 *
 * Week 2 scope adds the agent system's own routes (agents, ideas, critique)
 * on top of Week 0/1's health checks and inference passthrough. Still not
 * the full §10 table — /events/*, /archive/query, and /admin/* are later
 * weeks' scope per the roadmap (§17).
 */

import { routeInference, type TaskType } from "./router";
import type { Env } from "./env";
import { requireAgentToken, requireAdminToken } from "./auth";
import { listAgents, getAgent, isAgentId } from "./agents/personas";
import { postIdea, critiqueIdea, type PostIdeaInput, type CritiqueInput } from "./agents/interactions";
import { recallMemory } from "./agents/memory";
import { deepResearch, type DeepResearchInput } from "./agents/research";
import { ensurePhaseWorkQueued, type EventRow } from "./events/scheduler";
import { processQueue } from "./events/executor";
import { listBuildTurnRuns } from "./github/dispatch";

export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", spec_version: "8.0" });
    }

    // Minimal smoke-test route for the Week 0 inference_pool gate — NOT the
    // real /inference route from spec §10, which needs agent-token auth and
    // proper request validation before this leaves Week 0.
    if (url.pathname === "/inference" && request.method === "POST") {
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

    const eventMatch = url.pathname.match(/^\/events\/([^/]+)$/);
    if (eventMatch && request.method === "GET") {
      const event = await env.DB.prepare(`SELECT * FROM archive_events WHERE id = ?`).bind(eventMatch[1]).first();
      if (!event) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(event);
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
      const result = await processQueue(env, 5);
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
  },

  /**
   * spec §17's "event engine" — periodically checks every non-terminal
   * event's phase and drains a batch of due work. Self-healing (ported
   * from ideaconnect's ensureDailyWorkQueued precedent): idempotent per
   * phase, so a missed or overlapping tick never stalls or duplicates work.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const events = await env.DB.prepare(
      `SELECT * FROM archive_events WHERE status NOT IN ('ready_for_judging', 'complete')`
    ).all<EventRow>();

    for (const event of events.results) {
      await ensurePhaseWorkQueued(env, event);
      await processQueue(env, 5);
    }
  },
};
