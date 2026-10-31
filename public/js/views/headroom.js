/**
 * Headroom — provider quota against the daily caps, plus the cron heartbeat.
 *
 * The heartbeat matters more than it looks: Cloudflare Cron Triggers have no
 * built-in failure alerting, so this is the only place a silently-broken
 * scheduled tick becomes visible.
 */

import { fetchJson } from "../core/api.js";
import { html, render, wireReload } from "../core/html.js";
import { shortId } from "../core/fmt.js";

const R = 74;
const C = 2 * Math.PI * R;
const POLL_MS = 60_000;

function colorFor(pct) {
  if (pct >= 0.9) return "var(--arena-danger)";
  if (pct >= 0.6) return "var(--arena-warning)";
  return "var(--arena-success)";
}

function gauge(tier) {
  const pct = tier.cap ? Math.min(1, tier.used / tier.cap) : 0;
  return html`
    <div class="arena-card v-headroom__card">
      <div class="v-headroom__provider">${tier.provider === "groq" ? "Groq" : "Cloudflare Workers AI"}</div>
      <div class="v-headroom__model">${tier.model_id}</div>
      <svg class="v-headroom__svg" viewBox="0 0 180 180" role="img" aria-label="${Math.round(pct * 100)} percent of daily cap used">
        <circle class="v-headroom__track" cx="90" cy="90" r="${R}"></circle>
        <circle class="v-headroom__fill" cx="90" cy="90" r="${R}"
                stroke="${colorFor(pct)}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"></circle>
        <text class="v-headroom__pct" x="90" y="86" text-anchor="middle">${Math.round(pct * 100)}%</text>
        <text class="v-headroom__frac" x="90" y="104" text-anchor="middle">${tier.used} / ${tier.cap}</text>
      </svg>
      <div class="v-headroom__cap">daily cap · resets 00:00 UTC</div>
    </div>`;
}

function cronLine(cron) {
  if (!cron || !cron.last_tick_at) {
    return html`<div class="arena-note">Cron: no heartbeat recorded yet.</div>`;
  }
  if (cron.last_error) {
    return html`<div class="arena-note arena-note--danger"><span>⚠</span><span>
      <b>Last cron tick failed</b> (${cron.last_tick_at} UTC): ${cron.last_error}.
      ${cron.last_success_at ? `Last success ${cron.last_success_at} UTC.` : "No successful tick recorded yet."}
    </span></div>`;
  }
  if (cron.stale) {
    return html`<div class="arena-note arena-note--danger"><span>⚠</span><span>
      <b>Cron heartbeat is stale.</b> Last success ${cron.last_success_at ?? "never"} UTC;
      the threshold is ${cron.stale_after_minutes ?? 15} minutes. A dead cron cannot push its own alert —
      check the Worker schedule and the Cloudflare dashboard.
    </span></div>`;
  }
  return html`<div class="arena-note"><span>✓</span><span>Cron: last tick succeeded ${cron.last_tick_at} UTC.</span></div>`;
}

/**
 * Durable alerts written by the scheduled tick (R-1). The webhook is optional;
 * when it is not configured the row is still the difference between a silent
 * wedge and something a reader can see with the same page they already open.
 */
function alertsPanel(alerts, webhookConfigured) {
  const list = Array.isArray(alerts) ? alerts : [];
  const channel = webhookConfigured
    ? "Webhook configured."
    : "Webhook not configured — these alerts are visible here and on /alerts only.";
  if (!list.length) {
    return html`<div class="arena-note"><span>✓</span><span>No operational alerts recorded. ${channel}</span></div>`;
  }
  return html`
    <div class="arena-notes">
      ${list.map((a) => html`
        <div class="arena-note ${a.severity === "critical" ? "arena-note--danger" : "arena-note--warn"}">
          <span>${a.severity === "critical" ? "⚠" : "◆"}</span><span>
            <b>${a.kind}</b> · ${a.created_at} UTC · ${a.message}
            ${a.notified_at ? " · pushed" : webhookConfigured ? " · webhook not confirmed" : ""}
          </span>
        </div>`)}
      <div class="arena-note"><span>◆</span><span>${channel}</span></div>
    </div>`;
}

