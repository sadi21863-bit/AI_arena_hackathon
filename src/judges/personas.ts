/**
 * The Seven Judges — spec §13. Each judge scores one criterion, with
 * different weight in the ideathon vs. hackathon phase (e.g. Reed's Code
 * Quality is 5% ideathon / 20% hackathon — there's no real code to judge
 * until the hackathon exists).
 */
export interface Judge {
  name: string;
  criterion: string;
  ideathonWeight: number;
  hackathonWeight: number;
}

export const JUDGES: Judge[] = [
  { name: "Mason", criterion: "Technical Feasibility", ideathonWeight: 0.20, hackathonWeight: 0.20 },
  { name: "Nora", criterion: "Market Viability", ideathonWeight: 0.20, hackathonWeight: 0.15 },
  { name: "Owen", criterion: "Novelty", ideathonWeight: 0.20, hackathonWeight: 0.10 },
  { name: "Piper", criterion: "Ethics & Impact", ideathonWeight: 0.15, hackathonWeight: 0.10 },
  { name: "Quinn", criterion: "Narrative Clarity", ideathonWeight: 0.15, hackathonWeight: 0.10 },
  { name: "Reed", criterion: "Code Quality", ideathonWeight: 0.05, hackathonWeight: 0.20 },
  { name: "Sage", criterion: "UX & Accessibility", ideathonWeight: 0.05, hackathonWeight: 0.15 },
];
