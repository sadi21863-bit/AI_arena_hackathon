/**
 * Build-account identity probe (2026-11-01).
 *
 * The quota posture depends on a fact the Worker cannot read from config: are
 * `OPEN_ROUTER_API_KEY` and `OPEN_ROUTER_API_KEY_2` two independent OpenRouter
 * accounts (2 x 50 free requests/day) or two keys on one account (50/day)?
 * Secret values are write-only, so after a rotation the only way to know is to
 * ask the provider with the configured value.
 *
 * `GET /admin/quota/accounts` calls this. It reports only:
 *   - whether each slot is configured,
 *   - the SHA-256 prefix of `creator_user_id` / `workspace_id`,
 *   - the free-tier daily counters.
 *
 * It never returns either key, and it never returns the raw account ids — the
 * hashes match `scripts/quota_probe.mjs`, so local and production measurements
 * are directly comparable.
 */
import type { Env } from "../env";

export interface AccountProbe {
  slot: 1 | 2;
  env_name: string;
  configured: boolean;
  http_status: number | null;
  account_sha8: string | null;
  workspace_sha8: string | null;
  free_tier: boolean | null;
  daily_used: number | null;
  daily_limit: number | null;
  daily_remaining: number | null;
  expires_at: string | null;
  error: string | null;
}

export interface AccountProbeResult {
  checked_at: string;
  accounts: AccountProbe[];
  independent: boolean | null;
  verdict: string;
}

/**
 * null means "cannot decide" (a slot is unset or the probe failed); callers
 * must not present that as independence.
 */
export function accountIndependence(
  account1: string | null,
  account2: string | null,
): boolean | null {
  if (!account1 || !account2) return null;
  return account1 !== account2;
}

async function sha8(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || value.length === 0) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function probeAccount(
  slot: 1 | 2,
  envName: string,
  key: string | undefined,
): Promise<AccountProbe> {
  const empty: AccountProbe = {
    slot,
    env_name: envName,
    configured: false,
    http_status: null,
    account_sha8: null,
    workspace_sha8: null,
    free_tier: null,
    daily_used: null,
    daily_limit: null,
    daily_remaining: null,
    expires_at: null,
    error: null,
  };
  if (!key) return empty;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: {
        creator_user_id?: unknown;
        workspace_id?: unknown;
        is_free_tier?: unknown;
        expires_at?: unknown;
        free_model_daily_requests?: {
          used?: unknown;
          limit?: unknown;
          remaining?: unknown;
        };
      };
      error?: unknown;
    };
    const data = body.data;
    if (!res.ok || !data) {
      return {
        ...empty,
        configured: true,
        http_status: res.status,
        error: JSON.stringify(body.error ?? body).slice(0, 200),
      };
    }
    const daily = data.free_model_daily_requests;
    return {
      slot,
      env_name: envName,
      configured: true,
      http_status: res.status,
      account_sha8: await sha8(data.creator_user_id),
      workspace_sha8: await sha8(data.workspace_id),
      free_tier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
      daily_used: numberOrNull(daily?.used),
      daily_limit: numberOrNull(daily?.limit),
      daily_remaining: numberOrNull(daily?.remaining),
      expires_at: typeof data.expires_at === "string" ? data.expires_at : null,
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeOpenRouterAccounts(env: Env): Promise<AccountProbeResult> {
  const [account1, account2] = await Promise.all([
    probeAccount(1, "OPEN_ROUTER_API_KEY", env.OPEN_ROUTER_API_KEY),
    probeAccount(2, "OPEN_ROUTER_API_KEY_2", env.OPEN_ROUTER_API_KEY_2),
  ]);
  const accounts = [account1, account2];
  const independent = accountIndependence(
    account1.account_sha8,
    account2.account_sha8,
  );

  let verdict: string;
  if (!account1.configured && !account2.configured) {
    verdict = "no account configured";
  } else if (!account2.configured) {
    verdict = "account 2 not configured — single-account posture (50/day)";
  } else if (account1.error || account2.error) {
    verdict = "probe failed — independence unknown; do not assume 100/day";
  } else if (independent === true) {
    verdict = "two independent accounts (separate daily counters)";
  } else if (independent === false) {
    verdict = "SAME account — the two keys share one 50/day cap";
  } else {
    verdict = "independence unknown — the provider did not return account ids";
  }

  return {
    checked_at: new Date().toISOString(),
    accounts,
    independent,
    verdict,
  };
}
