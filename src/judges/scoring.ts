/**
 * Judge scoring — spec §13. Each of the 7 judges independently scores a
 * target (an ideathon idea, or a hackathon team's build) 0-10 on their own
 * criterion, with a rationale. Runs against the inference router like any
 * other agent call (task_type "judging" — already in TASK_MODELS, verified
 * live during the Week 0 spike).
 */
import type { Env } from "../env";
import { routeInference } from "../router";
import { extractJson } from "../agents/json-helpers";
import { JUDGES, type Judge } from "./personas";

interface JudgeScoreJson {
  score: number;
  rationale: string;
}

async function scoreOne(env: Env, judge: Judge, prompt: string): Promise<JudgeScoreJson> {
  const fullPrompt =
    `You are Judge ${judge.name}, scoring ${judge.criterion} (0-10) for a competition entry. ` +
    `Respond with ONLY a JSON object: {"score": number, "rationale": string (2-3 sentences)}.\n\n${prompt}`;

  // 700, matching calibration.ts's fix and executor.ts callAgent's proven
  // budget for this same reasoning-model task type (judging routes to
  // gpt-oss-120b / deepseek-r1-distill-qwen-32b) — see calibration.ts for
  // what a too-tight budget actually does (truncates mid-reasoning, never
  // reaches the visible answer).
  const result = await routeInference(env, { task_type: "judging", prompt: fullPrompt, max_tokens: 700 });
  if (!result) throw new Error(`Inference exhausted scoring as Judge ${judge.name}`);

  const parsed = extractJson<JudgeScoreJson>(result.text);
  if (!parsed || typeof parsed.score !== "number" || !parsed.rationale) {
    throw new Error(`Malformed judge score JSON from ${judge.name}: ${result.text.slice(0, 200)}`);
  }
  // Clamp — a judge occasionally returns 10.5 or similar off-scale noise;
  // clamping keeps the weighted total meaningful without failing the whole
  // scoring pass over one rogue number.
  return { score: Math.max(0, Math.min(10, parsed.score)), rationale: parsed.rationale };
}

/**
 * Runs all 7 judges against one target, writes each to judge_scores, and
 * returns the phase-weighted total (0-10 scale, weights sum to 1 per
 * phase — see personas.ts). Idempotent: if a prior attempt already scored
 * this target (e.g. a retried queue item after a mid-way failure), reuses
 * those rows instead of re-scoring and double-inserting.
 */
export async function scoreTarget(
  env: Env,
  opts: { eventId: string; targetType: "idea" | "team"; targetId: string; phase: "ideathon" | "hackathon"; prompt: string }
): Promise<number> {
  const existing = await env.DB.prepare(
    `SELECT judge_name, score, weight FROM judge_scores WHERE target_type = ? AND target_id = ? AND phase = ?`
  ).bind(opts.targetType, opts.targetId, opts.phase).all<{ judge_name: string; score: number; weight: number }>();

  if (existing.results.length === JUDGES.length) {
    return existing.results.reduce((sum, row) => sum + row.score * row.weight, 0);
  }

  // Parallel, not sequential: each judge's call is independent, and running
  // all 7 concurrently keeps this well inside a Worker invocation's
  // wall-clock budget (7 sequential ~1-2s LLM calls could otherwise push
  // 10-15s per target, times up to 5 targets/tick in processQueue's batch —
  // real timeout risk this avoids rather than a micro-optimization).
  const results = await Promise.all(JUDGES.map(async (judge) => {
    const weight = opts.phase === "ideathon" ? judge.ideathonWeight : judge.hackathonWeight;
    const { score, rationale } = await scoreOne(env, judge, opts.prompt);
    return { judge, weight, score, rationale };
  }));

  await Promise.all(results.map(({ judge, weight, score, rationale }) =>
    env.DB.prepare(
      `INSERT INTO judge_scores (id, event_id, judge_name, criterion, weight, target_type, target_id, phase, score, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `judgescore_${crypto.randomUUID()}`, opts.eventId, judge.name, judge.criterion, weight,
      opts.targetType, opts.targetId, opts.phase, score, rationale
    ).run()
  ));

  return results.reduce((sum, r) => sum + r.score * r.weight, 0);
}
