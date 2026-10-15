/**
 * Free-tier dispatch budget probe.
 *
 * Why this exists (2026-10-15): build turns run on OpenRouter's free tier —
 * 50 model requests per account per UTC day, reset at UTC midnight (not a
 * rolling window). One measured turn consumes ~110 requests, so a turn that
 * reaches the cap has spent the whole day's budget, and any dispatch after it
 * walks into a guaranteed 429 wall: a workflow run, ~10 minutes of retry
 * noise, and a 'failure' row that taught the scheduler nothing. Asking the
 * provider the one question that matters — how much budget is left on this
 * pool — costs a single GET and lets the scheduler hold dispatches until the
 * reset instead.
 *
 * Measured shape of GET https://openrouter.ai/api/v1/key (2026-10-15):
 *   { data: { free_model_daily_requests: { used, limit, remaining } } }
 * `remaining` reported 0 once the cap was spent (used can even exceed limit —
 * 132/50 observed; enforcement is what matters, and it reports remaining 0).
 * A paid key simply has no such field: absence means no free-tier cap
 * applies and this module stays out of the way.
 *
 * Fail-open, deliberately: a probe bug, network blip, or API change must
 * never hold a healthy build (the dispatches it would block are the event's
 * whole output). Worst case of fail-open is one wasted turn; worst case of
 * fail-closed is a stalled event.
 *
 * Cache: per-isolate, keyed by the pool key itself. A blocked answer holds
 * until just past the next UTC midnight — `remaining` only decreases within a
 * UTC day, so re-asking cannot change the answer before the reset. An allowed
 * answer holds for a short TTL, because the other team (or a still-running
 * turn) can spend the pool between cron ticks. Cron ticks land in reused
 * isolates, so the steady state is ~1 probe per pool per day; a recycled
 * isolate costs one more. The probe does not go through the subrequest
 * counter (which audits the GitHub/D1-heavy paths) — it is at most one fetch
 * on a tick that was about to dispatch anyway.
 *
 * Team pinning mirrors team-build-turn.yml's TEAM_KEY_PIN (a repo whose name
 * contains 'beta' -> OPEN_ROUTER_API_KEY_2 when present, else key 1). Keep
 * the two in step; together they decide which account a team's turns spend.
 * Two keys only double the budget when they are two SEPARATE accounts —
 * OpenRouter's free cap is per account, not per key.
 */

export interface QuotaDecision {
  allowed: boolean;
  /** Epoch ms at which this answer should be re-probed. */
  holdUntilMs: number;
}

/**
 * Below this many remaining requests a newly dispatched turn cannot do
 * useful work — it would spend its first requests on opening context and
 * die mid-plan. Tunable; deliberately low, because fail-open above means
 * borderline cases still get to try.
 */
export const QUOTA_DISPATCH_FLOOR = 10;

const ALLOW_TTL_MS = 5 * 60 * 1000;
const RESET_GRACE_MS = 60 * 1000;

/** Epoch ms of the next UTC midnight strictly after nowMs. */
export function nextUtcMidnightAfter(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Which pool a team's turns spend. Mirrors the workflow's TEAM_KEY_PIN:
 * beta is pinned to key 2 when configured, everything else key 1.
 */
export function openRouterKeyForTeam(
  teamName: string,
  key1: string | undefined,
  key2: string | undefined
): string | undefined {
  return teamName === "beta" && key2 ? key2 : key1;
}

/** Pure decision from an /api/v1/key response body. */
export function quotaDecisionFor(body: unknown, nowMs: number): QuotaDecision {
  const remaining = (body as { data?: { free_model_daily_requests?: { remaining?: unknown } } })
    ?.data?.free_model_daily_requests?.remaining;
  if (typeof remaining !== "number") {
    // Paid key, renamed field, unexpected shape: no free cap to enforce.
    return { allowed: true, holdUntilMs: nowMs + ALLOW_TTL_MS };
  }
  if (remaining >= QUOTA_DISPATCH_FLOOR) {
    return { allowed: true, holdUntilMs: nowMs + ALLOW_TTL_MS };
  }
  return { allowed: false, holdUntilMs: nextUtcMidnightAfter(nowMs) + RESET_GRACE_MS };
}

const probeCache = new Map<string, QuotaDecision>();

/**
 * May a build turn be dispatched against this pool right now?
 *
 * Fail-open on every uncertainty (no key, HTTP failure, parse failure) —
 * see the module docblock. `nowMs` is injectable so the decision logic is
 * testable.
 */
export async function buildDispatchBudgetAllows(key: string | undefined, nowMs: number = Date.now()): Promise<boolean> {
  if (!key) return true;
  const cached = probeCache.get(key);
  if (cached && cached.holdUntilMs > nowMs) return cached.allowed;

  let decision: QuotaDecision = { allowed: true, holdUntilMs: nowMs + ALLOW_TTL_MS };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) decision = quotaDecisionFor(await res.json(), nowMs);
  } catch {
    // fail open (see module docblock)
  }
  probeCache.set(key, decision);
  if (!decision.allowed) {
    // Fires once per pool per day (the blocked entry outlives the tick) —
    // say why dispatches went quiet, or the dispatch-rate panel just looks
    // broken.
    console.log("openrouter free-tier daily request cap spent — holding build dispatches on this pool until the UTC reset");
  }
  return decision.allowed;
}
