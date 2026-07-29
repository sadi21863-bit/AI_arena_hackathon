/**
 * Headroom — provider quota against the daily caps, plus the cron heartbeat.
 *
 * The heartbeat matters more than it looks: Cloudflare Cron Triggers have no
 * built-in failure alerting, so this is the only place a silently-broken
 * scheduled tick becomes visible.
 */

import { fetchJson } from "../core/api.js";
import { html, render } from "../core/html.js";

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
  return html`<div class="arena-note"><span>✓</span><span>Cron: last tick succeeded ${cron.last_tick_at} UTC.</span></div>`;
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
      render(body, html`<div class="arena-state arena-state--error">Couldn't load live usage.</div>`);
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
      ${cronLine(data.cron)}`);
  }

  await load();
  // Own poll: /headroom isn't part of the shared events store. Gated on
  // visibility like everything else now.
  timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);

  return () => { disposed = true; clearInterval(timer); };
}
