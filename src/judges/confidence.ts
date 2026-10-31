/**
 * Event-level ranking confidence (2026-10-31 review follow-up).
 *
 * The pre-event calibration gate scores 3 anchors and passes on a judge-level
 * Pearson correlation in [0.6, 0.95]. The post-event retrospective applies the
 * same metric to the judged population. The 2026-10-31 retrospective found
 * both directions were useful:
 *
 *   - low-side gate failures were corroborated by poor real agreement;
 *   - high-side failures were corroborated by overfit;
 *   - but 3 of 5 passing gates later fell below the 0.6 band on real ideas.
 *
 * So a gate pass is not a certificate. This module turns that finding into a
 * public label instead of leaving it in a dated document. It deliberately has
 * no authority to block judging or change scores — it describes how much the
 * ranking can bear.
 *
 * Thresholds are evidence-based, not statistical guarantees:
 *   - < 10 judged targets: low. Six-target events ranged from -0.180 to 0.469
 *     in the retrospective; a ranking there is provisional.
 *   - >= 20 targets with post-event agreement inside [0.6, 0.95]: high.
 *   - everything else that passed the gate: medium.
 */

export type ConfidenceLevel = "high" | "medium" | "low" | "unrated";
export type AgreementBand = "inside" | "below" | "above" | "insufficient_data";

export interface JudgeScoreRow {
  judge_name: string;
  target_id: string;
  score: number;
}

export interface JudgeAgreement {
  judges: number;
  targets: number;
  mean_correlation: number | null;
  band: AgreementBand;
  per_judge: { judge: string; targets: number; r: number | null }[];
}

export interface CalibrationInput {
  correlation: number;
  passed: boolean;
  /** Present when this is a hackathon using its parent ideathon's gate. */
  source?: "own" | "parent";
}

export interface EventConfidenceInput {
  eventType: "ideathon" | "hackathon";
  status: string;
  judgedPopulation: number;
  preEvent: CalibrationInput | null;
  retrospective: JudgeAgreement;
}

export interface EventConfidence {
  level: ConfidenceLevel;
  label: string;
  reasons: string[];
  judged_population: number;
  pre_event: CalibrationInput | null;
  retrospective: JudgeAgreement;
}

const LABELS: Record<ConfidenceLevel, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  unrated: "Not yet rated",
};

const round3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  // Same floor as scripts/calibration_retrospective.mjs: two points always fit
  // a line perfectly, so a correlation would be meaningless.
  if (n < 3) return null;
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  // Zero variance means "cannot correlate", not NaN. A judge who gave every
  // target the same score carries no ranking information here.
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

/**
 * Recomputes the retrospective metric from judge_scores: each judge's score
 * for a target versus the leave-one-out panel mean. Kept in the Worker (and
 * mirrored by scripts/calibration_retrospective.mjs) so the public label and
 * the operator script cannot disagree about the definition.
 */
export function measureJudgeAgreement(rows: JudgeScoreRow[]): JudgeAgreement {
  const byTarget = new Map<string, Map<string, number>>();
  const judgeSeen = new Set<string>();
  for (const row of rows) {
    if (!Number.isFinite(Number(row.score))) continue;
    judgeSeen.add(row.judge_name);
    const scores = byTarget.get(row.target_id) ?? new Map<string, number>();
    scores.set(row.judge_name, Number(row.score));
    byTarget.set(row.target_id, scores);
  }

  // Only targets with at least two judges can contribute a leave-one-out mean.
  const targets = [...byTarget.entries()].filter(([, scores]) => scores.size >= 2);
  const perJudge: { judge: string; targets: number; r: number | null }[] = [];
  for (const judge of [...judgeSeen].sort()) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [, scores] of targets) {
      if (!scores.has(judge)) continue;
      const others = [...scores.entries()].filter(([name]) => name !== judge).map(([, score]) => score);
      if (!others.length) continue;
      xs.push(scores.get(judge)!);
      ys.push(mean(others));
    }
    perJudge.push({ judge, targets: xs.length, r: round3(pearson(xs, ys)) });
  }

  const valid = perJudge.map((p) => p.r).filter((r): r is number => r !== null);
  const meanR = valid.length ? round3(mean(valid)) : null;
  const band: AgreementBand =
    meanR === null ? "insufficient_data" : meanR < 0.6 ? "below" : meanR > 0.95 ? "above" : "inside";

  return {
    judges: judgeSeen.size,
    targets: targets.length,
    mean_correlation: meanR,
    band,
    per_judge: perJudge,
  };
}

