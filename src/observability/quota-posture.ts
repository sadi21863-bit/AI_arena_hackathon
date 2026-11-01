/**
 * Quota-posture revisit signal (2026-11-01 review follow-up).
 *
 * `docs/QUOTA_POSTURE_2026-10-31.md` says the single-account decision should be
 * revisited when two consecutive cycles lose a build turn to quota exhaustion.
 * A recorded `quota_hold` alert is the closest durable proxy available: it is
 * written when the OpenRouter probe refuses a dispatch, not when a turn is
 * actually missed. This module makes that proxy visible on `/headroom` and
 * raises one review alert when it crosses the documented threshold.
 *
 * It does not provision a second account, rotate keys, or change the hold. The
 * decision stays with the owner; this only stops the trigger from living
 * exclusively in prose.
 */
import type { Env } from "../env";

export const QUOTA_POSTURE_WINDOW_DAYS = 14;
export const QUOTA_POSTURE_EVENT_THRESHOLD = 2;
export const QUOTA_POSTURE_DAY_THRESHOLD = 3;

export type QuotaPostureTrigger = "events" | "days" | null;

export interface QuotaPosture {
  window_days: number;
  holds: number;
  distinct_events: number;
  distinct_days: number;
  last_hold_at: string | null;
  event_threshold: number;
  day_threshold: number;
  review_due: boolean;
  trigger: QuotaPostureTrigger;
  caveat: string;
}

export function quotaPostureTrigger(
  distinctEvents: number,
  distinctDays: number,
): QuotaPostureTrigger {
  if (distinctEvents >= QUOTA_POSTURE_EVENT_THRESHOLD) return "events";
  if (distinctDays >= QUOTA_POSTURE_DAY_THRESHOLD) return "days";
  return null;
}

export function quotaPostureReviewDue(distinctEvents: number, distinctDays: number): boolean {
  return quotaPostureTrigger(distinctEvents, distinctDays) !== null;
}

export async function loadQuotaPosture(env: Env): Promise<QuotaPosture> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS holds,
            COUNT(DISTINCT event_id) AS distinct_events,
            COUNT(DISTINCT substr(created_at, 1, 10)) AS distinct_days,
            MAX(created_at) AS last_hold_at
     FROM ops_alerts
     WHERE kind = 'quota_hold' AND created_at >= datetime('now', ?)`,
  )
    .bind(`-${QUOTA_POSTURE_WINDOW_DAYS} days`)
    .first<{
      holds: number;
      distinct_events: number;
      distinct_days: number;
      last_hold_at: string | null;
    }>();

  const distinctEvents = Number(row?.distinct_events ?? 0);
  const distinctDays = Number(row?.distinct_days ?? 0);
  const trigger = quotaPostureTrigger(distinctEvents, distinctDays);

  return {
    window_days: QUOTA_POSTURE_WINDOW_DAYS,
    holds: Number(row?.holds ?? 0),
    distinct_events: distinctEvents,
    distinct_days: distinctDays,
    last_hold_at: row?.last_hold_at ?? null,
    event_threshold: QUOTA_POSTURE_EVENT_THRESHOLD,
    day_threshold: QUOTA_POSTURE_DAY_THRESHOLD,
    review_due: trigger !== null,
    trigger,
    caveat:
      "Proxy only: a quota_hold means the probe refused a dispatch, not that a scheduled turn was provably lost. " +
      "Two distinct events or three distinct UTC days in the window is the documented 'revisit' prompt, not an automatic mitigation.",
  };
}
