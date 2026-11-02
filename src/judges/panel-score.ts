/**
 * Panel-scale judge score (0-10) from whatever judge rows are present.
 *
 * The seven phase weights in personas.ts sum to 1.0, so a full panel is
 * unchanged by the division. A partial panel must be renormalized: the stall
 * watchdog finalizes with whoever answered, and an unnormalized sum would
 * store `score * weight` (one judge at 0.15 turns an 8/10 into ~1.2), making
 * an abandoned target lose to every fully-scored peer for a reason unrelated
 * to its quality. Renormalizing removes that scale bias, not the variance:
 * fewer judges still means a noisier estimate, which the confidence label
 * owns separately.
 */
export function weightedPanelScore(rows: { score: number; weight: number }[]): number {
  let weighted = 0;
  let weightSum = 0;
  for (const row of rows) {
    weighted += row.score * row.weight;
    weightSum += row.weight;
  }
  return weightSum > 0 ? weighted / weightSum : 0;
}
