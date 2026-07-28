/**
 * Pre-event judge calibration — spec §13 / §16 risk mitigation: "Before
 * every event, all 7 judges score 3 anchor ideas to calibrate. If
 * inter-judge correlation falls below 0.6, adjust weights or provide
 * clearer anchor examples."
 *
 * Correlation with n=3 anchors is statistically thin (Pearson on 3 points
 * is noisy by nature) — this is a sanity gate, not a rigorous statistical
 * test, matching what the spec actually asks for: a fast pre-event check
 * that catches a judge whose scoring is wildly uncorrelated with the rest,
 * not a publishable inter-rater reliability study.
 */
import type { Env } from "../env";
import { routeInference } from "../router";
import { extractJson } from "../agents/json-helpers";
import { JUDGES } from "./personas";

// Deliberately generic enough for any of the 7 criteria to have something
// to score (technical feasibility, market viability, ..., code quality and
// UX as "how well does this plan set up for those" since nothing is built
// yet — same situation real ideathon judging is in).
const ANCHOR_IDEAS = [
  {
    label: "strong",
    text:
      "Title: Invoice Tone Ladder. Problem: freelancers spend 4-6 hours/month manually escalating overdue-payment " +
      "emails, and existing tools only send flat reminders, not escalating tone. Solution: auto-generates a 3-tier " +
      "escalating reminder sequence (polite -> firm -> final notice) via Stripe/QuickBooks webhooks. Build scope: " +
      "webhook listener, template engine, scheduler, dashboard — buildable by a 2-person team in 4 days.",
  },
  {
    label: "medium",
    text:
      "Title: TeamSync. Problem: remote teams struggle with communication. Solution: a unified dashboard that " +
      "brings together chat, tasks, and calendars in one place with AI summaries. Build scope: integrate with " +
      "Slack/Google Calendar APIs, build a dashboard UI, add an AI summary feature.",
  },
  {
    label: "weak",
    text:
      "Title: EverythingApp. Problem: people use too many apps. Solution: one app that replaces all other apps " +
      "using AI to do whatever the user needs. Build scope: build the core AI engine, add integrations for every " +
      "major service, launch.",
  },
];

interface AnchorScoreResult {
  score: number;
  provider: string;
  model: string;
}

async function scoreAnchor(env: Env, judgeName: string, criterion: string, anchorText: string): Promise<AnchorScoreResult> {
  // Anti-verbosity clause (P1-3) must stay word-for-word consistent with
  // judges/scoring.ts's real scoring prompt — calibration is only
  // meaningful as a predictor of how judges will actually score if it asks
  // them to score the same way.
  const prompt =
    `You are Judge ${judgeName}, scoring ${criterion} (0-10) for a calibration exercise. ` +
    `Length is not quality — a longer or more elaborately-worded entry is not automatically better than a ` +
    `concise one; judge substance, and penalize unnecessary padding or restatement rather than rewarding it. ` +
    `Respond with ONLY a JSON object: {"score": number}.\n\nIDEA: ${anchorText}`;
  // 700, not a tighter budget matching the tiny {"score": N} answer: judging
  // routes to reasoning models (gpt-oss-120b / deepseek-r1-distill-qwen-32b)
  // that spend tokens on hidden chain-of-thought before the visible JSON —
  // 100 truncated mid-reasoning and never reached the answer (found live,
  // 2026-07-22, first calibration run: "Malformed calibration score from
  // Mason: {\"" — the whole completion was 2 characters). 700 matches
  // executor.ts callAgent's already-proven budget for this same model class.
  const result = await routeInference(env, { task_type: "judging", prompt, max_tokens: 700 });
  if (!result) throw new Error(`Inference exhausted during calibration for Judge ${judgeName}`);
  const parsed = extractJson<{ score: number }>(result.text);
  if (!parsed || typeof parsed.score !== "number") {
    throw new Error(`Malformed calibration score from ${judgeName}: ${result.text.slice(0, 200)}`);
  }
  return { score: Math.max(0, Math.min(10, parsed.score)), provider: result.provider, model: result.model };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varA += (a[i] - meanA) ** 2;
    varB += (b[i] - meanB) ** 2;
  }
  if (varA === 0 || varB === 0) return 0; // a judge with zero variance can't correlate — treat as no agreement, not NaN
  return cov / Math.sqrt(varA * varB);
}

export interface CalibrationResult {
  correlation: number;
  passed: boolean;
}

/** Runs all 7 judges against the 3 anchor ideas and records the result. */
export async function runCalibration(env: Env, eventId: string): Promise<CalibrationResult> {
  // Parallel ACROSS judges (7-way), sequential WITHIN each judge's 3
  // anchors — not all 21 (judge x anchor) pairs at once. Found live
  // (2026-07-22): firing all 21 concurrently hit Workers' "stalled HTTP
  // response canceled to prevent deadlock" protection (a cap on in-flight
  // concurrent subrequests), which silently truncated some responses.
  // 7-way concurrency, each awaiting its own 3 calls in turn, stays well
  // under that limit while still avoiding a fully-sequential 21x wall time.
  const scoresByJudge: Record<string, number[]> = {};
  // First successful call's provider/model is pinned for the rest of this
  // event's judging (P0-2, spec §13 risk mitigation — see judges/scoring.ts)
  // rather than letting each individual judge_idea/judge_team call re-decide
  // independently, which is exactly how a mid-event Groq exhaustion could
  // silently mix gpt-oss-120b and deepseek-r1-distill-qwen-32b scores into
  // one weighted ranking with no record it happened.
  let pinnedProvider: string | undefined;
  let pinnedModel: string | undefined;
  await Promise.all(JUDGES.map(async (judge) => {
    const scores: number[] = [];
    for (const anchor of ANCHOR_IDEAS) {
      const result = await scoreAnchor(env, judge.name, judge.criterion, anchor.text);
      scores.push(result.score);
      if (!pinnedProvider) { pinnedProvider = result.provider; pinnedModel = result.model; }
    }
    scoresByJudge[judge.name] = scores;
  }));

  const pairwiseCorrelations: number[] = [];
  for (let i = 0; i < JUDGES.length; i++) {
    for (let j = i + 1; j < JUDGES.length; j++) {
      pairwiseCorrelations.push(pearson(scoresByJudge[JUDGES[i].name], scoresByJudge[JUDGES[j].name]));
    }
  }
  const correlation = pairwiseCorrelations.reduce((s, v) => s + v, 0) / pairwiseCorrelations.length;
  const passed = correlation >= 0.6;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO calibration_runs (id, event_id, correlation, passed, details) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      `calibration_${crypto.randomUUID()}`, eventId, correlation, passed ? 1 : 0, JSON.stringify(scoresByJudge)
    ),
    env.DB.prepare(
      `UPDATE archive_events SET judging_provider = ?, judging_model = ? WHERE id = ?`
    ).bind(pinnedProvider ?? null, pinnedModel ?? null, eventId),
  ]);

  return { correlation, passed };
}
