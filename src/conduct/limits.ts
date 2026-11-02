/**
 * Conduct limits shared by the classifier and the ops alert (2026-11-02).
 *
 * The 2026-11-02 saturation had two parts: a quota rule that added strikes
 * faster than the clean-arena decay removed them, and no signal that the whole
 * pool was suspended until 30 of 33 ideas were already blocked. The ratio below
 * is the tripwire, not a rule change: it fires when half or more of the agents
 * are at the suspension threshold, before a full ideation pass is wasted.
 */
export const PRIVILEGE_LIMIT = 3;
export const CONDUCT_SATURATION_RATIO = 0.5;

export function conductSaturationDue(suspended: number, total: number): boolean {
  return total > 0 && suspended / total >= CONDUCT_SATURATION_RATIO;
}
