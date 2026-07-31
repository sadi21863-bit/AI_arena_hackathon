/**
 * N-5 (docs/ARENA_BACKLOG.md) — cross-event Elo for agents.
 *
 * A hackathon is a match between two rosters with a definite outcome, so each
 * agent is rated against the strength of the roster it actually faced rather
 * than by counting wins. Beating a strong opposing roster moves an agent more
 * than beating a weak one, which is the whole reason a counter can't express
 * "climbing across events."
 *
 * Applied once, when a hackathon reaches `judged` and the winner is known.
 * See db/schema_week8_agent_ratings.sql for why this is the one accumulating
 * write in the system that must never be replayed.
 */

import type { Env } from "../env";

/** Standard chess starting rating; every agent's provisional value. */
export const DEFAULT_RATING = 1200;

/**
 * Rating movement per event. 24 is deliberately moderate: the Arena runs ~3
 * events/month, so a K high enough to make one event dramatic would make the
 * leaderboard track recent luck rather than accumulated skill, and the sample
 * per event is small (one match, two rosters). Ratings should take a few
 * events to say something real.
 */
export const K_FACTOR = 24;

/**
 * Probability `rating` beats `opponentRating`, per the standard Elo logistic
 * curve. A 400-point gap means the favourite is expected to win ~10 times out
 * of 11.
 */
export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

/**
 * New rating after one match. `actual` is 1 for a win, 0 for a loss, 0.5 for a
 * draw — the draw case is real here, since two teams can finish on identical
 * final_score.
 */
export function updateRating(rating: number, opponentRating: number, actual: number, k = K_FACTOR): number {
  return rating + k * (actual - expectedScore(rating, opponentRating));
}

export function meanRating(ratings: number[]): number {
  if (ratings.length === 0) return DEFAULT_RATING;
  return ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
}

interface TeamSide {
  teamId: string;
  finalScore: number;
  agentIds: string[];
}

/**
 * Rates one completed hackathon.
 *
 * No-ops unless the event has exactly two rated sides and hasn't been rated
 * before. Returns the number of agents whose rating moved, so the caller can
 * tell a real pass from a skipped one.
 */
export async function applyEventRatings(env: Env, eventId: string): Promise<number> {
  const alreadyRated = await env.DB.prepare(
    `SELECT ratings_applied_at FROM archive_events WHERE id = ?`
  ).bind(eventId).first<{ ratings_applied_at: string | null }>();
  if (alreadyRated?.ratings_applied_at) return 0;

  const teams = await env.DB.prepare(
    `SELECT id, final_score FROM hackathon_teams WHERE event_id = ?`
  ).bind(eventId).all<{ id: string; final_score: number | null }>();

  // Elo needs two sides. A one-team event (or a malformed one) is skipped
  // rather than rated against an imaginary opponent.
  if (teams.results.length !== 2) return 0;

  const members = await env.DB.prepare(
    `SELECT team_id, agent_id FROM hackathon_team_members WHERE event_id = ?`
  ).bind(eventId).all<{ team_id: string; agent_id: string }>();
  if (members.results.length === 0) return 0; // formed before rosters existed

  const agents = await env.DB.prepare(`SELECT id, elo_rating FROM archive_agents`)
    .all<{ id: string; elo_rating: number | null }>();
  const ratingOf = new Map(agents.results.map((a) => [a.id, a.elo_rating ?? DEFAULT_RATING]));

  const sides: TeamSide[] = teams.results.map((t) => ({
    teamId: t.id,
    finalScore: t.final_score ?? 0,
    agentIds: members.results.filter((m) => m.team_id === t.id).map((m) => m.agent_id),
  }));
  if (sides.some((s) => s.agentIds.length === 0)) return 0;

  const [sideA, sideB] = sides;
  const ratingA = meanRating(sideA.agentIds.map((id) => ratingOf.get(id) ?? DEFAULT_RATING));
  const ratingB = meanRating(sideB.agentIds.map((id) => ratingOf.get(id) ?? DEFAULT_RATING));

  const outcomeFor = (side: TeamSide, other: TeamSide): number => {
    if (side.finalScore === other.finalScore) return 0.5;
    return side.finalScore > other.finalScore ? 1 : 0;
  };

  const statements = [];
  for (const [side, opponentRating, actual] of [
    [sideA, ratingB, outcomeFor(sideA, sideB)],
    [sideB, ratingA, outcomeFor(sideB, sideA)],
  ] as Array<[TeamSide, number, number]>) {
    for (const agentId of side.agentIds) {
      const current = ratingOf.get(agentId) ?? DEFAULT_RATING;
      // Each agent is rated individually against the opposing ROSTER's mean,
      // not as an interchangeable unit of its team — so a strong agent on a
      // losing side loses less than a weak one, which is what keeps the
      // rating about the agent rather than about the team it was assigned to.
      const next = updateRating(current, opponentRating, actual);
      statements.push(
        env.DB.prepare(
          `UPDATE archive_agents
              SET elo_rating = ?, rating_events = COALESCE(rating_events, 0) + 1,
                  rating_updated_at = datetime('now')
            WHERE id = ?`
        ).bind(next, agentId)
      );
    }
  }

  // The marker goes in the SAME batch as the writes it guards — stamping it
  // separately would leave a window where a retry could double-apply.
  statements.push(
    env.DB.prepare(`UPDATE archive_events SET ratings_applied_at = datetime('now') WHERE id = ?`).bind(eventId)
  );

  await env.DB.batch(statements);
  return statements.length - 1;
}
