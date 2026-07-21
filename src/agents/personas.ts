/**
 * The 12 Agents — spec §4.
 *
 * Roster metadata (id/name/lens/role) is static here since it's fixed by
 * spec and needed without a DB round-trip (listing, validation). The full
 * persona system-prompt text lives in D1's archive_agents.persona column
 * (seeded once via db/seed_agents.sql) rather than duplicated here — one
 * source of truth, no risk of the two drifting apart.
 */

export type AgentId =
  | "agent_alex" | "agent_blake" | "agent_casey" | "agent_drew"
  | "agent_ellis" | "agent_finn" | "agent_gale" | "agent_hale"
  | "agent_iris" | "agent_jade" | "agent_kai" | "agent_leo";

export interface AgentMeta {
  id: AgentId;
  name: string;
  lens: string;
  role: string;
}

export const AGENTS: AgentMeta[] = [
  { id: "agent_alex", name: "Alex", lens: "Friction Hunter", role: "Finds user pain points" },
  { id: "agent_blake", name: "Blake", lens: "Regulation Gap", role: "Tracks legal/compliance opportunities" },
  { id: "agent_casey", name: "Casey", lens: "Demographic Analyst", role: "Finds underserved populations" },
  { id: "agent_drew", name: "Drew", lens: "Tech Fusion", role: "Maps technology convergence" },
  { id: "agent_ellis", name: "Ellis", lens: "Cost Optimizer", role: "Finds workflow automation" },
  { id: "agent_finn", name: "Finn", lens: "Cultural Shifts", role: "Tracks behavioral trends" },
  { id: "agent_gale", name: "Gale", lens: "Failure Forensic", role: "Analyzes dead startups" },
  { id: "agent_hale", name: "Hale", lens: "Academic Translator", role: "Commercializes research papers" },
  { id: "agent_iris", name: "Iris", lens: "Global Strategist", role: "Cross-region opportunities" },
  { id: "agent_jade", name: "Jade", lens: "Schema Validator", role: "Validates structure, enforces rules" },
  { id: "agent_kai", name: "Kai", lens: "Team Facilitator", role: "Coordinates collaboration" },
  { id: "agent_leo", name: "Leo", lens: "Pattern Historian", role: "Recognizes temporal patterns" },
];

export function isAgentId(id: string): id is AgentId {
  return AGENTS.some((a) => a.id === id);
}

export interface AgentRow {
  id: string;
  name: string;
  persona: string;
  lens: string;
  total_ideas_submitted: number;
  total_wins: number;
  total_collaborations: number;
  total_critiques_given: number;
  total_critiques_received: number;
  win_rate: number;
  current_status: string;
}

export async function getAgent(env: { DB: D1Database }, id: string): Promise<AgentRow | null> {
  return env.DB.prepare(`SELECT * FROM archive_agents WHERE id = ?`).bind(id).first<AgentRow>();
}

export async function listAgents(env: { DB: D1Database }): Promise<AgentRow[]> {
  const result = await env.DB.prepare(`SELECT * FROM archive_agents ORDER BY id`).all<AgentRow>();
  return result.results;
}
