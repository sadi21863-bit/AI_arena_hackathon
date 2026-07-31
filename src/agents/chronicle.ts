/**
 * N-7 (docs/ARENA_BACKLOG.md) — the Chronicler.
 *
 * The earliest versions of the spec included a Chronicler producing live
 * commentary; it never made it into the build. The Observatory now shows real
 * data — queue counts, scores, interaction timelines — which is legible to
 * someone already tracking the event and opaque to everyone else.
 *
 * This narrates each phase as it ends, from what actually happened in it. The
 * facts are gathered from D1 first and handed to the model as material; the
 * model's job is to write them up, not to recall them. That ordering matters
 * for a system whose whole recent history is bugs where plausible text stood
 * in for real work (P0-0a) — a Chronicler that invented events would be the
 * same failure wearing a friendlier face.
 *
 * Routes to the summarize tier, is never on the critical path of an event, and
 * failing produces no chronicle rather than blocking a phase transition.
 */

import type { Env } from "../env";
import { routeInference } from "../router";

/**
 * What actually happened in this event so far, read from D1 rather than
 * recalled by a model. Deliberately not filtered to the single phase being
 * narrated: the interesting observations are cross-phase ("the idea Iris
 * critiqued hardest is the one that advanced"), and every table here is
 * already scoped to one event so the volume stays bounded either way.
 */
async function gatherPhaseFacts(env: Env, eventId: string): Promise<string> {
  const lines: string[] = [];

  const ideas = await env.DB.prepare(
    `SELECT a.name AS agent_name, i.title, i.one_liner
       FROM archive_ideas i LEFT JOIN archive_agents a ON a.id = i.agent_id
      WHERE i.event_id = ? ORDER BY i.created_at ASC LIMIT 40`
  ).bind(eventId).all<{ agent_name: string | null; title: string; one_liner: string }>();
  if (ideas.results.length) {
    lines.push(`Ideas submitted (${ideas.results.length}):`);
    for (const i of ideas.results) lines.push(`- ${i.agent_name ?? "?"}: "${i.title}" — ${i.one_liner}`);
  }

  const critiques = await env.DB.prepare(
    `SELECT a.name AS actor_name, i.title AS idea_title, x.content
       FROM archive_interactions x
       LEFT JOIN archive_agents a ON a.id = x.actor_id
       LEFT JOIN archive_ideas i ON i.id = x.target_id
      WHERE x.event_id = ? AND x.type = 'critique'
      ORDER BY x.timestamp ASC LIMIT 20`
  ).bind(eventId).all<{ actor_name: string | null; idea_title: string | null; content: string | null }>();
  if (critiques.results.length) {
    lines.push(`\nCritiques (${critiques.results.length} shown):`);
    for (const c of critiques.results) {
      lines.push(`- ${c.actor_name ?? "?"} on "${c.idea_title ?? "?"}": ${String(c.content ?? "").slice(0, 200)}`);
    }
  }

  const collabs = await env.DB.prepare(
    `SELECT type, content FROM archive_interactions
      WHERE event_id = ? AND type IN ('propose_collaboration', 'merge', 'form_alliance', 'runoff_promotion')
      ORDER BY timestamp ASC LIMIT 10`
  ).bind(eventId).all<{ type: string; content: string | null }>();
  if (collabs.results.length) {
    lines.push(`\nCollaboration / selection events:`);
    for (const c of collabs.results) lines.push(`- [${c.type}] ${String(c.content ?? "").slice(0, 200)}`);
  }

  const teams = await env.DB.prepare(
    `SELECT team_name, status, hackathon_score, final_score FROM hackathon_teams WHERE event_id = ?`
  ).bind(eventId).all<{ team_name: string; status: string; hackathon_score: number | null; final_score: number | null }>();
  if (teams.results.length) {
    lines.push(`\nTeams:`);
    for (const t of teams.results) {
      lines.push(`- ${t.team_name} (${t.status})` +
        (t.final_score != null ? ` final score ${t.final_score.toFixed(2)}` : ""));
    }
  }

  return lines.join("\n").slice(0, 6000);
}

/**
 * Writes the chronicle entry for a phase that just ended.
 *
 * INSERT OR IGNORE against event_chronicle's UNIQUE(event_id, phase) is what
 * makes this safe to reach more than once — a phase is narrated at most once
 * however many ticks notice the transition.
 */
export async function chroniclePhase(env: Env, eventId: string, phase: string): Promise<boolean> {
  const existing = await env.DB.prepare(
    `SELECT 1 FROM event_chronicle WHERE event_id = ? AND phase = ?`
  ).bind(eventId, phase).first();
  if (existing) return false;

  const facts = await gatherPhaseFacts(env, eventId);
  if (!facts.trim()) return false; // nothing happened worth narrating

  const result = await routeInference(env, {
    task_type: "summarize",
    max_tokens: 500,
    prompt:
      `You are the Arena's Chronicler, writing a short public commentary on the "${phase}" phase ` +
      `of an autonomous AI product competition, for readers who are not following the raw data.\n\n` +
      `Write 2-4 sentences. Name specific agents and ideas. Point out genuinely interesting patterns — ` +
      `two agents converging on the same problem from different angles, a critique that landed hard, ` +
      `a surprising result. Do not invent anything that is not in the material below, do not speculate ` +
      `about what agents were thinking, and do not use hype. If the material is thin, say less.\n\n` +
      `WHAT HAPPENED:\n${facts}`,
  });
  if (!result?.text?.trim()) return false;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO event_chronicle (id, event_id, phase, narrative) VALUES (?, ?, ?, ?)`
  ).bind(`chr_${crypto.randomUUID()}`, eventId, phase, result.text.trim().slice(0, 2000)).run();
  return true;
}
