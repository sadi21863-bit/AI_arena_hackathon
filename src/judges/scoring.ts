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
 * Runs the judges that haven't yet scored this target, writes each to
 * judge_scores, and returns the phase-weighted total (0-10 scale, weights
 * sum to 1 per phase — see personas.ts).
 *
 * Idempotent PER JUDGE, not as an all-or-nothing batch — found live
 * (2026-07-22 code review): the previous version checked
 * `existing.length === JUDGES.length` exactly. If a partial insert ever
 * failed (say 6 of 7 judges' rows landed before the 7th threw), that
 * equality could never be true again for this target, so every future
 * retry would re-score AND re-insert all 7, compounding duplicates forever.
 * Checking per-judge-name means a retry only does the actually-missing
 * work, and — with judge_scores' UNIQUE(target_type, target_id, phase,
 * judge_name) constraint (db/schema_week5_tribunal.sql) plus INSERT OR
 * IGNORE below — a genuine race (two queue items somehow scoring the same
 * target concurrently) can't double-insert even if both reach the insert
 * at once.
 */
export async function scoreTarget(
  env: Env,
  opts: { eventId: string; targetType: "idea" | "team"; targetId: string; phase: "ideathon" | "hackathon"; prompt: string }
): Promise<number> {
  const existing = await env.DB.prepare(
    `SELECT judge_name, score, weight FROM judge_scores WHERE target_type = ? AND target_id = ? AND phase = ?`
  ).bind(opts.targetType, opts.targetId, opts.phase).all<{ judge_name: string; score: number; weight: number }>();

  const alreadyScored = new Map(existing.results.map((row) => [row.judge_name, row]));
  const missingJudges = JUDGES.filter((judge) => !alreadyScored.has(judge.name));

  // Parallel, not sequential: each judge's call is independent, and running
  // them concurrently keeps this well inside a Worker invocation's
  // wall-clock budget (7 sequential ~1-2s LLM calls could otherwise push
  // 10-15s per target, times up to 3 targets/tick in processQueue's batch —
  // real timeout risk this avoids rather than a micro-optimization).
  const newResults = await Promise.all(missingJudges.map(async (judge) => {
    const weight = opts.phase === "ideathon" ? judge.ideathonWeight : judge.hackathonWeight;
    const { score, rationale } = await scoreOne(env, judge, opts.prompt);
    return { judge, weight, score, rationale };
  }));

  await Promise.all(newResults.map(({ judge, weight, score, rationale }) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO judge_scores (id, event_id, judge_name, criterion, weight, target_type, target_id, phase, score, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `judgescore_${crypto.randomUUID()}`, opts.eventId, judge.name, judge.criterion, weight,
      opts.targetType, opts.targetId, opts.phase, score, rationale
    ).run()
  ));

  const existingTotal = existing.results.reduce((sum, row) => sum + row.score * row.weight, 0);
  const newTotal = newResults.reduce((sum, r) => sum + r.score * r.weight, 0);
  return existingTotal + newTotal;
}
