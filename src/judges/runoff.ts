/**
 * N-3 (docs/ARENA_BACKLOG.md) — pairwise runoff for near-ties.
 *
 * Top-2 selection is a straight cut on absolute weighted scores. A real event
 * advanced 7.05 and 6.90 — a 0.15 gap, comfortably inside judge noise, and
 * the thing that gap decides is which idea gets built and which is discarded.
 *
 * Scoring each entry independently and deriving the ranking afterwards is the
 * right structural choice and this project already does it: it's the standard
 * mitigation for position bias, because no entry is ever shown alongside a
 * competitor it could be dragged up or down by. What it cannot do is resolve a
 * tie — two independent scores 0.15 apart carry no information about which
 * entry is actually better.
 *
 * So the runoff is deliberately narrow: it runs ONLY when the margin is small
 * enough that the absolute scores have stopped being informative, and it is
 * the only place in this system where two entries are compared head to head.
 *
 * ## The position-bias control
 *
 * Direct comparison reintroduces exactly the bias independent scoring avoids —
 * LLM judges favour whichever entry is presented first, regardless of content.
 * The control is to run the comparison in BOTH orderings and count the verdict
 * only when the two agree. A judge that picks "the first one" both times
 * contradicts itself and is discarded; a judge that picks the same ENTRY both
 * times has expressed a preference that survived the ordering flip.
 *
 * An inconclusive runoff is a real and expected outcome, not a failure: it
 * means the two entries are genuinely indistinguishable to the judge, which is
 * the honest answer when scores are 0.15 apart. The caller keeps the existing
 * score order in that case, so a runoff can only ever promote on positive
 * evidence — never on a coin flip.
 */

import type { Env } from "../env";
import { routeInference } from "../router";
import { extractJson } from "../agents/json-helpers";

/**
 * Score gap below which absolute scores are treated as noise rather than
 * signal. 0.35 comfortably covers the observed 0.15 real-event case while
 * staying far under the spread between genuinely different entries — this is
 * a tie-breaker, not a re-ranking of the whole field.
 */
export const RUNOFF_MARGIN = 0.35;

export interface RunoffEntry {
  id: string;
  title: string;
  one_liner: string;
  problem: string;
  solution: string;
}

export type RunoffVerdict = "a" | "b" | "inconclusive";

interface RunoffJson {
  winner: string;
  reason: string;
}

function describe(entry: RunoffEntry, label: string): string {
  return `ENTRY ${label}\nTitle: ${entry.title}\nOne-liner: ${entry.one_liner}\nProblem: ${entry.problem}\nSolution: ${entry.solution}`;
}

/**
 * One comparison in one ordering. Returns which of the two *entries* won by
 * id, so the caller can compare verdicts across orderings without having to
 * track which entry was labelled A in which run.
 */
async function compareOnce(
  env: Env,
  first: RunoffEntry,
  second: RunoffEntry,
  pinnedProvider?: "groq" | "workers_ai"
): Promise<string | null> {
  const prompt =
    `Two competition entries scored within noise of each other on independent judging. ` +
    `Decide which is the stronger entry to build, on substance alone. ` +
    `Length is not quality — do not favour the more elaborately-worded entry. ` +
    `Position is not quality — do not favour whichever is listed first.\n\n` +
    `${describe(first, "A")}\n\n${describe(second, "B")}\n\n` +
    `Respond with ONLY a JSON object: {"winner": "A" | "B", "reason": string (1-2 sentences)}.`;

  const result = await routeInference(env, {
    task_type: "judging",
    prompt,
    max_tokens: 700, // same budget as scoring.ts — judging routes to reasoning models that need room before the visible answer
    pinned_provider: pinnedProvider,
  });
  if (!result) return null;

  const parsed = extractJson<RunoffJson>(result.text);
  const winner = String(parsed?.winner ?? "").trim().toUpperCase();
  if (winner === "A") return first.id;
  if (winner === "B") return second.id;
  return null; // unparseable or off-schema — treated as no verdict, same as a disagreement
}

/**
 * The position-bias control itself, separated from the inference calls so it
 * can be tested directly — this rule is the entire reason the runoff is
 * trustworthy, and "we ran it twice" is worthless if the combining logic
 * quietly accepts a single ordering's answer.
 *
 * Both arguments are winner ids as returned by compareOnce (null = no usable
 * verdict). A result is only produced when the same ENTRY won under both
 * orderings.
 */
export function combineVerdicts(
  forwardWinnerId: string | null,
  reverseWinnerId: string | null,
  aId: string
): RunoffVerdict {
  if (!forwardWinnerId || !reverseWinnerId) return "inconclusive";
  if (forwardWinnerId !== reverseWinnerId) return "inconclusive"; // order decided it, not the content
  return forwardWinnerId === aId ? "a" : "b";
}

/**
 * Head-to-head between two entries, run in both orderings.
 *
 * Returns "a"/"b" only when both orderings named the same entry. Any
 * disagreement, unparseable response, or exhausted inference tier yields
 * "inconclusive" — the caller must fall back to the existing order rather
 * than treating a single ordering's answer as a result.
 *
 * Cost is exactly 2 inference calls, and only for a pair that already
 * qualified as a near-tie, so this cannot grow with the size of the field.
 */
export async function pairwiseRunoff(
  env: Env,
  a: RunoffEntry,
  b: RunoffEntry,
  pinnedProvider?: "groq" | "workers_ai"
): Promise<RunoffVerdict> {
  // Sequential, not Promise.all: judging tasks are the heaviest subrequest
  // consumers in the queue (see processQueue's batch-limit comment) and this
  // runs inside team_formation, which already makes GitHub calls of its own.
  const forward = await compareOnce(env, a, b, pinnedProvider);
  const reverse = await compareOnce(env, b, a, pinnedProvider);
  return combineVerdicts(forward, reverse, a.id);
}
