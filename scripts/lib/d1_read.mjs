/** Read-only D1 HTTP helper for operator scripts (no Cloudflare wrangler CLI). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = {};
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const account = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
const databaseId = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8").match(/database_id\s*=\s*"([^"]+)"/)?.[1];
if (!account || !token || !databaseId) throw new Error("Missing Cloudflare credentials or wrangler.toml database_id");

export async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(60000),
    },
  );
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors ?? json)}`);
  return Array.isArray(json.result) ? (json.result[0]?.results ?? []) : (json.result?.results ?? []);
}
