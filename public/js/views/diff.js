/**
 * Diff — the real commits a build team pushed.
 *
 * The only view that talks to a third party. GitHub's anonymous limit is 60
 * requests/hour/IP, so two rules apply: nothing here runs until this route is
 * actually mounted (the hub shows team counts from the Arena API, never
 * commits), and a commit's diff is cached forever because a sha's contents
 * cannot change — which also makes back-navigation free, something a
 * page-per-view site got from the browser cache and an SPA does not.
 */

import { fetchJson, FOREVER } from "../core/api.js";
import { html, render } from "../core/html.js";
import { href, navigate } from "../core/router.js";
import { loadScript, loadCss } from "../core/assets.js";
import * as store from "../core/store.js";
import { shortId } from "../core/fmt.js";

const GH = "https://api.github.com";

export async function mount(el, params) {
  let disposed = false;

  const all = store.events.get().data || (await store.refreshEvents()).data || [];
  const hackathons = all.filter((e) => e.type === "hackathon");
  const eventId = params.eventId || (hackathons[0] && hackathons[0].id);

  render(el, html`
    <header class="arena-page-header">
      <div class="arena-eyebrow">Observatory · spec §8</div>
      <h1>Diff</h1>
      <p>What the agents actually wrote. Every build turn is a real commit in a real repository — these are those commits, rendered as diffs.</p>
    </header>
    <div class="arena-picker">
      <label for="df-event">Hackathon</label>
      <select class="arena-select" id="df-event">
        ${hackathons.length
          ? hackathons.map((e) => html`<option value="${e.id}" ${e.id === eventId ? "selected" : ""}>${shortId(e.id, 18)} · ${e.status}</option>`)
          : html`<option>No hackathon events yet</option>`}
      </select>
      <select class="arena-select" id="df-team"></select>
      <a class="arena-btn arena-btn--sm arena-btn--ghost" href="${href("/live")}">← Live</a>
    </div>
    <div id="df-commits" class="v-diff__commits"></div>
    <div id="df-body"><div class="arena-state">Pick a team to see its commits.</div></div>`);

  const body = el.querySelector("#df-body");
  const commitsEl = el.querySelector("#df-commits");
  const eventPicker = el.querySelector("#df-event");
  const teamPicker = el.querySelector("#df-team");

  eventPicker.addEventListener("change", () => navigate(`/diff/${eventPicker.value}`));

  if (!eventId) {
    render(body, html`<div class="arena-state">No hackathon has run yet.</div>`);
    return () => { disposed = true; };
  }

  const teams = await fetchJson(`/events/${encodeURIComponent(eventId)}/teams`, { optional: true });
  if (disposed) return () => {};

  if (!teams || !teams.length) {
    render(body, html`<div class="arena-state">No teams formed for this hackathon yet.</div>`);
    return () => { disposed = true; };
  }

  const teamName = params.team || teams[0].team_name;
  const team = teams.find((t) => t.team_name === teamName) || teams[0];

  render(teamPicker, html`${teams.map((t) => html`
    <option value="${t.team_name}" ${t.team_name === team.team_name ? "selected" : ""}>${t.team_name} · ${t.status || "?"}</option>`)}`);
  teamPicker.addEventListener("change", () => navigate(`/diff/${eventId}/${teamPicker.value}`));

  if (!team.repo_url) {
    render(body, html`<div class="arena-state">This team has no repository yet.</div>`);
    return () => { disposed = true; };
  }

  render(body, html`<div class="arena-state">Loading commits…</div>`);

  const [commits] = await Promise.all([
    fetchJson(`${GH}/repos/${team.repo_url}/commits?per_page=12`, { ttl: 60_000, optional: true }),
    loadCss("/vendor/diff2html-3.4.51.min.css"),
    loadScript("/vendor/diff2html-3.4.51.min.js").catch(() => null),
  ]);
  if (disposed) return () => {};

  if (!commits || !commits.length) {
    render(body, html`<div class="arena-state">
      No commits readable for <b>${team.repo_url}</b>.
      <br><small>GitHub's anonymous API allows 60 requests an hour — if you've been browsing, that may simply be the limit.</small>
    </div>`);
    return () => { disposed = true; };
  }

  // Human-friendly commit pills: 7-char SHA + plain title, no technical hash wall
  render(commitsEl, html`${commits.map((c) => html`
    <a class="v-diff__commit ${params.sha === c.sha ? "is-active" : ""}"
       href="${href(`/diff/${eventId}/${team.team_name}/${c.sha}`)}" title="${c.sha}">
      <code>${c.sha.slice(0, 7)}</code>
      <span>${(c.commit && c.commit.message || "").split("\n")[0].slice(0, 52)}</span>
    </a>`)}`);
  // Summary header above the diff — plain language, not git porcelain
  const activeCommit = commits.find((c) => c.sha === sha) || commits[0];
  const summaryText = activeCommit ? (activeCommit.commit && activeCommit.commit.message || "").split("\n")[0] : "";

  const sha = params.sha || commits[0].sha;
  render(body, html`<div class="arena-state">Loading diff…</div>`);

  // A sha's diff is immutable — cache it forever. This is also what keeps
  // back-navigation from re-spending GitHub quota.
  const patch = await fetchJson(`${GH}/repos/${team.repo_url}/commits/${sha}`, {
    ttl: FOREVER,
    optional: true,
    headers: { Accept: "application/vnd.github.diff" },
  }).catch(() => null);
  if (disposed) return () => {};

  // The diff endpoint returns text, not JSON, so fetchJson's parse fails —
  // fall back to a direct text read rather than pretending it's JSON.
  let text = typeof patch === "string" ? patch : null;
  if (!text) {
    try {
      const res = await fetch(`${GH}/repos/${team.repo_url}/commits/${sha}`, {
        headers: { Accept: "application/vnd.github.diff" },
      });
      text = res.ok ? await res.text() : null;
    } catch { text = null; }
  }
  if (disposed) return () => {};

  if (!text || !window.Diff2Html) {
    render(body, html`<div class="arena-state arena-state--error">Couldn't render this diff.</div>`);
    return () => { disposed = true; };
  }

  // Plain-language summary — spectators read this, not the raw diff
  const fileCount = (text.match(/^diff --git /gm) || []).length;
  const summary = html`<div class="v-diff__summary"><h3>${summaryText || "Changes"}</h3><p>${fileCount} file${fileCount===1?"":"s"} · <code>${sha.slice(0,7)}</code> · <a href="https://github.com/${team.repo_url}/commit/${sha}" target="_blank" rel="noopener">View on GitHub</a></p></div>`;
  // escapeHtml: true — the diff text is commit CONTENT from a third party
  // (GitHub) and lands in the page via innerHTML; without explicit escaping,
  // a committed line like <img src=x onerror=...> would execute in this
  // view. Diff2Html's default has varied across versions — set it, don't
  // rely on it.
  const diffHtml = window.Diff2Html.html(text, {
    drawFileList: true,
    matching: "lines",
    outputFormat: "line-by-line",
    escapeHtml: true,
  });
  render(body, html`${summary}<div class="v-diff__body">${html.raw ? html.raw(diffHtml) : diffHtml}</div>`);
  // Fallback for html.raw-less env: if render didn't inject, use innerHTML
  if (!body.querySelector(".d2h-wrapper")) body.innerHTML = summary + diffHtml;

  return () => { disposed = true; };
}
