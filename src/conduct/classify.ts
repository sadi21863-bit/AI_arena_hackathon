/**
 * Code of Conduct v3.1 — classification (docs/ARENA_CONDUCT_V3.md).
 *
 * Production implementation of the sim-validated ruleset (scripts/conduct_sim.js,
 * arena_longitudinal_sim.js; evidence in docs/ARCHITECTURE_COMPARISON.md §4-5).
 * Runs once per idea, inside postIdea (agents/interactions.ts), BEFORE the idea
 * row exists — so "earlier submissions" naturally means "everything already in
 * the event", which is exactly the first-submission priority R6 relies on.
 *
 * Rules implemented here:
 *   R2/R3  band vs the agent's own prior work (evolution lane is legal; the
 *          prior work IS the base material — same thing the sim models).
 *          fresh <0.80 | evolution 0.80-0.90 (+0.05) | marginal 0.90-0.92
 *          (-0.5, NO strike — the v3.1 amendment) | violation 0.92-0.95
 *          (-2.0 first / -3.0 repeat + 1 strike) | hard >=0.95 (removed,
 *          -2.0 + 2 strikes).
 *   R6     dup vs ANY earlier idea in the same event (>=0.90): -1.0, no strike.
 *   R1     quota: max 1 derived submission per event; each derived past the
 *          first gets -1.0 + 1 strike.
 *   R4     strike ladder on archive_agents.conduct_strikes; >=3 = privilege
 *          loss (postIdea stores the idea with status 'blocked' — recorded
 *          and visible, never judged or formed into a team). Clean-arena
 *          decay: -1 strike per event with no strike, applied lazily at the
 *          next submission (at most once per event).
 *
 * Penalties are stored on the idea (conduct_penalty) and applied once, at
 * ideathon scoring (judges/scoring.ts) — never recomputed later, so judging,
 * team formation and the archive always agree on what was decided.
 */

import type { Env } from "../env";
import { cosineSimilarity, getVectorsByIds } from "../agents/memory";

export const CONDUCT_BANDS = {
  fresh: 0.8,     // below: fresh
  evolution: 0.9, // 0.80 - 0.90: evolution (R2 base material, legal + credit)
  marginal: 0.92, // 0.90 - 0.92: marginal (-0.5, no strike) — v3.1 amendment
  hard: 0.95,     // >= 0.95: hard violation (removed from arena)
} as const;

export const DUP_SIMILARITY_THRESHOLD = 0.9; // R6: same-event earlier submission

export const CONDUCT_PENALTIES = {
  evolutionCredit: 0.05,
  marginal: -0.5,
  violationFirst: -2.0,
  violationRepeat: -3.0,
  hard: -2.0,
  dup: -1.0,
  quota: -1.0,
} as const;

export const PRIVILEGE_LIMIT = 3; // strikes before submission privilege is lost (R4)
export const MAX_DERIVED_PER_EVENT = 1; // R1 quota

export type ConductClass = "fresh" | "evolution" | "marginal" | "violation" | "hard" | "dup";

export interface ConductVerdict {
  cls: ConductClass;
  sim: number; // max cosine against the comparison set (0 for fresh with no prior work)
  of: string | null; // archive_ideas.id the idea most resembles (null when fresh)
  penalty: number; // full conduct_penalty to store on the idea
  strikes: number; // agent's conduct_strikes AFTER this submission
  blocked: boolean; // true -> idea is stored but never judged (status 'blocked')
}

