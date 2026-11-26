/**
 * Build-account identity probe (2026-11-01; four slots since 2026-11-27).
 *
 * The quota posture depends on a fact the Worker cannot read from config: are
 * the configured keys independent OpenRouter accounts (each 50 free
 * requests/day) or several keys on one account (50/day total)?
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
  slot: 1 | 2 | 3 | 4;
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

/** true only when every configured account returned a different id. */
export function accountsIndependent(ids: Array<string | null>): boolean | null {
  const present = ids.filter((id): id is string => !!id);
  if (present.length < 2) return null;
  return new Set(present).size === present.length;
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

/**
 * Provider errors are untrusted text. A malformed or hostile error body could
 * echo the Authorization value, and this endpoint is the one place a key is
 * deliberately sent to a third party. Redact before truncating so a key can
 * never appear even partially.
 */
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

async function probeAccount(
  slot: 1 | 2 | 3 | 4,
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
      // An admin check must not hang the request if the provider stalls.
      signal: AbortSignal.timeout(10000),
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
        error: redact(JSON.stringify(body.error ?? body), key).slice(0, 200),
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
      error: redact(err instanceof Error ? err.message : String(err), key).slice(0, 200),
    };
  }
}

export async function probeOpenRouterAccounts(env: Env): Promise<AccountProbeResult> {
  const [account1, account2, account3, account4] = await Promise.all([
    probeAccount(1, "OPEN_ROUTER_API_KEY", env.OPEN_ROUTER_API_KEY),
    probeAccount(2, "OPEN_ROUTER_API_KEY_2", env.OPEN_ROUTER_API_KEY_2),
    probeAccount(3, "OPEN_ROUTER_API_KEY_3", env.OPEN_ROUTER_API_KEY_3),
    probeAccount(4, "OPEN_ROUTER_API_KEY_4", env.OPEN_ROUTER_API_KEY_4),
  ]);
  const accounts = [account1, account2, account3, account4];
  const independent = accountsIndependent(accounts.map((a) => a.account_sha8));
  const configured = accounts.filter((a) => a.configured);

  let verdict: string;
  if (configured.length === 0) {
    verdict = "no account configured";
  } else if (configured.some((a) => a.error)) {
    verdict = "probe failed — independence unknown; do not assume the full daily budget";
  } else if (independent === true) {
    verdict = `${configured.length} independent accounts — alpha 1/3 and beta 2/4, ${configured.length * 50}/day total`;
  } else if (independent === false) {
    verdict = "DUPLICATE account ids — keys share one daily cap; per-team overflow is not real";
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
