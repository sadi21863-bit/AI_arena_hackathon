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
 * Team pinning mirrors team-build-turn.yml's TEAM_KEY_PIN, with a second
 * account per team since 2026-11-27: alpha 1 -> 3, beta 2 -> 4. Keep both in
 * step; together they decide which account a team's turns spend. The pairs
 * are disjoint, so one team's exhausted day cannot consume the other's.
 *
 * Measured 2026-11-01: the original two keys were two SEPARATE OpenRouter
 * accounts (distinct creator_user_id and workspace_id, independent daily
 * counters). Measured again 2026-11-27: keys 3/4 are two more independent
 * free accounts. Pinning therefore gives each team 2 x 50 = 100 requests/day,
 * 200/day total. The workflow vetoes cross-team failover; an exhausted team
 * hands off and the scheduler spends its own overflow on the next dispatch.
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

export type OpenRouterAccount = 1 | 2 | 3 | 4;
export type OpenRouterKeyPin = "KEY_1" | "KEY_2" | "KEY_3" | "KEY_4";

export interface OpenRouterKeys {
  key1?: string;
  key2?: string;
  key3?: string;
  key4?: string;
}

/** The key behind one account slot. */
export function keyForAccount(keys: OpenRouterKeys, account: OpenRouterAccount): string | undefined {
  switch (account) {
    case 1: return keys.key1;
    case 2: return keys.key2;
    case 3: return keys.key3;
    case 4: return keys.key4;
  }
}

export function pinForAccount(account: OpenRouterAccount): OpenRouterKeyPin {
  return `KEY_${account}` as OpenRouterKeyPin;
}

/**
 * Accounts a team may spend, in order. Since 2026-11-27 each team owns TWO
 * independent accounts: alpha 1 -> 3, beta 2 -> 4. When accounts 3/4 are not
 * configured this is the old single-account posture. Beta with key 2 unset
 * still falls back to account 1 (and its overflow 3), matching the historical
 * rule; it never reaches accounts 2/4 unless key 2 is configured.
 *
 * Crucially the two lists are disjoint: one team exhausting its day can never
 * borrow the other team's budget. This is the isolation the 2026-10-17 dead-pin
 * incident and the 2026-11-01 two-account decision were protecting.
 */
export function openRouterAccountsForTeam(teamName: string, keys: OpenRouterKeys): OpenRouterAccount[] {
  const owned: OpenRouterAccount[] = teamName === "beta" && keys.key2 ? [2, 4] : [1, 3];
  return owned.filter((account) => !!keyForAccount(keys, account));
}

/**
 * Legacy single-account view, used by hold attribution and the two-key admin
 * probes. The first configured account for the team is still the primary pin.
 */
export function openRouterAccountForTeam(
  teamName: string,
  key2?: string,
): OpenRouterAccount {
  return teamName === "beta" && key2 ? 2 : 1;
}

/**
 * First configured key for a team (the primary pin). Mirrors the workflow's
 * default TEAM_KEY_PIN when no dispatch-selected pin is supplied.
 */
export function openRouterKeyForTeam(
  teamName: string,
  key1: string | undefined,
  key2: string | undefined,
  key3?: string,
  key4?: string,
): string | undefined {
  const keys: OpenRouterKeys = { key1, key2, key3, key4 };
  const accounts = openRouterAccountsForTeam(teamName, keys);
  return keyForAccount(keys, accounts[0] ?? 1);
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
