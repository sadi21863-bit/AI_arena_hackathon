/**
 * Pure build-outcome predicates shared by the artifact audit and its tests.
 * Kept separate from artifact_audit.mjs because that module performs network
 * calls on load; tests must be able to exercise the rule directly.
 */

/** A team has delivered a build only if at least one turn completed successfully. */
export function hasSuccessfulTurn(team) {
  return Number(team?.successful_turns) >= 1;
}

/** True when every turn a team ran failed. Used by the quota-kill waiver. */
export function allTurnsFailed(team) {
  const failed = Number(team?.failed_turns) || 0;
  const successful = Number(team?.successful_turns) || 0;
  const turns = Number(team?.turns) || 0;
  return turns > 0 && failed === turns && successful === 0;
}
