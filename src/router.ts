/**
 * Inference router — spec §6.
 *
 * Two providers, load split between them: Groq first, Cloudflare Workers AI
 * second. Lives directly in the Cloudflare Worker — no separate service, no
 * VM.
 */

export type TaskType =
  | "code_generation" | "architecture" | "research" | "judging"
  | "summarize" | "validate" | "design" | "test" | "reflect";

interface InferenceRequest {
  task_type: TaskType;
  prompt: string;
  max_tokens?: number;
  // Skips the normal Groq->Workers AI cascade and only tries this one
  // provider, returning null (not falling through) if it's unavailable —
  // see judges/scoring.ts and judges/calibration.ts (spec §13 P0-2: pin the
  // judging model for an event so it can't silently swap mid-event).
  pinned_provider?: "groq" | "workers_ai";
}

import type { Env } from "./env";

// Task -> candidate model per provider, from spec §5. Kept explicit rather
// than derived, so a model swap is a one-line change here, not a
// scoring-function debugging session.
const TASK_MODELS: Record<TaskType, { groq?: string; workers_ai?: string }> = {
  summarize: { groq: "llama-3.1-8b-instant", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  validate: { groq: "llama-3.1-8b-instant", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  test: { groq: "llama-3.1-8b-instant", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  research: { groq: "llama-3.3-70b-versatile", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  design: { groq: "llama-3.3-70b-versatile", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  code_generation: { groq: "openai/gpt-oss-20b", workers_ai: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" },
  // judging deliberately does NOT share a model family with architecture
  // (both used to be gpt-oss-120b / llama-3.3-70b-instruct-fp8-fast on both
  // tiers) — self-preference bias is a documented effect where an LLM judge
  // scores its own model family's outputs higher on otherwise-equivalent
  // content, and this system's entire output is a ranking. Found live
  // (2026-07-22, first calibration run) that deepseek-r1-distill-qwen-32b's
  // <think> reasoning burned through the token budget without reaching the
  // visible JSON answer — re-verified live 2026-07-28
  // (docs/INVESTIGATION_2026-07-28.md P0-1) that the actual cause was
  // tryWorkersAI never passing max_tokens at all (see below), capping every
  // Workers AI call at the platform's 256-token default regardless of what
  // callers requested. With that fixed, the same model/prompt/max_tokens=700
  // combination now completes its reasoning and returns valid JSON —
  // confirmed directly against the live API, not assumed.
  judging: { groq: "llama-3.3-70b-versatile", workers_ai: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" },
  architecture: { groq: "openai/gpt-oss-120b", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  // No groq candidate, deliberately: spec §14 Tribunal reflection is
  // "non-time-critical," so it always routes straight to the cheaper
  // Workers AI tier rather than spending Groq's daily request caps (those
  // matter more during a live event) on post-event reflection.
  reflect: { workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
};

// Daily caps from spec §5 (Groq) and §6 (Workers AI, Neuron-derived).
// These are the PUBLISHED caps — replace with measured values from the Week 0
// spike (inference_pool_probe.js) once you have them; don't ship on estimates.
export const DAILY_CAPS: Record<string, number> = {
  "groq:llama-3.1-8b-instant": 14400,
  "groq:llama-3.3-70b-versatile": 1000,
  "groq:openai/gpt-oss-120b": 1000,
  "groq:openai/gpt-oss-20b": 1000,
  // 8500 was an unmeasured conservative guess below spec §6's published
  // 10,000/day. Found live (2026-07-26, Week 7 closed beta): the app's own
  // tracked usage hit 8802 (over its own cap) while a direct real call
  // against Cloudflare's account still succeeded fine -- the app was
  // blocking well before the real account-side limit, not because of it.
  // 9500 keeps a real safety margin below the actual published ceiling
  // instead of an arbitrary one below an arbitrary one.
  "workers_ai": 9500,
};

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function unitsUsedToday(env: Env, provider: string, modelId?: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(units_used), 0) as used FROM provider_usage_log
     WHERE day = ? AND provider = ? AND (? IS NULL OR model_id = ?)`
  ).bind(todayUTC(), provider, provider === "groq" ? modelId : null, modelId ?? null).first<{ used: number }>();
  return row?.used ?? 0;
}

async function recordUsage(env: Env, provider: string, modelId: string, taskType: TaskType, units: number) {
  await env.DB.prepare(
    `INSERT INTO provider_usage_log (day, provider, model_id, task_type, units_used, timestamp)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).bind(todayUTC(), provider, modelId, taskType, units).run();
}

async function tryGroq(env: Env, model: string, req: InferenceRequest): Promise<string | null> {
  const capKey = `groq:${model}`;
  const used = await unitsUsedToday(env, "groq", model);
  if (used >= (DAILY_CAPS[capKey] ?? Infinity)) return null; // tier exhausted, fall through

  // reasoning_effort: "low" for gpt-oss models only — documented Groq
  // parameter (console.groq.com/docs/reasoning) that reduces how much
  // hidden <think> reasoning these models spend before their visible
  // answer. Attacks the actual cause of the truncation bug fixed today
  // (max_tokens bumped to 700 across judges/scoring.ts + calibration.ts)
  // rather than just widening the budget around it — found via live
  // research (2026-07-22 code review), not yet re-tuned down since the 700
  // budget is proven-working and this is additional headroom, not a
  // replacement for it. Not sent for non-gpt-oss models (llama-3.x) since
  // they don't support it and an unrecognized param risks a hard API error.
  const isReasoningModel = model.includes("gpt-oss");
  // Split randomly across 2 Groq accounts when the second is configured —
  // added live (2026-07-26, Week 7 closed beta) after individual judge
  // calls intermittently failed under concurrent load (7 judges' calls
  // fired together per scoreTarget) despite the daily cap having plenty of
  // headroom, pointing at a single account's per-minute rate limit rather
  // than daily exhaustion. Same account, same daily cap tracking below —
  // this spreads request-rate pressure, not daily budget.
  const apiKey = env.GROQ_API_KEY_2 && Math.random() < 0.5 ? env.GROQ_API_KEY_2 : env.GROQ_API_KEY;
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages: [{ role: "user", content: req.prompt }], max_completion_tokens: req.max_tokens ?? 500,
      ...(isReasoningModel ? { reasoning_effort: "low" } : {}),
    }),
  });
  if (!res.ok) return null; // real code should distinguish rate-limit (retry next tier) from hard error (log + alert)

  const data: any = await res.json();
  await recordUsage(env, "groq", model, req.task_type, 1); // Groq's cap is request-based, not token-based
  const content = data.choices?.[0]?.message?.content;
  // typeof-check, not just a truthiness/?? check: found live (2026-07-22,
  // Week 5 judging) that Groq's response for at least one reasoning model
  // (gpt-oss-120b) can come back with `content` as something other than a
  // plain string under conditions never pinned down exactly — every
  // downstream consumer assumed InferenceRequest's `text: string` contract
  // held and crashed on `.slice`/`.replace` when it didn't. Validating here,
  // at the API boundary, means the rest of the codebase can keep trusting
  // the type instead of every call site defensively re-checking it.
  return typeof content === "string" ? content : null;
}

async function tryWorkersAI(env: Env, model: string, req: InferenceRequest): Promise<string | null> {
  const used = await unitsUsedToday(env, "workers_ai");
  if (used >= DAILY_CAPS["workers_ai"]) return null;

  // max_tokens was missing here entirely until found live (2026-07-28,
  // docs/INVESTIGATION_2026-07-28.md P0-1): Workers AI silently defaults to
  // 256 completion tokens when it's omitted, regardless of what a caller
  // passed as req.max_tokens (that value only ever reached tryGroq above).
  // Confirmed directly against the real API: a reasoning-model judging
  // prompt with no max_tokens burned all 256 tokens on hidden <think>
  // reasoning and never reached the visible JSON answer; the identical
  // request with max_tokens:700 completed the reasoning and returned valid
  // JSON. This affected every task type's Workers AI fallback tier, not
  // just judging — callers' max_tokens (e.g. judges/scoring.ts and
  // calibration.ts's 700) is now actually honored on this path too.
  const result: any = await env.AI.run(model as any, {
    messages: [{ role: "user", content: req.prompt }],
    max_tokens: req.max_tokens ?? 500,
  });
  // env.AI.run()'s response carries the real per-call cost in result.usage.neurons
  // (confirmed 2026-07-21 against the raw HTTP API: a 94-token exchange on
  // llama-3.3-70b-instruct-fp8-fast cost ~9.99 neurons). Use it directly
  // instead of a flat guess — request sizes vary enough (see Week 0 probe
  // results: 94-345 tokens across task types) that a single constant would
  // always be wrong in one direction.
  // Round up (not just round) so summing many calls never under-counts
  // against DAILY_CAPS — units_used is INTEGER, the raw value isn't.
  const neurons = Math.ceil(result?.usage?.neurons ?? 300); // fallback only if the field is ever absent
  await recordUsage(env, "workers_ai", model, req.task_type, neurons);
  // typeof-check — same reasoning as tryGroq's content validation above.
  return typeof result?.response === "string" ? result.response : null;
}

/**
 * Routes an inference request through Groq -> Workers AI, per spec §6.
 * Returns null (rather than throwing) if both are exhausted or fail — caller
 * decides whether to queue.
 */
export async function routeInference(env: Env, req: InferenceRequest): Promise<{ text: string; provider: string; model: string } | null> {
  const candidates = TASK_MODELS[req.task_type];
  if (!candidates) throw new Error(`Unknown task_type: ${req.task_type}`);

  // pinned_provider set: only try that one tier, don't fall through to the
  // other even if it fails — a caller pinning a provider wants a clean
  // retry-later on the SAME model, not a silent swap to the other one.
  const tryOrder: Array<"groq" | "workers_ai"> = req.pinned_provider ? [req.pinned_provider] : ["groq", "workers_ai"];

  for (const provider of tryOrder) {
    const model = candidates[provider];
    if (!model) continue;
    const text = provider === "groq" ? await tryGroq(env, model, req) : await tryWorkersAI(env, model, req);
    if (text) return { text, provider, model };
  }
  return null; // caller should queue the request, not fail the user's turn
}
