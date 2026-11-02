#!/usr/bin/env node
/**
 * Quota probe — measure each configured OpenRouter account (2026-11-01).
 *
 * The quota posture was documented as one account with two keys. `GET
 * /api/v1/key` returns `creator_user_id`, `workspace_id` and the per-account
 * `free_model_daily_requests` counter, which is what distinguishes two keys on
 * one account from two independent accounts. This script makes that check
 * repeatable after a rotation, without printing key values.
 *
 * It prints only the key's masked label (OpenRouter masks it), a hash prefix of
 * the account/workspace ids, and the free-tier counters.
 *
 * Usage: node scripts/quota_probe.mjs [--json]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = process.argv.includes("--json");

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...readEnvFile(path.join(root, ".env")), ...process.env };
const slots = [
  { slot: "account_1", names: ["OPEN_ROUTER_API_KEY_1", "OPEN_ROUTER_API_KEY"] },
  { slot: "account_2", names: ["OPEN_ROUTER_API_KEY_2"] },
];
const sha8 = (value) =>
  value ? crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8) : null;
// A provider error body is untrusted text; never let it echo the key.
const redact = (text, secret) =>
  secret ? String(text).split(secret).join("[redacted]") : String(text);

const results = [];
for (const { slot, names } of slots) {
  const name = names.find((n) => env[n]);
  if (!name) {
    results.push({ slot, configured: false });
    continue;
  }
  const row = { slot, configured: true, env_name: name };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${env[name]}` },
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    row.http_status = res.status;
    const data = body.data;
    if (!res.ok || !data) {
      row.error = redact(JSON.stringify(body.error ?? body), env[name]).slice(0, 200);
    } else {
      row.key_label = data.label ?? null;
      row.account_sha8 = sha8(data.creator_user_id);
      row.workspace_sha8 = sha8(data.workspace_id);
      row.free_tier = data.is_free_tier ?? null;
      row.daily_used = data.free_model_daily_requests?.used ?? null;
      row.daily_limit = data.free_model_daily_requests?.limit ?? null;
      row.daily_remaining = data.free_model_daily_requests?.remaining ?? null;
      row.expires_at = data.expires_at ?? null;
    }
  } catch (err) {
    row.error = redact(err instanceof Error ? err.message : String(err), env[name]);
  }
  results.push(row);
}

if (jsonOut) {
  console.log(JSON.stringify({ checked_at: new Date().toISOString(), accounts: results }, null, 2));
} else {
  for (const row of results) {
    if (!row.configured) {
      console.log(`${row.slot}: not configured`);
      continue;
    }
    if (row.error) {
      console.log(`${row.slot} (${row.env_name}): error ${row.error}`);
      continue;
    }
    console.log(
      `${row.slot} (${row.env_name}): account ${row.account_sha8} workspace ${row.workspace_sha8} ` +
        `key ${row.key_label} free_tier=${row.free_tier} daily=${row.daily_used}/${row.daily_limit} ` +
        `remaining=${row.daily_remaining} expires=${row.expires_at}`,
    );
  }
  const ids = results.filter((row) => row.account_sha8).map((row) => row.account_sha8);
  if (ids.length === 2) {
    console.log(
      ids[0] === ids[1]
        ? "VERDICT: same account (keys share one free-tier daily cap)"
        : "VERDICT: two independent accounts (separate daily counters)",
    );
  }
}

if (results.some((row) => row.configured && row.error)) process.exitCode = 1;
