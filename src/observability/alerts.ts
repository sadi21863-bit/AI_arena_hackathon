/**
 * Operational alerts (2026-10-31 review follow-up, R-1).
 *
 * The runbook already listed thresholds, but nothing wrote them anywhere a
 * reader would see. This module evaluates the two highest-frequency branches on
 * the scheduled tick:
 *
 *   - worker_subrequest_log.total >= 45 / 50 (the incident's silence shape);
 *   - an event paused for capacity for more than an hour (the quota hold).
 *
 * Alerts are always persisted in ops_alerts, surfaced by GET /headroom and
 * GET /alerts, and POSTed to ALERT_WEBHOOK_URL when that secret exists. No
 * webhook is invented here: without the secret, the durable row is still the
 * improvement over a silent wedge, and the runbook says how to enable push.
 *
 * Dedupe is time-windowed, not acknowledgement-based: one alert per
 * (kind, event, task) per 24h. That keeps a repeating condition visible daily
 * without a row every 5 minutes.
 */
import type { Env } from "../env";

export const SUBREQUEST_WARN_THRESHOLD = 45;

export interface OpsAlert {
  id: string;
  created_at: string;
  kind: "subrequest_headroom" | "capacity_pause" | "formation_failures" | "dispatch_no_run";
  severity: "warning" | "critical";
  event_id: string | null;
  task_type: string | null;
  message: string;
  details: string | null;
  notified_at: string | null;
  notify_error: string | null;
}

async function recentAlertExists(
  env: Env,
  kind: OpsAlert["kind"],
  eventId: string,
  taskType: string | null,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM ops_alerts
     WHERE kind = ? AND event_id = ? AND COALESCE(task_type, '') = COALESCE(?, '')
       AND created_at >= datetime('now', '-1 day')
     LIMIT 1`,
  )
    .bind(kind, eventId, taskType)
    .first<{ id: string }>();
  return !!row;
}

async function notifyWebhook(env: Env, alert: OpsAlert): Promise<boolean> {
  if (!env.ALERT_WEBHOOK_URL) return false;
  const text = `[${alert.severity.toUpperCase()}] ${alert.message}`;
  try {
    const res = await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        content: text,
        kind: alert.kind,
        severity: alert.severity,
        event_id: alert.event_id,
        task_type: alert.task_type,
        details: alert.details ? JSON.parse(alert.details) : null,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
    await env.DB.prepare(`UPDATE ops_alerts SET notified_at = datetime('now'), notify_error = NULL WHERE id = ?`)
      .bind(alert.id)
      .run();
    return true;
  } catch (err) {
    await env.DB.prepare(`UPDATE ops_alerts SET notify_error = ? WHERE id = ?`)
      .bind(err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300), alert.id)
      .run();
    return false;
  }
}

async function raiseAlert(env: Env, alert: Omit<OpsAlert, "id" | "notified_at" | "notify_error" | "created_at">) {
  const row: OpsAlert = {
    ...alert,
    id: `alert_${crypto.randomUUID()}`,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    notified_at: null,
    notify_error: null,
  };
  await env.DB.prepare(
    `INSERT INTO ops_alerts (id, kind, severity, event_id, task_type, message, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.kind, row.severity, row.event_id, row.task_type, row.message, row.details)
    .run();
  const pushed = await notifyWebhook(env, row);
  return { alert: row, pushed };
}

/**
 * Runs on the scheduled tick. Best-effort: a failure here must never take down
 * the queue drive, so the caller wraps it and logs instead of re-throwing.
 */
