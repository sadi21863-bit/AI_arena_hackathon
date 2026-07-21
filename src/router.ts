/**
 * Inference router — spec §6.
 *
 * Two providers, load split between them: Groq first, Cloudflare Workers AI
 * second. Lives directly in the Cloudflare Worker — no separate service, no
 * VM.
 */

export type TaskType =
  | "code_generation" | "architecture" | "research" | "judging"
  | "summarize" | "validate" | "design" | "test";

export interface InferenceRequest {
  task_type: TaskType;
  prompt: string;
  max_tokens?: number;
}

export interface Env {
  DB: D1Database;
  AI: Ai;
  GROQ_API_KEY: string;
}

// Task -> candidate model per provider, from spec §5. Kept explicit rather
// than derived, so a model swap is a one-line change here, not a
// scoring-function debugging session.
const TASK_MODELS: Record<TaskType, { groq?: string; workers_ai?: string }> = {
  summarize: { groq: "llama-3.1-8b-instant", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  validate: { groq: "llama-3.1-8b-instant" },
  test: { groq: "llama-3.1-8b-instant" },
  research: { groq: "llama-3.3-70b-versatile", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  design: { groq: "llama-3.3-70b-versatile" },
  code_generation: { groq: "openai/gpt-oss-20b", workers_ai: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" },
  judging: { groq: "openai/gpt-oss-120b", workers_ai: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" },
  architecture: { groq: "openai/gpt-oss-120b", workers_ai: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
};

// Daily caps from spec §5 (Groq) and §6 (Workers AI, Neuron-derived).
// These are the PUBLISHED caps — replace with measured values from the Week 0
// spike (inference_pool_probe.js) once you have them; don't ship on estimates.
const DAILY_CAPS: Record<string, number> = {
  "groq:llama-3.1-8b-instant": 14400,
  "groq:llama-3.3-70b-versatile": 1000,
  "groq:openai/gpt-oss-120b": 1000,
  "groq:openai/gpt-oss-20b": 1000,
  "workers_ai": 8500, // shared Neuron-derived budget across all Workers AI models
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

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: req.prompt }], max_completion_tokens: req.max_tokens ?? 500 }),
  });
  if (!res.ok) return null; // real code should distinguish rate-limit (retry next tier) from hard error (log + alert)

  const data: any = await res.json();
  await recordUsage(env, "groq", model, req.task_type, 1); // Groq's cap is request-based, not token-based
  return data.choices?.[0]?.message?.content ?? null;
}

async function tryWorkersAI(env: Env, model: string, req: InferenceRequest): Promise<string | null> {
  const used = await unitsUsedToday(env, "workers_ai");
  if (used >= DAILY_CAPS["workers_ai"]) return null;

  const result: any = await env.AI.run(model as any, { messages: [{ role: "user", content: req.prompt }] });
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
  return result?.response ?? null;
}

/**
 * Routes an inference request through Groq -> Workers AI, per spec §6.
 * Returns null (rather than throwing) if both are exhausted or fail — caller
 * decides whether to queue.
 */
export async function routeInference(env: Env, req: InferenceRequest): Promise<{ text: string; provider: string } | null> {
  const candidates = TASK_MODELS[req.task_type];
  if (!candidates) throw new Error(`Unknown task_type: ${req.task_type}`);

  if (candidates.groq) {
    const text = await tryGroq(env, candidates.groq, req);
    if (text) return { text, provider: "groq" };
  }
  if (candidates.workers_ai) {
    const text = await tryWorkersAI(env, candidates.workers_ai, req);
    if (text) return { text, provider: "workers_ai" };
  }
  return null; // caller should queue the request, not fail the user's turn
}
