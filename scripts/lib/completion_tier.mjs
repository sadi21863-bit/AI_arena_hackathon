/**
 * Deterministic completion tiers for built repos (A5).
 *
 * Completion says the artifact runs. It says nothing about whether the idea
 * was any good. `substantial` is deliberately NEVER emitted here: that word is
 * reserved for a repo that is `complete` AND passes the independent quality
 * rubric in docs/PROJECT_QUALITY_RUBRIC.md.
 *
 * The tiers use numbers the artifact audit already collects, so no new probe
 * is needed. Thresholds are proposals to calibrate against a hand-checked
 * sample, not measured truths.
 */
export const COMPLETION_TIERS = ["empty", "scaffold", "partial", "complete"];

export function completionTier(team, build) {
  const productFiles = build?.product_files?.length ?? 0;
  const testFiles = build?.test_files?.length ?? 0;
  const nonblank = build?.code?.nonblank_lines ?? 0;
  const assertions = build?.code?.assertion_hits ?? 0;
  const verdict = build?.verdict;
  const successful = Number(team?.successful_turns) || 0;

  if (productFiles === 0) return "empty";
  if (nonblank < 30 || testFiles === 0) return "scaffold";
  // Tests exist with assertions, but the build/verification/outcome is not green.
  if (assertions === 0 || verdict !== "READY" || successful === 0) return "partial";
  if (build?.checks && Object.values(build.checks).some((ok) => ok === false)) return "partial";
  return "complete";
}
