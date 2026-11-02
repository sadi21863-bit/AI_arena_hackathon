/**
 * R1 quota decision (2026-11-02).
 *
 * The design says each agent submits 3 ideas per event: at most one may derive
 * from the agent's own prior work, and two must be fresh (ARENA_CONDUCT_V3.md
 * §2). The implementation used to count *all* prior ideas, apply to `dup`
 * (which R6 says carries no strike), and add a strike for every extra derived
 * idea — a sanction the simulation never modeled. With three evolution-class
 * ideas per agent per event, that added two strikes per agent per event while
 * the clean-arena decay removed one, saturating every ledger and blocking 30 of
 * 33 live ideas on 2026-11-02. Strikes now come only from the measured
 * ≥0.92 ladder (R4); the quota stays a score penalty.
 *
 * Kept dependency-free so the boundary cases are unit-testable.
 */
export const MAX_DERIVED_PER_EVENT = 1;
export const QUOTA_PENALTY = -1.0;

/**
 * `dup` is same-event convergence (R6), not reuse of prior work; `null` is a
 * pre-conduct row and is not derived. Every other class is derived.
 */
export function isDerivedClass(cls: string | null): boolean {
  return cls !== null && cls !== "fresh" && cls !== "dup";
}

/** The R1 score penalty, or 0 when the submission is fresh/dup or is the first derived idea. */
export function quotaPenalty(cls: string | null, derivedSoFar: number): number {
  return isDerivedClass(cls) && derivedSoFar >= MAX_DERIVED_PER_EVENT ? QUOTA_PENALTY : 0;
}
