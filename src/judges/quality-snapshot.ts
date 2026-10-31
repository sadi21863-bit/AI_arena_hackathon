/**
 * Durable snapshot of the live ranking-confidence computation (R-2, 2026-10-31).
 *
 * The API computes `quality` from calibration_runs + judge_scores on every
 * request, which is correct but leaves no history: Headroom cannot show drift,
 * and a later data change silently rewrites every past label. This writes the
 * same computation once when an event reaches a terminal judging state.
 *
 * The live API remains the source of truth. A snapshot is a record of what the
 * system believed at that moment, not a second gate.
 */
import type { Env } from "../env";
import { buildEventQuality, type CalibrationRow, type EventQuality, type QualityEventRow } from "./quality";
import type { JudgeScoreRow } from "./confidence";

export async function recordEventQuality(env: Env, eventId: string): Promise<EventQuality | null> {
  const event = await env.DB.prepare(
    `SELECT id, type, status, parent_event_id FROM archive_events WHERE id = ?`,
  )
    .bind(eventId)
    .first<QualityEventRow>();
  if (!event) return null;

  const [calibrations, scores] = await Promise.all([
    env.DB.prepare(`SELECT event_id, correlation, passed FROM calibration_runs`).all<CalibrationRow>(),
    env.DB.prepare(`SELECT judge_name, target_id, score FROM judge_scores WHERE event_id = ?`)
      .bind(eventId)
      .all<JudgeScoreRow>(),
  ]);

  const calibrationByEvent = new Map(calibrations.results.map((row) => [row.event_id, row]));
  const quality = buildEventQuality(event, scores.results, calibrationByEvent);

  await env.DB.prepare(
    `INSERT INTO event_quality_snapshots
       (event_id, judged_population, pre_correlation, pre_passed,
        retrospective_correlation, retrospective_band, confidence_level,
        confidence_reasons, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(event_id) DO UPDATE SET
       judged_population = excluded.judged_population,
       pre_correlation = excluded.pre_correlation,
       pre_passed = excluded.pre_passed,
       retrospective_correlation = excluded.retrospective_correlation,
       retrospective_band = excluded.retrospective_band,
       confidence_level = excluded.confidence_level,
       confidence_reasons = excluded.confidence_reasons,
       computed_at = excluded.computed_at`,
  )
    .bind(
      event.id,
      quality.judged_population,
      quality.pre_event?.correlation ?? null,
      quality.pre_event ? (quality.pre_event.passed ? 1 : 0) : null,
      quality.retrospective.mean_correlation,
      quality.retrospective.band,
      quality.level,
      JSON.stringify(quality.reasons),
    )
    .run();

  return quality;
}
