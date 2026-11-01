/**
 * Quota-posture revisit signal (2026-11-01; account premise corrected
 * 2026-11-01 after measurement).
 *
 * `docs/QUOTA_POSTURE_2026-10-31.md` says the capacity posture should be
 * revisited when cycles lose build turns to quota exhaustion. A recorded
 * `quota_hold` alert is the closest durable proxy: it is written when the
 * OpenRouter probe refuses a dispatch, not when a turn is provably missed.
 *
 * The two configured keys were measured to be two INDEPENDENT accounts on
 * 2026-11-01 (distinct creator_user_id/workspace, independent daily counters),
 * and teams are pinned one per account. A single hold therefore means one
 * team's day is spent, not that the arena is out of budget. The review trigger
 * reflects that:
 *
 *   - both accounts held on the same UTC day (arena-wide squeeze), or
 *   - holds on 2+ distinct events (the capacity problem is recurring), or
 *   - holds on 3+ distinct UTC days (chronic).
 *
 * It does not provision a third account, rotate keys, or add paid credit.
 */
import type { Env } from "../env";

export const QUOTA_POSTURE_WINDOW_DAYS = 14;
export const QUOTA_POSTURE_EVENT_THRESHOLD = 2;
export const QUOTA_POSTURE_DAY_THRESHOLD = 3;
export const QUOTA_POSTURE_BOTH_ACCOUNTS_DAYS_THRESHOLD = 1;

export type QuotaPostureTrigger = "both_accounts_same_day" | "events" | "days" | null;

export interface QuotaPosture {
  window_days: number;
  holds: number;
  distinct_events: number;
  distinct_days: number;
  distinct_accounts: number;
  days_with_both_accounts: number;
  last_hold_at: string | null;
  event_threshold: number;
  day_threshold: number;
  both_accounts_day_threshold: number;
  review_due: boolean;
  trigger: QuotaPostureTrigger;
  caveat: string;
}

export function quotaPostureTrigger(
  daysWithBothAccounts: number,
  distinctEvents: number,
  distinctDays: number,
): QuotaPostureTrigger {
  if (daysWithBothAccounts >= QUOTA_POSTURE_BOTH_ACCOUNTS_DAYS_THRESHOLD) return "both_accounts_same_day";
  if (distinctEvents >= QUOTA_POSTURE_EVENT_THRESHOLD) return "events";
  if (distinctDays >= QUOTA_POSTURE_DAY_THRESHOLD) return "days";
  return null;
}

export function quotaPostureReviewDue(
  daysWithBothAccounts: number,
  distinctEvents: number,
  distinctDays: number,
): boolean {
  return quotaPostureTrigger(daysWithBothAccounts, distinctEvents, distinctDays) !== null;
}

/**
 * `details` is JSON written by recordQuotaHold. `json_valid` guards rows from
 * an older writer (or a manual insert) so one malformed row cannot break the
 * public /headroom endpoint.
 */
const ACCOUNT_EXPR = `json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END, '$.account')`;

export async function loadQuotaPosture(env: Env): Promise<QuotaPosture> {
  const window = `-${QUOTA_POSTURE_WINDOW_DAYS} days`;

  const aggregate = await env.DB.prepare(
    `SELECT COUNT(*) AS holds,
            COUNT(DISTINCT event_id) AS distinct_events,
            COUNT(DISTINCT substr(created_at, 1, 10)) AS distinct_days,
            COUNT(DISTINCT ${ACCOUNT_EXPR}) AS distinct_accounts,
            MAX(created_at) AS last_hold_at
     FROM ops_alerts
     WHERE kind = 'quota_hold' AND created_at >= datetime('now', ?)`,
  )
    .bind(window)
    .first<{
      holds: number;
      distinct_events: number;
      distinct_days: number;
      distinct_accounts: number;
      last_hold_at: string | null;
    }>();

  // A day on which both independent accounts refused a dispatch is the
  // arena-wide squeeze signal; one account holding is only that team's day.
  const both = await env.DB.prepare(
    `SELECT COUNT(*) AS days_with_both_accounts
     FROM (
       SELECT substr(created_at, 1, 10) AS day
       FROM ops_alerts
       WHERE kind = 'quota_hold' AND created_at >= datetime('now', ?)
       GROUP BY day
       HAVING COUNT(DISTINCT ${ACCOUNT_EXPR}) >= 2
     )`,
  )
    .bind(window)
    .first<{ days_with_both_accounts: number }>();

  const distinctEvents = Number(aggregate?.distinct_events ?? 0);
  const distinctDays = Number(aggregate?.distinct_days ?? 0);
  const daysWithBothAccounts = Number(both?.days_with_both_accounts ?? 0);
  const trigger = quotaPostureTrigger(daysWithBothAccounts, distinctEvents, distinctDays);

  return {
    window_days: QUOTA_POSTURE_WINDOW_DAYS,
    holds: Number(aggregate?.holds ?? 0),
    distinct_events: distinctEvents,
    distinct_days: distinctDays,
    distinct_accounts: Number(aggregate?.distinct_accounts ?? 0),
    days_with_both_accounts: daysWithBothAccounts,
    last_hold_at: aggregate?.last_hold_at ?? null,
    event_threshold: QUOTA_POSTURE_EVENT_THRESHOLD,
    day_threshold: QUOTA_POSTURE_DAY_THRESHOLD,
    both_accounts_day_threshold: QUOTA_POSTURE_BOTH_ACCOUNTS_DAYS_THRESHOLD,
    review_due: trigger !== null,
    trigger,
    caveat:
      "Proxy only: a quota_hold means one team's pinned account refused a dispatch, not that the arena is provably out of budget. " +
      "The two configured keys are independent accounts (alpha -> 1, beta -> 2), so a single hold can coexist with a healthy build on the other. " +
      "review_due fires when both accounts hold on the same UTC day, or when holds recur across 2+ events / 3+ days. " +
      "It prompts an owner review of pinning and capacity; it never provisions keys or credit automatically.",
  };
}
