/**
 * Builds the public `quality` object for an event response.
 *
 * Kept separate from the pure confidence rules so every route (list, summary,
 * single event) uses the same construction: own calibration for an ideathon,
 * the parent ideathon's calibration for a hackathon, judged population from
 * actual judge_scores rows, and the retrospective metric from those rows.
 */
import {
  computeEventConfidence,
  measureJudgeAgreement,
  type CalibrationInput,
  type EventConfidence,
  type JudgeScoreRow,
} from "./confidence";

export interface QualityEventRow {
  id: string;
  type: "ideathon" | "hackathon";
  status: string;
  parent_event_id: string | null;
}

export interface CalibrationRow {
  event_id: string;
  correlation: number;
  passed: number | boolean;
}

export interface AuditSummary {
  failures: number | null;
  warnings: number | null;
  audited_at: string | null;
}

export interface EventQuality extends EventConfidence {
  audit: AuditSummary | null;
}

function calibrationInput(
  row: CalibrationRow | undefined,
  source: "own" | "parent",
): CalibrationInput | null {
  if (!row || !Number.isFinite(Number(row.correlation))) return null;
  return { correlation: Number(row.correlation), passed: !!row.passed, source };
}

export function buildEventQuality(
  event: QualityEventRow,
  scores: JudgeScoreRow[],
  calibrationByEvent: Map<string, CalibrationRow>,
  audit: AuditSummary | null = null,
): EventQuality {
  const own = calibrationByEvent.get(event.id);
  const parent = event.parent_event_id ? calibrationByEvent.get(event.parent_event_id) : undefined;
  const preEvent =
    event.type === "ideathon"
      ? calibrationInput(own, "own")
      : calibrationInput(parent, "parent");

  const retrospective = measureJudgeAgreement(scores);
  const judgedPopulation = new Set(scores.map((row) => row.target_id)).size;

  return {
    ...computeEventConfidence({
      eventType: event.type,
      status: event.status,
      judgedPopulation,
      preEvent,
      retrospective,
    }),
    audit,
  };
}
