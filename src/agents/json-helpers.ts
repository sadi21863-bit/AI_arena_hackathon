/**
 * JSON extraction from LLM output — ported from the user's ideaconnect
 * project (lib/agents/json-helpers.ts). Models routinely wrap structured
 * output in markdown code fences or add prose before/after the JSON; every
 * Arena agent call expecting structured output (ideas, critiques, judge
 * scores §13) needs this, not just the ones that happen to hit the problem
 * first.
 */

export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

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
