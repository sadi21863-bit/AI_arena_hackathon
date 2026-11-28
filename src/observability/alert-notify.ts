/**
 * Alert delivery and the admin test-alert helper (Tasks 10-11).
 *
 * Kept in its own module so the notify branches can be unit-tested directly:
 * Node's type stripper cannot import alerts.ts (it has extensionless runtime
 * imports). Only *type* imports live here, so this file is directly loadable.
 *
 * A row is always inserted before delivery is attempted, so a webhook outage
 * or an unconfigured receiver can never lose the evidence.
 */
import type { Env } from "../env";
import type { OpsAlert } from "./alerts";

export const WEBHOOK_UNCONFIGURED = "webhook not configured";

async function setNotifyError(env: Env, id: string, error: string): Promise<void> {
  await env.DB.prepare(`UPDATE ops_alerts SET notify_error = ? WHERE id = ?`).bind(error, id).run();
}

async function setNotified(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE ops_alerts SET notified_at = datetime('now'), notify_error = NULL WHERE id = ?`)
    .bind(id)
    .run();
}

/** Returns true only when the receiver accepted the POST. */
export async function notifyWebhook(env: Env, alert: OpsAlert): Promise<boolean> {
  if (!env.ALERT_WEBHOOK_URL) {
    // Distinguish "never attempted because unconfigured" from "quiet".
    await setNotifyError(env, alert.id, WEBHOOK_UNCONFIGURED);
    return false;
  }
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
    await setNotified(env, alert.id);
    return true;
  } catch (err) {
    await setNotifyError(env, err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300), alert.id);
    return false;
  }
}

/** Admin-only end-to-end delivery probe. Returns the persisted row's state. */
export async function raiseTestAlert(env: Env): Promise<{
  id: string;
  notified_at: string | null;
  notify_error: string | null;
  pushed: boolean;
}> {
  const id = `alert_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO ops_alerts (id, kind, severity, event_id, task_type, message, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    "test_alert",
    "warning",
    null,
    null,
    "Test alert from /admin/alerts/test — confirms webhook delivery and D1 persistence.",
    JSON.stringify({ source: "admin_test_route" }),
  ).run();

  const pushed = await notifyWebhook(env, {
    id,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    kind: "test_alert",
    severity: "warning",
    event_id: null,
    task_type: null,
    message: "Test alert from /admin/alerts/test — confirms webhook delivery and D1 persistence.",
    details: JSON.stringify({ source: "admin_test_route" }),
    notified_at: null,
    notify_error: null,
  });

  const row = await env.DB.prepare(`SELECT notified_at, notify_error FROM ops_alerts WHERE id = ?`)
    .bind(id)
    .first<{ notified_at: string | null; notify_error: string | null }>();
  return { id, notified_at: row?.notified_at ?? null, notify_error: row?.notify_error ?? null, pushed };
}
