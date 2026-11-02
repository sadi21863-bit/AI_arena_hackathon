/**
 * Payload for the `partial_judging` warning (2026-11-02).
 *
 * Kept dependency-free so the message/details contract is testable under
 * Node's type stripping; alerts.ts owns the DB insert and dedupe. A partial
 * panel is a degraded result: the score is renormalized to the 0-10 scale, but
 * it is not a full-panel verdict and the missing judge is a provider signal.
 */
export function partialJudgingAlert(
  eventId: string,
  targetType: "idea" | "team",
  targetId: string,
  judges: number,
  panelSize: number,
) {
  return {
    kind: "partial_judging" as const,
    severity: "warning" as const,
    event_id: eventId,
    task_type: targetType === "idea" ? "judge_idea" : "judge_team",
    message:
      `judging finalized ${targetType} ${targetId} with ${judges}/${panelSize} judges after repeated failures ` +
      `in ${eventId}. The score is renormalized over the judges that answered, so it is comparable in scale ` +
      "but noisier than a full panel. Check provider health for the missing judge; do not treat the ranking " +
      "as a full-panel result.",
    details: JSON.stringify({ target_type: targetType, target_id: targetId, judges, panel_size: panelSize }),
  };
}
