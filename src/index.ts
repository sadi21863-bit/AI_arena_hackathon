/**
 * Worker entry point — spec §10.
 *
 * Week 2 scope adds the agent system's own routes (agents, ideas, critique)
 * on top of Week 0/1's health checks and inference passthrough. Still not
 * the full §10 table — /events/*, /archive/query, and /admin/* are later
 * weeks' scope per the roadmap (§17).
 */

import { routeInference, DAILY_CAPS, unitsUsedToday, type TaskType } from "./router";
import type { Env } from "./env";
import { requireAgentToken, requireAdminToken } from "./auth";
import { listAgents, getAgent, isAgentId, AGENTS } from "./agents/personas";
import { postIdea, critiqueIdea, type PostIdeaInput, type CritiqueInput } from "./agents/interactions";
import { recallMemory, queryArchive, type MemoryType } from "./agents/memory";
import { deepResearch, type DeepResearchInput } from "./agents/research";
import { ensurePhaseWorkQueued, ensureArenaCadence, checkForStalledEvents, reconcileAbandonedEvents, createEvent, MAX_ITEM_ATTEMPTS, type EventRow } from "./events/scheduler";
import { processQueue } from "./events/executor";
import { reconcileBuildTurns } from "./events/build-turns";
import { rosterFor } from "./events/team-members";
import { JUDGES } from "./judges/personas";
import { syncTeamHarness } from "./github/repos";
import { listBuildTurnRuns } from "./github/dispatch";

export type { Env };

// Every public GET route above exists specifically so the Observatory
// frontend (Cloudflare Pages, a DIFFERENT origin from this Worker) can
// render live data — found live (2026-07-23, Week 6): the Worker never set
// any CORS headers, so every one of those fetch() calls from the browser
// failed outright with a generic "Failed to fetch" (curl/PowerShell
// testing throughout this whole project never caught it, since CORS is a
// browser-enforced restriction, not a server-side one — it only breaks in
// an actual browser).
//
// Applied globally in the fetch wrapper below, to EVERY response including
// the /admin/* routes — this was previously (mis)documented as scoped to
// "already public/unauthenticated read data," which isn't accurate (found
// live, docs/INVESTIGATION_2026-07-28.md P2-6). `*` is still an acceptable
// choice here rather than scoping CORS per-route: CORS is a browser-enforced
// restriction on which ORIGINS can read a cross-origin response, not an
// authentication mechanism, and /admin/* is still gated by its own bearer
// token check (requireAdminToken) regardless of what CORS headers are on
// the response. Browsers don't auto-attach a bearer token the way they do
// cookies, so a wildcard origin here doesn't hand a malicious site anything
// it couldn't already get by knowing the token directly — at which point
// CORS is irrelevant either way.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Per-IP fixed-window rate limiter for the public endpoints that SPEND real
// budget: POST /archive/query and GET /agents/:id?recall= each make a Workers
// AI embedding call, charged to the same daily Neurons pool the event engine
// depends on (DAILY_CAPS["workers_ai"], shared with judging/Tribunal — see
// the gap analysis: nothing stopped a scripted loop from exhausting the
// day's pool and stalling Workers-AI-only event work). In-memory is fine
// here: the limiter only needs to throttle within a Worker instance's
// lifetime, and an eviction just resets a window, never blocks a user.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_MIN = 30;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function rateLimited(request: Request, maxPerWindow = RATE_LIMIT_MAX_PER_MIN): boolean {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    if (rateBuckets.size > 5000) {
      // Opportunistic prune — bounded Map, not a leak; only matters under
      // sustained heavy traffic, which is exactly when it'd be called.
      for (const [k, b] of rateBuckets) {
        if (now - b.windowStart >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
      }
    }
    return false;
  }
  bucket.count++;
  return bucket.count > maxPerWindow;
}

/**
 * Workers AI has ONE shared daily Neurons pool (router.ts's
 * DAILY_CAPS["workers_ai"]) that both the event engine and the public
 * embed-costing routes draw from. Public callers get a fast 503 when the
 * pool is exhausted instead of making the event's own work fail the embed.
 */