function terminal(eventType: "ideathon" | "hackathon", status: string): boolean {
  if (eventType === "ideathon") return status === "judged";
  return status === "judged" || status === "tribunal" || status === "complete";
}

export function computeEventConfidence(input: EventConfidenceInput): EventConfidence {
  const { eventType, status, judgedPopulation, preEvent, retrospective } = input;
  const base = {
    judged_population: judgedPopulation,
    pre_event: preEvent,
    retrospective,
  };
  const confidence = (level: ConfidenceLevel, reasons: string[]): EventConfidence => ({
    ...base,
    level,
    label: LABELS[level],
    reasons,
  });

  if (!terminal(eventType, status)) {
    return confidence("unrated", ["judging has not completed for this event"]);
  }
  if (judgedPopulation === 0) {
    return confidence("unrated", ["no judged targets were recorded; there is no ranking to rate"]);
  }
  if (!preEvent) {
    return confidence("unrated", ["no pre-event calibration is recorded for this event or its parent ideathon"]);
  }
  if (!preEvent.passed) {
    const side = preEvent.correlation > 0.95 ? "above the 0.95 ceiling" : "below the 0.60 floor";
    return confidence("low", [
      `the pre-event 3-anchor gate failed (r=${preEvent.correlation.toFixed(3)}, ${side}); ` +
        "the retrospective did not corroborate a stable ranking",
    ]);
  }

  const source = preEvent.source === "parent" ? " (inherited from the parent ideathon)" : "";
  if (judgedPopulation < 10) {
    const populationNote =
      eventType === "hackathon"
        ? `only ${judgedPopulation} teams were judged; a pairwise final is not a stable panel estimate`
        : `only ${judgedPopulation} targets were judged; 6-target events in the 2026-10-31 retrospective ranged from -0.180 to 0.469 in post-event agreement`;
    return confidence("low", [`pre-event gate passed${source}, but ${populationNote}`]);
  }

  if (retrospective.band === "below") {
    return confidence("low", [
      `post-event judge agreement is r=${retrospective.mean_correlation?.toFixed(3)} across ` +
        `${retrospective.targets} targets, below the 0.60 floor — the pre-event gate did not predict stable agreement`,
    ]);
  }
  if (retrospective.band === "above") {
    return confidence("low", [
      `post-event judge agreement is r=${retrospective.mean_correlation?.toFixed(3)} across ` +
        `${retrospective.targets} targets, above the 0.95 ceiling — the scores may be over-correlated or range-restricted`,
    ]);
  }
  if (retrospective.band === "inside" && judgedPopulation >= 20) {
    return confidence("high", [
      `pre-event gate passed${source} and post-event agreement is r=${retrospective.mean_correlation?.toFixed(3)} ` +
        `across ${judgedPopulation} judged targets, inside the 0.60-0.95 band`,
    ]);
  }
  if (retrospective.band === "inside") {
    return confidence("medium", [
      `pre-event gate passed${source} and post-event agreement is r=${retrospective.mean_correlation?.toFixed(3)}, ` +
        `inside the band but measured over only ${judgedPopulation} judged targets`,
    ]);
  }
  return confidence("medium", [
    `pre-event gate passed${source} across ${judgedPopulation} judged targets, but post-event agreement ` +
      "could not be measured (fewer than 3 comparable targets or zero variance)",
  ]);
}