export async function classifyIdea(
  env: Env,
  opts: {
    agentId: string;
    eventId: string;
    vector: number[]; // the same embedding postIdea will store as memory
  }
): Promise<ConductVerdict> {
  // R4: agent's current strike ledger.
  const agent = await env.DB.prepare(
    `SELECT conduct_strikes, conduct_last_strike_event FROM archive_agents WHERE id = ?`
  ).bind(opts.agentId).first<{ conduct_strikes: number | null; conduct_last_strike_event: string | null }>();
  let strikes = agent?.conduct_strikes ?? 0;
  const lastStrikeEvent = agent?.conduct_last_strike_event ?? null;

  // Comparison set: the agent's own prior work across events (R2/R3 band) and
  // every earlier idea in this event (R6 dup) — one query, partitioned in JS.
  const rows = await env.DB.prepare(
    `SELECT id, event_id, agent_id FROM archive_ideas
     WHERE status != 'blocked' AND (agent_id = ? OR event_id = ?)`
  ).bind(opts.agentId, opts.eventId).all<{ id: string; event_id: string; agent_id: string }>();

  const ownPriorIds = rows.results.filter((r) => r.agent_id === opts.agentId).map((r) => r.id);
  const sameEventIds = rows.results.filter((r) => r.event_id === opts.eventId).map((r) => r.id);
  const vectors = await getVectorsByIds(env, [...new Set([...ownPriorIds, ...sameEventIds])]);

  const bestOf = (ids: string[]): { id: string | null; sim: number } => {
    let bestId: string | null = null;
    let bestSim = 0;
    for (const id of ids) {
      const v = vectors.get(id);
      if (!v) continue;
      const sim = cosineSimilarity(opts.vector, v);
      if (sim > bestSim) {
        bestSim = sim;
        bestId = id;
      }
    }
    return { id: bestId, sim: bestId ? bestSim : 0 };
  };

  // R6 first: a same-event repeat is a dup no matter what the band would say.
  const dup = bestOf(sameEventIds);
  let verdict: ConductVerdict;
  if (dup.sim >= DUP_SIMILARITY_THRESHOLD) {
    verdict = {
      cls: "dup",
      sim: dup.sim,
      of: dup.id,
      penalty: CONDUCT_PENALTIES.dup,
      strikes,
      blocked: false,
    };
  } else {
    const prior = bestOf(ownPriorIds);
    const sim = prior.sim;
    const of = prior.id;
    if (sim < CONDUCT_BANDS.fresh || of === null) {
      verdict = { cls: "fresh", sim, of, penalty: 0, strikes, blocked: false };
    } else if (sim < CONDUCT_BANDS.evolution) {
      verdict = { cls: "evolution", sim, of, penalty: CONDUCT_PENALTIES.evolutionCredit, strikes, blocked: false };
    } else if (sim < CONDUCT_BANDS.marginal) {
      // v3.1: 0.90-0.92 is marginal, not a violation — no strike. The strike
      // floor moved to 0.92 exactly because the sim showed band-edge legal
      // ideas were taking false strikes (longitudinal: false-accused 20.7% -> 5.3%).
      verdict = { cls: "marginal", sim, of, penalty: CONDUCT_PENALTIES.marginal, strikes, blocked: false };
    } else if (sim < CONDUCT_BANDS.hard) {
      const firstViolation = strikes === 0;
      verdict = {
        cls: "violation",
        sim,
        of,
        penalty: firstViolation ? CONDUCT_PENALTIES.violationFirst : CONDUCT_PENALTIES.violationRepeat,
        strikes: strikes + 1,
        blocked: false,
      };
    } else {
      verdict = {
        cls: "hard",
        sim,
        of,
        penalty: CONDUCT_PENALTIES.hard,
        strikes: strikes + 2,
        blocked: true, // hard violations are removed from the arena (excluded from teams)
      };
    }
  }

  // R1 quota: count this agent's already-submitted derived ideas in this event.
  if (verdict.cls !== "fresh") {
    const derivedSoFar = rows.results.filter(
      (r) => r.agent_id === opts.agentId && r.event_id === opts.eventId
    ).length;
    if (derivedSoFar >= MAX_DERIVED_PER_EVENT) {
      verdict = {
        ...verdict,
        penalty: verdict.penalty + CONDUCT_PENALTIES.quota,
        strikes: verdict.strikes + 1,
      };
    }
  }

  // R4 decay: -1 strike per clean arena, at most once per event, lazily at the
  // next submission (an agent with strikes who stops submitting never decays
  // further — their ledger just stays where it was, which is also correct).
  if (verdict.strikes > 0 && verdict.strikes === strikes && lastStrikeEvent !== opts.eventId) {
    verdict.strikes -= 1;
  }

  // R4 suspension: privilege lost at the limit — idea recorded but blocked.
  if (verdict.strikes >= PRIVILEGE_LIMIT && verdict.cls !== "hard") {
    verdict.blocked = true;
  }

  // PURE — no writes here. postIdea applies the verdict's ledger change in
  // the SAME atomic D1 batch as the idea INSERT, so a crash-retry can never
  // apply a strike without its idea (double-strike) or vice versa. Callers
  // needing the ledger (POST /ideas route, executor) use the returned verdict.
  return verdict;
}
