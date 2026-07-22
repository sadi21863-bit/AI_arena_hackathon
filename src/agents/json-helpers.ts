/**
 * JSON extraction from LLM output — ported from the user's ideaconnect
 * project (lib/agents/json-helpers.ts). Models routinely wrap structured
 * output in markdown code fences or add prose before/after the JSON; every
 * Arena agent call expecting structured output (ideas, critiques, judge
 * scores §13) needs this, not just the ones that happen to hit the problem
 * first.
 */

export function extractJson<T = unknown>(text: string): T | null {
  // Defensive, not paranoid: found live (2026-07-22, Week 5 judging) that
  // some provider response occasionally comes back non-string (a judge
  // score call crashed the whole processQueue batch with "text.replace is
  // not a function" — root provider-side cause wasn't pinned down, but this
  // function should degrade to "couldn't parse" either way, not crash the
  // caller over an API response shape it didn't expect).
  if (typeof text !== "string") return null;

  // Strip reasoning-model <think>...</think> blocks first (ideaconnect
  // precedent — router.ts's judging/architecture task types route to
  // gpt-oss-120b/deepseek-r1-distill-qwen-32b, both reasoning models that
  // can emit a "{" inside their visible chain-of-thought prose before the
  // real answer; without this, the brace-matching below can lock onto that
  // stray brace instead of the actual JSON object).
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : withoutThinking;

  const start = candidate.search(/[{[]/);
  if (start === -1) return null;

  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === opener) depth++;
    else if (candidate[i] === closer) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
