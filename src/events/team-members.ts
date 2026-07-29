/**
 * Team rosters for the hackathon.
 *
 * Membership has to do something or it is decoration. Build turns rotate
 * through a team's roster and the turn prompt is written from that member's
 * persona and build role, so who holds the turn changes what gets built —
 * the Schema Validator's turn should tighten contracts and tests, the
 * Friction Hunter's should attack the rough edges of the flow.
 */

import type { Env } from "../env";
import { AGENTS, type AgentId } from "../agents/personas";

/**
 * Each agent's ideation lens, restated as what it means while building.
 * Keyed by lens rather than id so a roster change doesn't silently drop
 * someone to a generic role.
 */
const BUILD_ROLE_BY_LENS: Record<string, string> = {
  "Friction Hunter":     "UX & rough edges — makes the primary flow actually usable",
  "Regulation Gap":      "Compliance & data handling — consent, retention, disclaimers",
  "Demographic Analyst": "Accessibility & reach — works for the people it claims to serve",
  "Tech Fusion":         "Integrations — wires the external services the idea depends on",
  "Cost Optimizer":      "Performance & efficiency — cuts waste in the hot paths",
  "Cultural Shifts":     "Copy & tone — the product sounds like it means it",
  "Failure Forensic":    "Reliability — error paths, retries, the ways this breaks",
  "Academic Translator": "Core algorithm — the hard logic at the centre",
  "Global Strategist":   "Configuration & portability — not hardcoded to one context",
  "Schema Validator":    "Data model & tests — schemas, validation, coverage",
  "Team Facilitator":    "Structure & docs — the repo is navigable by the next turn",
  "Pattern Historian":   "Refactoring — removes the duplication earlier turns left",
};

export function buildRoleFor(agentId: string): string {
  const agent = AGENTS.find((a) => a.id === agentId);
  return (agent && BUILD_ROLE_BY_LENS[agent.lens]) || "Generalist — moves the build forward";
}

export interface TeamMemberRow {
  team_id: string;
  agent_id: string;
  membership: string;
  build_role: string;
  turns_taken: number;
}

/**
 * Assign all 12 agents across the two teams.
 *
 * The idea's author leads the team building it (and a co-author from a merge
 * leads alongside them) — anything else would have an agent watching someone
 * else build the idea they pitched. Everyone not leading is split evenly and
 * deterministically by roster order, so the same event always produces the
 * same rosters and a re-run of team formation is idempotent.
 */
export async function assignTeamMembers(
  env: Env,
  input: {
    eventId: string;
    teams: Array<{ teamId: string; ideaAgentId: string; ideaCoAgentId: string | null }>;
  }
): Promise<void> {
  const leadOf = new Map<string, string[]>();
  const claimed = new Set<string>();

  for (const team of input.teams) {
    const leads = [team.ideaAgentId, team.ideaCoAgentId].filter(
      (id): id is string => !!id && !claimed.has(id)
    );
    leads.forEach((id) => claimed.add(id));
    leadOf.set(team.teamId, leads);
  }

  const rest = AGENTS.map((a) => a.id as string).filter((id) => !claimed.has(id));
  const perTeam = new Map<string, string[]>(input.teams.map((t) => [t.teamId, []]));
  rest.forEach((id, i) => {
    const team = input.teams[i % input.teams.length];
    perTeam.get(team.teamId)!.push(id);
  });

  const stmts = [];
  for (const team of input.teams) {
    for (const agentId of leadOf.get(team.teamId) ?? []) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO hackathon_team_members (team_id, agent_id, event_id, membership, build_role)
         VALUES (?, ?, ?, 'lead', ?)`
      ).bind(team.teamId, agentId, input.eventId, buildRoleFor(agentId)));
    }
    for (const agentId of perTeam.get(team.teamId) ?? []) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO hackathon_team_members (team_id, agent_id, event_id, membership, build_role)
         VALUES (?, ?, ?, 'builder', ?)`
      ).bind(team.teamId, agentId, input.eventId, buildRoleFor(agentId)));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/**
 * Whose turn is it? Fewest turns taken first, leads breaking the tie, then
 * roster order — so the lead opens the build and nobody is skipped twice.
 * Returns null for teams formed before rosters existed, and the caller keeps
 * its previous un-attributed prompt in that case.
 */
export async function nextBuildAuthor(env: Env, teamId: string): Promise<TeamMemberRow | null> {
  return env.DB.prepare(
    `SELECT team_id, agent_id, membership, build_role, turns_taken
     FROM hackathon_team_members
     WHERE team_id = ?
     ORDER BY turns_taken ASC, (membership = 'lead') DESC, agent_id ASC
     LIMIT 1`
  ).bind(teamId).first<TeamMemberRow>();
}

export async function recordTurnTaken(env: Env, teamId: string, agentId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE hackathon_team_members SET turns_taken = turns_taken + 1 WHERE team_id = ? AND agent_id = ?`
  ).bind(teamId, agentId).run();
}

export async function rosterFor(env: Env, eventId: string): Promise<TeamMemberRow[]> {
  const rows = await env.DB.prepare(
    `SELECT team_id, agent_id, membership, build_role, turns_taken
     FROM hackathon_team_members WHERE event_id = ?
     ORDER BY team_id, (membership = 'lead') DESC, agent_id`
  ).bind(eventId).all<TeamMemberRow>();
  return rows.results;
}

/** The persona-flavoured preamble for a build turn taken by this member. */
export function turnAttribution(member: TeamMemberRow): string {
  const agent = AGENTS.find((a) => a.id === member.agent_id);
  const name = agent ? agent.name : member.agent_id;
  const lens = agent ? agent.lens : "";
  return `You are ${name}${lens ? `, the ${lens}` : ""}, taking this team's build turn.\n` +
    `Your responsibility on this codebase: ${member.build_role}.\n` +
    `Work in that direction specifically — do not attempt everything at once.\n\n`;
}

export type { AgentId };