function subrequestLine(headroom) {
  const latest = headroom?.latest;
  if (!latest || latest.error || latest.total == null) {
    return html`<div class="arena-note">Subrequest headroom: no measured <code>team_formation</code> run recorded yet.</div>`;
  }
  const near = latest.total >= headroom.threshold;
  const over = latest.total >= latest.cap;
  return html`<div class="arena-note ${over ? "arena-note--danger" : near ? "arena-note--warn" : ""}">
    <span>${over ? "⚠" : near ? "◆" : "✓"}</span><span>
      Subrequest headroom: latest <code>${latest.task_type}</code> measured
      <b>${latest.total}/${latest.cap}</b> (alert at ${headroom.threshold}) for ${latest.event_id},
      ${latest.created_at} UTC. ${near ? "Do not blind-retry; see runbook A." : ""}
    </span>
  </div>`;
}

/**
 * Durable quality snapshots written at terminal judging (R-2). The live event
 * API recomputes the label on every request; this panel is the recorded history
 * so drift is visible without opening the retrospective script.
 */
function qualityPanel(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return html`<div class="arena-note">Ranking quality: no snapshots recorded yet. Terminal judging writes one, and the daily audit refreshes them.</div>`;
  }
  return html`
    <div class="arena-card">
      <div class="arena-section-label">Ranking quality snapshots</div>
      <p class="v-headroom__quality-note">
        Recorded at terminal judging and refreshed by the daily audit; <code>computed_at</code> is
        the last refresh. The live <code>quality</code> label is recomputed from
        <code>judge_scores</code> on every event request.
      </p>
      ${list.map((row) => html`
        <div class="arena-note ${row.confidence_level === "low" ? "arena-note--warn" : ""}">
          <span>${row.confidence_level === "low" ? "⚠" : row.confidence_level === "high" ? "✓" : "◆"}</span><span>
            <b>${row.confidence_level.toUpperCase()}</b> · ${row.event_type ?? "event"} ${shortId(row.event_id, 18)} ·
            n=${row.judged_population} ·
            r=${row.retrospective_correlation ?? "n/a"} (${row.retrospective_band}) ·
            ${row.computed_at} UTC
          </span>
        </div>`)}
    </div>`;
}

export async function mount(el) {
  let timer = null;
  let disposed = false;

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §6</div>
      <h1>Headroom</h1>
      <p>What the inference budget actually looks like right now — real usage against each provider's daily cap, and whether the scheduled tick that drives every event is still alive.</p>
    </header>
    <div id="hr-body"><div class="arena-state">Loading usage…</div></div>
    <p class="arena-freshness" data-freshness></p>`);

  const body = el.querySelector("#hr-body");

  async function load() {
    const data = await fetchJson("/headroom", { optional: true });
    if (disposed) return;
    if (!data) {
      render(body, html`<div class="arena-state arena-state--error">Couldn't load live usage.<div class="arena-state__action"><button class="arena-btn arena-btn--sm arena-btn--ghost" data-reload>Reload</button></div></div>`);
      wireReload(body);
      return;
    }
    const maxPct = (data.usage || []).reduce(
      (m, t) => Math.max(m, t.cap ? Math.min(1, t.used / t.cap) : 0), 0);

    const verdict = maxPct >= 0.9
      ? `At least one tier is effectively exhausted for ${data.day} — the router falls through to the next tier or queues.`
      : maxPct >= 0.6
        ? `Comfortable headroom remains for ${data.day}, though one tier is over half used.`
        : `Comfortable headroom on every tier for ${data.day}.`;

    render(body, html`
      <div class="arena-note ${maxPct >= 0.9 ? "arena-note--danger" : maxPct >= 0.6 ? "arena-note--warn" : ""}">
        <span>${maxPct >= 0.9 ? "⚠" : "◆"}</span><span>${verdict}</span>
      </div>
      <div class="v-headroom__grid">${(data.usage || []).map(gauge)}</div>
      ${cronLine(data.cron)}
      ${subrequestLine(data.subrequest_headroom)}
      ${alertsPanel(data.alerts, data.alert_webhook_configured)}
      ${qualityPanel(data.ranking_quality)}`);
  }

  await load();
  // Own poll: /headroom isn't part of the shared events store. Gated on
  // visibility like everything else now.
  timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);

  return () => { disposed = true; clearInterval(timer); };
}
