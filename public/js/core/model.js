/**
 * Domain model — the Arena's own vocabulary, in one place.
 *
 * The phase tables below mirror src/events/scheduler.ts (`phaseForDay` /
 * `hackathonPhaseForDay`). Keeping one copy is the point: live.html's stepper
 * had silently omitted `collaboration` ever since that phase was added, so
 * the UI showed a 5-day ideathon for a 6-day event. If scheduler.ts changes,
 * this table is the single thing to update.
 */

/** Ideathon phases in order, with the day offsets scheduler.ts uses. */
export const IDEATHON_PHASES = [
  { id: "deep_research",      label: "Deep Research",      short: "Research" },
  { id: "ideation_critique",  label: "Ideation + Critique", short: "Critique" },
  { id: "collaboration",      label: "Collaboration",      short: "Collab" },
  { id: "architecture",       label: "Architecture",       short: "Arch" },
  { id: "ready_for_judging",  label: "Judging",            short: "Judging" },
  { id: "judged",             label: "Judged",             short: "Judged" },
];

export const HACKATHON_PHASES = [
  { id: "team_formation",     label: "Team Formation",     short: "Teams" },
  { id: "building",           label: "Building",           short: "Building" },
  { id: "ready_for_judging",  label: "Judging",            short: "Judging" },
  { id: "judged",             label: "Judged",             short: "Judged" },
  { id: "tribunal",           label: "Tribunal",           short: "Tribunal" },
  { id: "complete",           label: "Complete",           short: "Complete" },
];

export function phasesFor(type) {
  return type === "hackathon" ? HACKATHON_PHASES : IDEATHON_PHASES;
}

export function phaseLabel(event) {
  if (!event) return "";
  const match = phasesFor(event.type).find((p) => p.id === event.status);
  return match ? match.label : event.status;
}

export function phaseIndex(event) {
  if (!event) return -1;
  return phasesFor(event.type).findIndex((p) => p.id === event.status);
}

/** An ideathon is done at 'judged'; a hackathon runs on to 'complete'. */
export function isTerminal(event) {
  if (!event) return false;
  return event.type === "hackathon" ? event.status === "complete" : event.status === "judged";
}

export function isLive(event) { return !!event && !isTerminal(event); }

export const typeLabel = (t) => (t === "hackathon" ? "Hackathon" : "Ideathon");

/**
 * An Arena is one ideathon plus the hackathon that advanced from it — the
 * hackathon row carries `parent_event_id`. GET /events already returns that
 * column, so the pairing is derived here rather than needing an endpoint.
 *
 * Returned newest-first; `ordinal` counts from the oldest so cycle numbers
 * stay stable as new ones appear.
 */
export function toCycles(events) {
  const list = events || [];
  const ideathons = list
    .filter((e) => e.type === "ideathon")
    .sort((a, b) => String(a.start_date || "").localeCompare(String(b.start_date || "")));

  const cycles = ideathons.map((ideathon, i) => {
    const hackathon = list.find((e) => e.type === "hackathon" && e.parent_event_id === ideathon.id) || null;
    return {
      id: ideathon.id,
      ordinal: i + 1,
      ideathon,
      hackathon,
      startDate: ideathon.start_date,
      endDate: (hackathon || ideathon).end_date,
      /* The Arena is only finished once BOTH halves are — that is what makes
         a cycle a cycle rather than two loosely related rows. */
      isLive: isLive(ideathon) || (hackathon ? isLive(hackathon) : true),
      /* Whichever half is currently doing the work — what queue health and
         agent activity should actually be read from. */
      activeEvent: isLive(ideathon) ? ideathon : (hackathon || ideathon),
    };
  });

  return cycles.reverse();
}

export function currentCycle(events) {
  return toCycles(events)[0] || null;
}

export function findCycle(events, ideathonId) {
  return toCycles(events).find((c) => c.id === ideathonId) || null;
}