export async function checkOperationalAlerts(env: Env): Promise<{ raised: number; pushed: number }> {
  let raised = 0;
  let pushed = 0;

  const subrequest = await env.DB.prepare(
    `SELECT event_id, task_type, github_calls, main_repo_fetches, db_statements, total, cap, created_at
     FROM worker_subrequest_log
     WHERE created_at >= datetime('now', '-6 hours') AND total >= ?
     ORDER BY total DESC, created_at DESC LIMIT 1`,
  )
    .bind(SUBREQUEST_WARN_THRESHOLD)
    .first<{
      event_id: string;
      task_type: string;
      github_calls: number;
      main_repo_fetches: number;
      db_statements: number;
      total: number;
      cap: number;
      created_at: string;
    }>();

  if (subrequest && !(await recentAlertExists(env, "subrequest_headroom", subrequest.event_id, subrequest.task_type))) {
    const severity = subrequest.total >= subrequest.cap ? "critical" : "warning";
    const result = await raiseAlert(env, {
      kind: "subrequest_headroom",
      severity,
      event_id: subrequest.event_id,
      task_type: subrequest.task_type,
      message:
        `${subrequest.task_type} used ${subrequest.total}/${subrequest.cap} measured subrequests ` +
        `for ${subrequest.event_id} (github=${subrequest.github_calls}, ` +
        `mainRepo=${subrequest.main_repo_fetches}, db=${subrequest.db_statements}); ` +
        "a retry can wedge the task — do not blind-retry.",
      details: JSON.stringify({
        github_calls: subrequest.github_calls,
        main_repo_fetches: subrequest.main_repo_fetches,
        db_statements: subrequest.db_statements,
        total: subrequest.total,
        cap: subrequest.cap,
        threshold: SUBREQUEST_WARN_THRESHOLD,
        observed_at: subrequest.created_at,
      }),
    });
    raised += 1;
    if (result.pushed) pushed += 1;
  }

  const paused = await env.DB.prepare(
    `SELECT id, pause_reason, paused_at FROM archive_events
     WHERE status = 'paused_capacity' AND paused_at <= datetime('now', '-1 hour')
     ORDER BY paused_at ASC LIMIT 1`,
  ).first<{ id: string; pause_reason: string | null; paused_at: string | null }>();

  if (paused && !(await recentAlertExists(env, "capacity_pause", paused.id, null))) {
    const result = await raiseAlert(env, {
      kind: "capacity_pause",
      severity: "warning",
      event_id: paused.id,
      task_type: null,
      message:
        `${paused.id} has been paused for capacity since ${paused.paused_at ?? "an unrecorded time"}: ` +
        `${paused.pause_reason ?? "no reason recorded"}. The probe is holding dispatches; ` +
        "this is a budget wait, not a code failure — do not rotate keys.",
      details: JSON.stringify({ paused_at: paused.paused_at, pause_reason: paused.pause_reason }),
    });
    raised += 1;
    if (result.pushed) pushed += 1;
  }

  const formation = await env.DB.prepare(
    `SELECT q.event_id, COUNT(*) AS failures, MAX(q.completed_at) AS last_at
     FROM event_queue q JOIN archive_events e ON e.id = q.event_id
     WHERE q.task_type = 'team_formation' AND q.status = 'failed'
       AND q.completed_at >= datetime('now', '-24 hours')
       AND q.completed_at >= e.start_date
       AND e.abandoned_at IS NULL
       AND e.status NOT IN ('complete', 'judged', 'failed')
     GROUP BY q.event_id HAVING COUNT(*) >= 3
     ORDER BY last_at DESC LIMIT 1`,
  ).first<{ event_id: string; failures: number; last_at: string | null }>();

  if (formation && !(await recentAlertExists(env, "formation_failures", formation.event_id, null))) {
    const result = await raiseAlert(env, {
      kind: "formation_failures",
      severity: "warning",
      event_id: formation.event_id,
      task_type: null,
      message:
        `team_formation has failed ${formation.failures} time(s) for ${formation.event_id} ` +
        `(last at ${formation.last_at ?? "an unrecorded time"}). Do not blind-retry — check the ` +
        "subrequest cap, repo_url and scaffold before re-arming.",
      details: JSON.stringify({ failures: formation.failures, last_at: formation.last_at }),
    });
    raised += 1;
    if (result.pushed) pushed += 1;
  }

  const dispatch = await env.DB.prepare(
    `SELECT b.turn_id, b.event_id, b.team_id, b.turn_number, b.dispatched_at
     FROM build_turns b JOIN archive_events e ON e.id = b.event_id
     WHERE b.run_id IS NULL AND b.status = 'dispatched'
       AND b.dispatched_at <= datetime('now', '-30 minutes')
       AND e.abandoned_at IS NULL
       AND e.status NOT IN ('complete', 'judged', 'failed')
     ORDER BY b.dispatched_at ASC LIMIT 1`,
  ).first<{
    turn_id: string;
    event_id: string;
    team_id: string;
    turn_number: number;
    dispatched_at: string | null;
  }>();

  if (dispatch && !(await recentAlertExists(env, "dispatch_no_run", dispatch.event_id, dispatch.turn_id))) {
    const result = await raiseAlert(env, {
      kind: "dispatch_no_run",
      severity: "warning",
      event_id: dispatch.event_id,
      task_type: dispatch.turn_id,
      message:
        `build turn ${dispatch.turn_id} (${dispatch.event_id}, team ${dispatch.team_id}, turn ${dispatch.turn_number}) ` +
        `was dispatched at ${dispatch.dispatched_at ?? "an unrecorded time"} but still has no run_id after 30 minutes. ` +
        "The dispatch likely never reached GitHub Actions.",
      details: JSON.stringify({
        turn_id: dispatch.turn_id,
        team_id: dispatch.team_id,
        turn_number: dispatch.turn_number,
        dispatched_at: dispatch.dispatched_at,
      }),
    });
    raised += 1;
    if (result.pushed) pushed += 1;
  }

  return { raised, pushed };
}

export async function recentAlerts(env: Env, limit = 10): Promise<OpsAlert[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = await env.DB.prepare(
    `SELECT id, created_at, kind, severity, event_id, task_type, message, details, notified_at, notify_error
     FROM ops_alerts ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(safeLimit)
    .all<OpsAlert>();
  return rows.results;
}