async function embedBudgetAvailable(env: Env): Promise<boolean> {
  return (await unitsUsedToday(env, "workers_ai")) < DAILY_CAPS["workers_ai"];
}

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
    // P2-8: Cloudflare Cron Triggers have no built-in retry/failure alerting
    // (project's own research notes flagged this), and the self-healing
    // queue below only covers work that reaches it — a tick that throws
    // before that point was previously invisible. Recording a heartbeat
    // every tick, success or failure, so GET /headroom can surface
    // staleness/errors instead of silence. Still re-throws after recording,
    // so Cloudflare's own dashboard/logs keep seeing the exception too —
    // this adds visibility, it doesn't swallow the error.
    try {
      // Self-heal first, before the drive loop: reverse abandonments that
      // were provably wrong (day-gated phase with no unfinished work — the
      // 2026-08-02 false-positive shape), so a revived event is picked up
      // by the loop below in this same tick. See reconcileAbandonedEvents
      // in scheduler.ts for the guards that keep this from resurrecting
      // genuinely dead events.
      await reconcileAbandonedEvents(env);

      // abandoned_at IS NULL: an event the stall watchdog (below) has given
      // up on shouldn't keep being handed to ensurePhaseWorkQueued/
      // processQueue every 5 minutes forever — there's nothing left to drive.
      const events = await env.DB.prepare(
        `SELECT * FROM archive_events
         WHERE abandoned_at IS NULL
           AND ((type = 'ideathon' AND status != 'judged')
             OR (type = 'hackathon' AND status != 'complete'))`
      ).all<EventRow>();

      for (const event of events.results) {
        await ensurePhaseWorkQueued(env, event);
        await processQueue(env);
      }

      // Spec §1 ("monthly autonomous AI competition"): the loop above only
      // drives events that already exist. This decides whether a new one
      // needs to be created -- see its own header comment in scheduler.ts.
      await ensureArenaCadence(env);

      // Stall watchdog (scheduler.ts) — the last-resort backstop that keeps
      // one wedged event from silently blocking every future Arena cycle
      // behind it forever, for a stall shape MAX_ITEM_ATTEMPTS didn't
      // anticipate. Runs after ensureArenaCadence, not before: an event that
      // just now crossed its completion threshold shouldn't be judged stale
      // in the same tick it finished.
      await checkForStalledEvents(env);

      await env.DB.prepare(
        `UPDATE cron_heartbeat SET last_tick_at = datetime('now'), last_success_at = datetime('now'), last_error = NULL WHERE id = 'singleton'`
      ).run();
    } catch (err) {
      await env.DB.prepare(
        `UPDATE cron_heartbeat SET last_tick_at = datetime('now'), last_error = ? WHERE id = 'singleton'`
      ).bind(err instanceof Error ? err.message : String(err)).run();
      throw err;
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
      // No JOIN against archive_ideas here (found live, 2026-07-30): an
      // earlier version of the event-scoped query used `JOIN archive_ideas i
      // ON x.target_id = i.id`, an INNER JOIN that silently dropped every
      // interaction whose target_id is an AGENT id, not an idea id —
      // form_alliance and propose_collaboration (N-1) rows. The unscoped
      // branch below never had that join and kept them, so scoping the graph
      // to one event was silently losing exactly the collaboration edges the
      // memory of adding N-1 called out as worth graphing. Nothing from `i`
      // was ever selected, so the join served no purpose the WHERE clause
      // doesn't already serve on its own.
      const edges = await (eventId
        ? env.DB.prepare(
            `SELECT actor_id, target_id, type, COUNT(*) as weight FROM archive_interactions
             WHERE event_id = ? AND actor_id IS NOT NULL
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
      // author and aggregate by (critic, author). Scoped to the same event
      // as the edges query above when one was requested — unscoped was a
      // full-table scan even for a single-event request, and it's also just
      // the wrong data: an idea's id from a different event can't collide in
      // practice, but there's no reason to pull every event's ideas to
      // resolve one event's edges.
      const ideaAuthors = await (eventId
        ? env.DB.prepare(`SELECT id, agent_id FROM archive_ideas WHERE event_id = ?`).bind(eventId)
        : env.DB.prepare(`SELECT id, agent_id FROM archive_ideas`)
      ).all<{ id: string; agent_id: string }>();
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
      // ?recall= is public (spec §10 lists the agent routes unauthenticated)
      // but it spends Workers AI Neurons from the shared daily pool, so it
      // is rate-limited per IP and fails soft when the pool is exhausted
      // (returns the profile without memory rather than spending the event
      // engine's budget on an external query).
      const recallQuery = url.searchParams.get("recall");
      const memory = recallQuery
        ? rateLimited(request) || !(await embedBudgetAvailable(env))
          ? undefined
          : await recallMemory(env, agentMatch[1], recallQuery.slice(0, 500))
        : undefined;
      const memoryUnavailable = !!recallQuery && memory === undefined;

      return Response.json({ ...agent, memory, memoryUnavailable });
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

      // P2-8: cron heartbeat, so a silently-broken scheduled() tick shows up
      // here instead of nowhere.
      const heartbeat = await env.DB.prepare(
        `SELECT last_tick_at, last_success_at, last_error FROM cron_heartbeat WHERE id = 'singleton'`
      ).first<{ last_tick_at: string | null; last_success_at: string | null; last_error: string | null }>();

      return Response.json({ day: today, usage: tiers, cron: heartbeat ?? null });
    }

    if (url.pathname === "/ideas" && request.method === "GET") {
      const eventId = url.searchParams.get("event_id");
      // Both branches capped now (found live, 2026-07-30): the event-scoped
      // branch had no LIMIT at all while the unscoped one did — an
      // inconsistency with no comment explaining it, not a deliberate
      // "single event needs everything" design choice the way /timeline's
      // full-replay does. 500 is pure headroom (one event has produced at
      // most ~40 ideas so far), not a functional cap on real usage.
      const query = eventId
        ? env.DB.prepare(`SELECT * FROM archive_ideas WHERE event_id = ? ORDER BY created_at DESC LIMIT 500`).bind(eventId)
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
      // Public, but each call embeds the query into Vectorize — Workers AI
      // Neurons charged to the same daily pool the event engine uses. Rate
      // limited per IP, and hard-fails when the pool is already exhausted so
      // an external script can't spend the event's budget for the day.
      if (rateLimited(request)) return Response.json({ error: "rate_limited" }, { status: 429 });
      if (!(await embedBudgetAvailable(env))) {
        return Response.json({ error: "workers_ai_daily_cap_exhausted" }, { status: 503 });
      }
      const body = await request.json<{ query: string; topK?: number; eventId?: string; agentId?: string; type?: MemoryType }>();
      if (!body.query) return Response.json({ error: "query is required" }, { status: 400 });
      // Length caps: embedding is token-costed, and there's no legitimate
      // use for a multi-KB query string or a topK that doubles as a scrape.
      if (body.query.length > 2000) return Response.json({ error: "query too long" }, { status: 400 });
      const topK = Math.min(body.topK ?? 10, 50);
      const results = await queryArchive(env, body.query, { agentId: body.agentId, eventId: body.eventId, type: body.type }, topK);
      return Response.json(results);
    }

    // Observatory event picker (Replay/Diff/Tribunal views all need "let
    // the user choose which event" — spec §10 lists per-id GET /events/{id}
    // but not a list route; added for Week 6's frontend, same public trust
    // level as everything else here). Optional ?type=ideathon|hackathon.
    if (url.pathname === "/events" && request.method === "GET") {
      const type = url.searchParams.get("type");
      // LEFT JOIN calibration_runs, not a separate per-row fetch: the single-
      // event route below already surfaces calibration.passed, but the LIST
      // route never did, so nothing that only calls GET /events (like the
      // Observatory Live view) could show a failed-calibration flag anywhere
      // a reader would see it (P2-7, docs/INVESTIGATION_2026-07-28.md).
      const events = await (type
        ? env.DB.prepare(
            `SELECT e.*, cr.correlation as calibration_correlation, cr.passed as calibration_passed
             FROM archive_events e LEFT JOIN calibration_runs cr ON cr.event_id = e.id
             WHERE e.type = ? ORDER BY e.created_at DESC LIMIT 20`
          ).bind(type)
        : env.DB.prepare(
            `SELECT e.*, cr.correlation as calibration_correlation, cr.passed as calibration_passed
             FROM archive_events e LEFT JOIN calibration_runs cr ON cr.event_id = e.id
             ORDER BY e.created_at DESC LIMIT 20`
          )
      ).all<Record<string, unknown>>();
      const withCalibration = events.results.map((row) => {
        const { calibration_correlation, calibration_passed, ...event } = row;
        return {
          ...event,
          calibration: calibration_correlation != null
            ? { correlation: calibration_correlation, passed: !!calibration_passed }
            : null,
        };
      });
      return Response.json(withCalibration);
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

    // Observatory Live view (spec §11): aggregate queue-item counts by status
    // for one event, so a "what's happening right now" view can show a
    // simple health meter without exposing individual queue payloads or
    // needing the admin token.
    const queueStatusMatch = url.pathname.match(/^\/events\/([^/]+)\/queue-status$/);
    if (queueStatusMatch && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT status, COUNT(*) as n FROM event_queue WHERE event_id = ? GROUP BY status`
      ).bind(queueStatusMatch[1]).all<{ status: string; n: number }>();
      const counts = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
      for (const row of rows.results) {
        if (row.status in counts) counts[row.status as keyof typeof counts] = row.n;
      }
      return Response.json(counts);
    }

    // Observatory Agent Office (spec §11): what each of the 12 agents is
    // doing right now, one representative queue row each, so the office
    // view can place a character at the desk matching its current task.
    //
    // Fetches this event's agent-scoped rows and reduces in JS rather than
    // trying to pick a per-agent winner in SQL — same reasoning as
    // payload-utils.ts's existing note about D1 query complexity, and the
    // row count here is bounded by one event's work.
    //
    // Only 7 of the 12 task types ever carry an agent_id at all
    // (research/submit_idea/critique/architecture/tribunal_*); the rest
    // (propose_collaboration, team_formation, dispatch_build_turn,
    // judge_idea, judge_team) are event- or team-level, and judges are a
    // separate roster entirely (judges/personas.ts) with no agent_id. So an
    // agent having no row is normal, not missing data — during a
    // hackathon's whole building phase, every agent legitimately has none.
    // Every agent is returned either way so the client never has to guess
    // whether a gap means "idle" or "not loaded yet".
    const agentActivityMatch = url.pathname.match(/^\/events\/([^/]+)\/agent-activity$/);
    if (agentActivityMatch && request.method === "GET") {
      // Failed rows ARE fetched now (P1, docs/OFFICE_INVESTIGATION_2026-07-31.md
      // G1). They are still never allowed to POSITION a character — the
      // original reasoning holds, a failed row would strand a sprite at a dead
      // task forever — but excluding them entirely meant the Office rendered
      // three different situations identically: an agent that never had work,
      // one that finished, and one the stall watchdog had permanently
      // abandoned. The watchdog (MAX_ITEM_ATTEMPTS) made that third state real
      // and permanent this week, so "looks idle" could now mean "the system
      // gave up on this agent" with nothing on screen to say so.
      const rows = await env.DB.prepare(
        `SELECT agent_id, task_type, status, claimed_at, completed_at, scheduled_for, error_message
         FROM event_queue WHERE event_id = ? AND agent_id IS NOT NULL`
      ).bind(agentActivityMatch[1]).all<{
        agent_id: string; task_type: string; status: string;
        claimed_at: string | null; completed_at: string | null; scheduled_for: string | null;
        error_message: string | null;
      }>();

      type Row = (typeof rows.results)[number];
      // A failed row is deliberately never representative — it would strand
      // a character at a dead task indefinitely; falling through to idle is
      // the more honest render. Failure is reported separately below instead.
      const RANK: Record<string, number> = { in_progress: 3, completed: 2, pending: 1 };
      const stamp = (r: Row) => r.claimed_at ?? r.completed_at ?? r.scheduled_for ?? "";

      const best = new Map<string, Row>();
      // Per (agent, task_type) failure tallies — the same grain the watchdog
      // counts at, so "abandoned" here means exactly what it means in
      // scheduler.ts rather than an approximation of it.
      const failsByAgentTask = new Map<string, number>();
      const failInfo = new Map<string, { count: number; lastError: string | null; taskType: string }>();
      const completedByAgentTask = new Set<string>();

      for (const row of rows.results) {
        const key = `${row.agent_id}|${row.task_type}`;
        if (row.status === "completed") completedByAgentTask.add(key);
        if (row.status === "failed") {
          const n = (failsByAgentTask.get(key) ?? 0) + 1;
          failsByAgentTask.set(key, n);
          const prev = failInfo.get(row.agent_id);
          // Keep whichever task_type this agent has failed most on — that is
          // the one blocking it, and the one worth naming in the UI.
          if (!prev || n > prev.count) {
            failInfo.set(row.agent_id, { count: n, lastError: row.error_message, taskType: row.task_type });
          }
          continue; // never eligible to be the representative row
        }
        const rank = RANK[row.status] ?? 0;
        if (rank === 0) continue;
        const current = best.get(row.agent_id);
        if (!current) { best.set(row.agent_id, row); continue; }
        const currentRank = RANK[current.status] ?? 0;
        if (rank > currentRank || (rank === currentRank && stamp(row) > stamp(current))) {
          best.set(row.agent_id, row);
        }
      }

      return Response.json(
        AGENTS.map((agent) => {
          const row = best.get(agent.id);
          const fail = failInfo.get(agent.id);
          return {
            agent_id: agent.id,
            name: agent.name,
            lens: agent.lens,
            task_type: row?.task_type ?? null,
            status: row?.status ?? null,
            updated_at: row ? stamp(row) : null,
            // P1. `abandoned` mirrors the watchdog exactly: at or past the cap
            // on some task_type, with nothing completed for that same
            // task_type — i.e. scheduler.ts has stopped retrying and will not
            // start again. `failed_attempts` is reported even below the cap so
            // the room can show an agent struggling before it is written off.
            failed_attempts: fail?.count ?? 0,
            failed_task_type: fail?.taskType ?? null,
            last_error: fail?.lastError ?? null,
            abandoned:
              !!fail &&
              fail.count >= MAX_ITEM_ATTEMPTS &&
              !completedByAgentTask.has(`${agent.id}|${fail.taskType}`),
          };
        })
      );
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

    // Observatory Ideas Board: judge_scores had no route at all until now
    // (found live, docs/INVESTIGATION_2026-07-28.md) — every judge's real
    // rationale for every score was readable only via direct D1 access.
    // Same public/no-auth trust level as timeline/teams above: read-only
    // aggregate data, no secrets.
    // Who is on which team and what they are responsible for. Public, same
    // tier as /teams — rosters are archive content, not secrets. Joined to
    // the static AGENTS roster so a client gets names and lenses without a
    // second call.
    const rosterMatch = url.pathname.match(/^\/events\/([^/]+)\/roster$/);
    if (rosterMatch && request.method === "GET") {
      const [members, teams] = await Promise.all([
        rosterFor(env, rosterMatch[1]),
        env.DB.prepare(`SELECT id, team_name, idea_id FROM hackathon_teams WHERE event_id = ?`)
          .bind(rosterMatch[1]).all<{ id: string; team_name: string; idea_id: string }>(),
      ]);
      const teamById = new Map(teams.results.map((t) => [t.id, t]));
      return Response.json(
        members.map((m) => {
          const agent = AGENTS.find((a) => a.id === m.agent_id);
          const team = teamById.get(m.team_id);
          return {
            team_id: m.team_id,
            team_name: team ? team.team_name : null,
            agent_id: m.agent_id,
            name: agent ? agent.name : m.agent_id,
            lens: agent ? agent.lens : null,
            membership: m.membership,
            build_role: m.build_role,
            turns_taken: m.turns_taken,
          };
        })
      );
    }

    // N-7: the Chronicler's per-phase commentary. Public, same tier as
    // /timeline and /teams — it is derived entirely from data already exposed
    // by those routes, just written for a reader instead of a parser.
    const chronicleMatch = url.pathname.match(/^\/events\/([^/]+)\/chronicle$/);
    if (chronicleMatch && request.method === "GET") {
      const entries = await env.DB.prepare(
        `SELECT phase, narrative, created_at FROM event_chronicle WHERE event_id = ? ORDER BY created_at ASC`
      ).bind(chronicleMatch[1]).all();
      return Response.json(entries.results);
    }

    // P3 (docs/OFFICE_INVESTIGATION_2026-07-31.md G3): what each agent has
    // actually PRODUCED, so the Office can show the work instead of a single
    // emoji. The room knew who was standing where and nothing about what was
    // being made — every comparable project renders the content, we rendered
    // 💡.
    //
    // Latest artefact of each kind per agent, resolved client-side against
    // whatever that agent is currently doing. Kept separate from
    // /agent-activity deliberately: that endpoint is the positioning data and
    // is polled on every tick, and it should stay a single cheap query rather
    // than growing three joins for something the room only displays on
    // hover.
    //
    // Text is truncated here, not in the browser: these are LLM outputs with
    // no length bound, and a speech bubble has no use for 4KB of prose.
    const artifactsMatch = url.pathname.match(/^\/events\/([^/]+)\/agent-artifacts$/);
    if (artifactsMatch && request.method === "GET") {
      const eventId = artifactsMatch[1];
      const CLIP = 240;
      const clip = (s: unknown) => {
        const text = typeof s === "string" ? s.trim() : "";
        return text.length > CLIP ? text.slice(0, CLIP - 1) + "…" : text;
      };

      const [ideas, critiques, reflections] = await Promise.all([
        env.DB.prepare(
          `SELECT id, agent_id, title, one_liner, status FROM archive_ideas
            WHERE event_id = ? ORDER BY created_at DESC LIMIT 100`
        ).bind(eventId).all<{ id: string; agent_id: string; title: string; one_liner: string; status: string }>(),
        // LEFT JOIN, not INNER: a critique whose target idea was merged away
        // (N-1) still says something real about the critic, and dropping it
        // would silently blank that agent's bubble.
        env.DB.prepare(
          `SELECT x.actor_id, x.content, i.title AS target_title
             FROM archive_interactions x
             LEFT JOIN archive_ideas i ON i.id = x.target_id
            WHERE x.event_id = ? AND x.type = 'critique'
            ORDER BY x.timestamp DESC LIMIT 200`
        ).bind(eventId).all<{ actor_id: string; content: string | null; target_title: string | null }>(),
        env.DB.prepare(
          `SELECT agent_id, reflection_type, content FROM tribunal_reflections
            WHERE event_id = ? ORDER BY created_at ASC LIMIT 100`
        ).bind(eventId).all<{ agent_id: string; reflection_type: string; content: string }>(),
      ]);

      const out: Record<string, Record<string, unknown>> = {};
      const slot = (agentId: string) => (out[agentId] ||= {});

      // Rows arrive newest-first, so the first one seen per agent wins.
      for (const idea of ideas.results) {
        const s = slot(idea.agent_id);
        if (!s.idea) s.idea = { id: idea.id, title: idea.title, one_liner: clip(idea.one_liner), status: idea.status };
      }
      for (const c of critiques.results) {
        if (!c.actor_id) continue;
        const s = slot(c.actor_id);
        if (s.critique) continue;
        // Stored as JSON by critiqueIdea; show the weakness, which is the
        // substantive half of a critique. Fall back to the raw string so a
        // malformed row degrades to something readable rather than nothing.
        let weakness = "";
        try { weakness = JSON.parse(c.content || "{}")?.weakness ?? ""; } catch { weakness = c.content || ""; }
        s.critique = { target_title: c.target_title, weakness: clip(weakness) };
      }
      // Reflections are ASC so the LAST wins — the Tribunal's three stages run
      // in order and the newest stage is the interesting one.
      for (const r of reflections.results) {
        slot(r.agent_id).reflection = { type: r.reflection_type, excerpt: clip(r.content) };
      }

      return Response.json(out);
    }

    // P2 (docs/OFFICE_INVESTIGATION_2026-07-31.md G2): the Agent Office needs
    // per-turn build state to show anything at all during a hackathon, when
    // building is team-level GitHub Actions work and no agent has a queue row.
    // The existing build-turn route is /admin/events/:id/build-status, which is
    // admin-gated because it POLLS the GitHub API on every call. This one only
    // reads the build_turns table the cron already reconciles, so it is public
    // and free — same trust tier as /teams and /roster.
    const buildTurnsMatch = url.pathname.match(/^\/events\/([^/]+)\/build-turns$/);
    if (buildTurnsMatch && request.method === "GET") {
      const turns = await env.DB.prepare(
        `SELECT turn_id, team_id, turn_number, status, conclusion, run_url, head_sha,
                dispatched_at, completed_at
           FROM build_turns WHERE event_id = ? ORDER BY turn_number ASC LIMIT 200`
      ).bind(buildTurnsMatch[1]).all();
      return Response.json(turns.results);
    }

    // P4 (docs/OFFICE_INVESTIGATION_2026-07-31.md G4): who is pairing up with
    // whom, and how it went.
    //
    // The one phase that is explicitly ABOUT agents interacting was the one
    // the room could not show, because `propose_collaboration` is an
    // event-level queue task with no agent_id — the pair is identified by two
    // IDEA ids in the payload, and nothing resolved those back to their
    // authors. Kai's whole persona is Team Facilitator and there was nothing
    // on screen to facilitate.
    //
    // Outcome is derived from what actually happened (the merge state and the
    // recorded interactions), not from the queue row's status: a completed
    // queue item only means the handler ran, and the agent is allowed to
    // refuse — refusal is a real spec outcome, not a failure.
    const collabMatch = url.pathname.match(/^\/events\/([^/]+)\/collaborations$/);
    if (collabMatch && request.method === "GET") {
      const eventId = collabMatch[1];

      const [queued, ideas, responses] = await Promise.all([
        env.DB.prepare(
          `SELECT payload, status FROM event_queue
            WHERE event_id = ? AND task_type = 'propose_collaboration'
            ORDER BY id ASC LIMIT 50`
        ).bind(eventId).all<{ payload: string | null; status: string }>(),
        env.DB.prepare(
          `SELECT id, agent_id, co_agent_id, title, status FROM archive_ideas WHERE event_id = ?`
        ).bind(eventId).all<{ id: string; agent_id: string; co_agent_id: string | null; title: string; status: string }>(),
        env.DB.prepare(
          `SELECT actor_id, target_id, type, content FROM archive_interactions
            WHERE event_id = ? AND type IN ('merge', 'collaboration_refused')
            ORDER BY timestamp ASC LIMIT 100`
        ).bind(eventId).all<{ actor_id: string; target_id: string; type: string; content: string | null }>(),
      ]);

      const ideaById = new Map(ideas.results.map((i) => [i.id, i]));
      const pairs = [];

      for (const row of queued.results) {
        let payload: { ideaA?: string; ideaB?: string; score?: number };
        try { payload = JSON.parse(row.payload || "{}"); } catch { continue; }
        const a = payload.ideaA && ideaById.get(payload.ideaA);
        const b = payload.ideaB && ideaById.get(payload.ideaB);
        if (!a || !b) continue;

        // The responder is ideaB's author, answering about ideaA (see
        // respondToCollaboration in agents/interactions.ts).
        const response = responses.results.find((r) => r.actor_id === b.agent_id && r.target_id === a.id);
        const accepted = a.co_agent_id === b.agent_id;
        const state = accepted ? "accepted"
          : response?.type === "collaboration_refused" ? "refused"
          : row.status === "failed" ? "failed"
          : "pending";

        pairs.push({
          state,
          score: typeof payload.score === "number" ? +payload.score.toFixed(3) : null,
          reason: response?.content ? String(response.content).slice(0, 300) : null,
          a: { idea_id: a.id, title: a.title, agent_id: a.agent_id, status: a.status },
          b: { idea_id: b.id, title: b.title, agent_id: b.agent_id, status: b.status },
        });
      }

      return Response.json(pairs);
    }

    // P5 (docs/OFFICE_INVESTIGATION_2026-07-31.md G5): the seven judges decide
    // which ideas advance and which team wins, and nothing anywhere exposed
    // them — not the roster, not their progress, not which model actually
    // answered. The Office could render a Judging Hall but had no occupants
    // to put in it.
    //
    // Everything the hall needs in one call: who the judges are, what each is
    // weighted at FOR THIS PHASE, how far through the field each one is, and
    // the model that actually produced their scores against the one pinned
    // for the event. That last comparison is the point — P0-2 exists because
    // a mid-event provider swap silently mixed model families into a single
    // weighted ranking, and this makes that visible rather than archaeology.
    const judgingMatch = url.pathname.match(/^\/events\/([^/]+)\/judging$/);
    if (judgingMatch && request.method === "GET") {
      const eventId = judgingMatch[1];
      const event = await env.DB.prepare(
        `SELECT type, status, judging_provider, judging_model FROM archive_events WHERE id = ?`
      ).bind(eventId).first<{ type: string; status: string; judging_provider: string | null; judging_model: string | null }>();
      if (!event) return Response.json({ error: "not_found" }, { status: 404 });

      const phase = event.type === "hackathon" ? "hackathon" : "ideathon";

      const [scores, calibration, targets] = await Promise.all([
        env.DB.prepare(
          `SELECT judge_name, criterion, weight, target_id, score, rationale, provider, model_id
             FROM judge_scores WHERE event_id = ? AND phase = ?`
        ).bind(eventId, phase).all<{
          judge_name: string; criterion: string; weight: number; target_id: string;
          score: number; rationale: string | null; provider: string | null; model_id: string | null;
        }>(),
        env.DB.prepare(`SELECT correlation, passed FROM calibration_runs WHERE event_id = ?`)
          .bind(eventId).first<{ correlation: number; passed: number }>(),
        // What the judges are being asked to score. An ideathon judges the
        // ideas that reached architecture_complete (they read 'judged' once
        // done, so both states count); a hackathon judges its teams.
        phase === "hackathon"
          ? env.DB.prepare(`SELECT COUNT(*) AS n FROM hackathon_teams WHERE event_id = ?`).bind(eventId).first<{ n: number }>()
          : env.DB.prepare(
              `SELECT COUNT(*) AS n FROM archive_ideas WHERE event_id = ? AND status IN ('architecture_complete','judged')`
            ).bind(eventId).first<{ n: number }>(),
      ]);

      const expected = targets?.n ?? 0;
      const byJudge = new Map<string, typeof scores.results>();
      for (const row of scores.results) {
        const list = byJudge.get(row.judge_name) ?? [];
        list.push(row);
        byJudge.set(row.judge_name, list);
      }

      const judges = JUDGES.map((j) => {
        const rows = byJudge.get(j.name) ?? [];
        const scored = new Set(rows.map((r) => r.target_id)).size;
        const models = [...new Set(rows.map((r) => `${r.provider ?? "?"}:${r.model_id ?? "?"}`))];
        const latest = rows[rows.length - 1];
        return {
          name: j.name,
          criterion: j.criterion,
          weight: phase === "hackathon" ? j.hackathonWeight : j.ideathonWeight,
          scored,
          expected,
          // Rows predating the P0-2 migration have no provider/model at all —
          // reported as unknown rather than silently counted as agreeing with
          // the pin, since "we don't know" and "it matched" are different.
          models,
          // True only when this judge demonstrably used something other than
          // the model pinned for the event. Unknowns are excluded on purpose.
          modelDeviates:
            !!event.judging_model &&
            models.some((m) => m !== "?:?" && !m.endsWith(`:${event.judging_model}`)),
          averageScore: rows.length ? +(rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(2) : null,
          latestRationale: latest?.rationale ? String(latest.rationale).slice(0, 400) : null,
        };
      });

      return Response.json({
        phase,
        status: event.status,
        pinned: { provider: event.judging_provider, model: event.judging_model },
        calibration: calibration ? { correlation: calibration.correlation, passed: !!calibration.passed } : null,
        expected,
        judges,
      });
    }

    const judgeScoresMatch = url.pathname.match(/^\/events\/([^/]+)\/judge-scores$/);
    if (judgeScoresMatch && request.method === "GET") {
      const scores = await env.DB.prepare(
        `SELECT judge_name, criterion, weight, target_type, target_id, phase, score, rationale, provider, model_id
         FROM judge_scores WHERE event_id = ?`
      ).bind(judgeScoresMatch[1]).all();
      return Response.json(scores.results);
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
      const id = await createEvent(env, body.type, body.parentEventId ?? null);
      return Response.json({ id }, { status: 201 });
    }

    // Week 7 closed-beta test tooling (spec §17): phase transitions are real
    // calendar-day math (scheduler.ts daysElapsed/phaseForDay) with no
    // test-mode flag — deliberately not adding one, since that would mean
    // the beta exercises different code than production. This lets the
    // event's start_date be backdated instead, so the same unmodified
    // production day-math thinks days have passed; the actual work (LLM
    // calls, real repos, real judging) stays 100% real, only the calendar
    // input is fast-forwarded. Same admin-token auth class as the other
    // /admin/events routes.
    const startDateMatch = url.pathname.match(/^\/admin\/events\/([^/]+)\/start-date$/);
    if (startDateMatch && request.method === "PATCH") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = await request.json<{ startDate: string }>();
      if (!body.startDate) return Response.json({ error: "startDate required" }, { status: 400 });
      const result = await env.DB.prepare(`UPDATE archive_events SET start_date = ? WHERE id = ?`).bind(body.startDate, startDateMatch[1]).run();
      if (result.meta.changes === 0) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ id: startDateMatch[1], startDate: body.startDate });
    }

    // Test-event cleanup — reusable tooling, same class as start-date above,
    // not single-use. Only deletes events with zero real ideas/teams (a
    // genuine hackathon or ideathon that produced real work can't be
    // deleted through this route at all, by design) so this can't become a
    // way to destroy a real event's data, only scaffolding created for
    // verification that never got populated.
    const deleteEventMatch = url.pathname.match(/^\/admin\/events\/([^/]+)$/);
    if (deleteEventMatch && request.method === "DELETE") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const eventId = deleteEventMatch[1];
      const [ideaCount, teamCount] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) as n FROM archive_ideas WHERE event_id = ?`).bind(eventId).first<{ n: number }>(),
        env.DB.prepare(`SELECT COUNT(*) as n FROM hackathon_teams WHERE event_id = ?`).bind(eventId).first<{ n: number }>(),
      ]);
      if ((ideaCount?.n ?? 0) > 0 || (teamCount?.n ?? 0) > 0) {
        return Response.json({ error: "event has real ideas or teams — refusing to delete" }, { status: 409 });
      }
      const result = await env.DB.batch([
        env.DB.prepare(`DELETE FROM event_queue WHERE event_id = ?`).bind(eventId),
        env.DB.prepare(`DELETE FROM archive_events WHERE id = ?`).bind(eventId),
      ]);
      if (result[1].meta.changes === 0) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ deleted: eventId });
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

    // Pull CI outcomes for open build turns without running a full tick.
    // A tick would also DISPATCH new turns (real Actions minutes, real
    // inference spend), so reconciliation needs its own trigger to be
    // verifiable and operable on its own. Same auth class as the ticks.
    const reconcileMatch = url.pathname.match(/^\/admin\/events\/([^/]+)\/reconcile-build-turns$/);
    if (reconcileMatch && request.method === "POST") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const updated = await reconcileBuildTurns(env, reconcileMatch[1]);
      const rows = await env.DB.prepare(
        `SELECT turn_id, team_id, turn_number, status, conclusion, run_url, head_sha
         FROM build_turns WHERE event_id = ? ORDER BY turn_number`
      ).bind(reconcileMatch[1]).all();
      return Response.json({ updated, turns: rows.results });
    }

    // Bring an event's team repos back in line with the main repo's build
    // harness, without waiting for a dispatch to do it.
    //
    // The sync itself rides on dispatch, which is right for normal operation —
    // but a hackathon that has stopped dispatching (capped out, or past the
    // building phase) would never pick up a harness fix, and a repo whose
    // workflow mis-records its own results is worth correcting even when no
    // more turns will run. Same auth class as the other /admin/events routes.
    const syncHarnessMatch = url.pathname.match(/^\/admin\/events\/([^/]+)\/sync-harness$/);
    if (syncHarnessMatch && request.method === "POST") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      const teams = await env.DB.prepare(`SELECT id, team_name, repo_url FROM hackathon_teams WHERE event_id = ?`)
        .bind(syncHarnessMatch[1]).all<{ id: string; team_name: string; repo_url: string }>();

      const results = [];
      for (const team of teams.results) {
        try {
          results.push({ team: team.team_name, repo: team.repo_url, updated: await syncTeamHarness(env, team.repo_url) });
        } catch (err) {
          results.push({ team: team.team_name, repo: team.repo_url, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return Response.json({ teams: results });
    }

    // Manual trigger for ensureArenaCadence (scheduler.ts) -- lets the
    // auto-create-next-hackathon / auto-create-next-ideathon logic be
    // verified without waiting for the real monthly calendar gate or the
    // 5-minute cron. Same auth class as /admin/events/:id/tick above.
    if (url.pathname === "/admin/cadence/tick" && request.method === "POST") {
      if (!(await requireAdminToken(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      await ensureArenaCadence(env);
      await checkForStalledEvents(env);
      return Response.json({ ok: true });
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
