/**
 * Worker entry point — spec §10.
 *
 * This is a Week 0/1 stub, not the full API. It exists so `wrangler dev`
 * has something real to load and so `routeInference` (src/router.ts) has a
 * wired-up caller to test against once the inference_pool gate passes.
 * Building out the rest of the routes in spec §10's table is Week 1 scope
 * per the roadmap (§17) — don't treat this file as complete.
 */

import { routeInference, type Env, type TaskType } from "./router";

export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    return new Response("Not found", { status: 404 });
  },
};
