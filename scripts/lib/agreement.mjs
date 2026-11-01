/**
 * Agreement math shared by the semantic review tooling and its tests.
 *
 * Verdicts are ordinal: fail < weak < pass. Cohen's kappa is reported both
 * unweighted (exact category agreement) and quadratic-weighted (how far apart
 * disagreements are). A null result means the statistic is undefined for that
 * pair of distributions, not zero agreement.
 */
export const CATEGORY = ["fail", "weak", "pass"];

export function cohenKappa(pairs, weighted = false) {
  const k = CATEGORY.length;
  const n = pairs.length;
  if (!n) return { po: 0, pe: 0, unweighted: null, quadratic: null };

  const obs = Array.from({ length: k }, () => Array(k).fill(0));
  for (const [x, y] of pairs) obs[x][y] += 1;
  const row = obs.map((r) => r.reduce((sum, v) => sum + v, 0));
  const col = Array.from({ length: k }, (_, j) => obs.reduce((sum, r) => sum + r[j], 0));

  let po = 0;
  let pe = 0;
  let weightedPo = 0;
  let weightedPe = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const observed = obs[i][j] / n;
      const expected = (row[i] / n) * (col[j] / n);
      if (i === j) {
        po += observed;
        pe += expected;
      }
      const w = weighted ? ((i - j) ** 2) / ((k - 1) ** 2) : 0;
      weightedPo += w * observed;
      weightedPe += w * expected;
    }
  }

  return {
    po,
    pe,
    unweighted: pe === 1 ? null : (po - pe) / (1 - pe),
    quadratic: weightedPe === 0 ? null : 1 - weightedPo / weightedPe,
  };
}

export function agreementBand(value) {
  if (value === null || value === undefined) return "undefined";
  if (value < 0) return "poor";
  if (value < 0.21) return "slight";
  if (value < 0.41) return "fair";
  if (value < 0.61) return "moderate";
  if (value < 0.81) return "substantial";
  return "almost perfect";
}
