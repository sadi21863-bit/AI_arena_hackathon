/**
 * Deterministic over-scope tripwire for architecture plans.
 *
 * The architecture prompt bans Kubernetes, blockchain/ledger, custom model
 * training, multi-cloud and multi-region compliance from the MVP, and build
 * scope was the discriminating criterion in the 2026-11-01 semantic
 * calibration (kappa 0.630). This helper is a warning-only check, not a
 * quality score: it flags a banned term only when the sentence mentioning it
 * is not itself an exclusion ("out of scope: Kubernetes" is compliant).
 *
 * Kept in its own module so `scripts/test_ops_rules.mjs` can exercise the
 * negation handling without importing the audit script's network setup.
 */
const BANNED_SCOPE_PATTERN =
  "\\b(kubernetes|k8s|blockchain|distributed ledger|smart contracts?|custom (?:model )?training|multi-cloud|multi-region)\\b";
const SCOPE_EXCLUSION_RE = /\b(out of scope|not in scope|excluded|no |not |without |avoid )/i;

export function findOverScopedIdeas(ideas) {
  const out = [];
  for (const idea of ideas) {
    const plan = typeof idea.build_scope === "string" ? idea.build_scope.trim() : "";
    if (!plan) continue;

    const terms = new Set();
    for (const sentence of plan.split(/(?<=[.!?])\s+|\n+/)) {
      if (SCOPE_EXCLUSION_RE.test(sentence)) continue;
      for (const match of sentence.match(new RegExp(BANNED_SCOPE_PATTERN, "gi")) ?? []) {
        terms.add(match.toLowerCase());
      }
    }
    if (terms.size === 0) continue;

    out.push({
      id: idea.id,
      title: typeof idea.title === "string" ? idea.title.trim() : "",
      terms: [...terms],
    });
  }
  return out;
}
