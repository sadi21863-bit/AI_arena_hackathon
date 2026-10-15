// Sets a repo secret using the SAME sealed-box construction as
// src/github/repos.ts setRepoSecret.
//
// Why a script instead of the Worker: setTeamRepoSecrets is called ONLY from
// createTeamRepo (repos.ts:673). A repo created before a provider switch never
// receives the new key -- syncTeamHarness re-syncs FILES only, never secrets.
// So switching providers silently bricks every existing team repo with
// "Neither build provider key is configured". This closes that gap for the
// verification run; the durable fix is to call the secret sync on dispatch too.
//
// The sealing is copied verbatim rather than reimplemented because a subtly
// wrong nonce derivation produces a secret GitHub accepts and then cannot
// decrypt -- which looks exactly like a valid-but-broken key. repos.ts documents
// two earlier attempts that got this wrong (see its header comment).
//
// Usage: node scripts/set_repo_secret.mjs <owner/repo> <SECRET_NAME> [valueFromEnvKey]

import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2.js";

const b64ToBytes = (s) => new Uint8Array(Buffer.from(s, "base64"));
const bytesToB64 = (b) => Buffer.from(b).toString("base64");

function sealSecret(publicKeyBase64, value) {
  const recipientPublicKey = b64ToBytes(publicKeyBase64);
  const message = new TextEncoder().encode(value);
  const ephemeral = nacl.box.keyPair();

  const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipientPublicKey.length);
  nonceInput.set(ephemeral.publicKey, 0);
  nonceInput.set(recipientPublicKey, ephemeral.publicKey.length);
  const nonce = blake2b(nonceInput, { dkLen: nacl.box.nonceLength });

  const ciphertext = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
  const sealed = new Uint8Array(ephemeral.publicKey.length + ciphertext.length);
  sealed.set(ephemeral.publicKey, 0);
  sealed.set(ciphertext, ephemeral.publicKey.length);
  return bytesToB64(sealed);
}

const [repoFull, secretName, envKey] = process.argv.slice(2);
if (!repoFull || !secretName || !envKey) {
  console.error("usage: node scripts/set_repo_secret.mjs <owner/repo> <SECRET_NAME> <ENV_KEY_IN_DOTENV>");
  process.exit(2);
}

const [owner, repo] = repoFull.split("/");

// Read the token and the secret value from .env without echoing either.
const fs = await import("node:fs");
const dotenv = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Za-z_][A-Za-z_0-9]*\s*=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const token = dotenv.GITHUB_TOKEN;
const value = dotenv[envKey];
if (!token) throw new Error("GITHUB_TOKEN not in .env");
if (!value) throw new Error(`${envKey} not in .env`);

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

const pkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, { headers });
if (!pkRes.ok) throw new Error(`public-key: ${pkRes.status} ${await pkRes.text()}`);
const { key, key_id } = await pkRes.json();

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ encrypted_value: sealSecret(key, value), key_id }),
});
const body = await res.text();
console.log(`  ${secretName} on ${repoFull}: HTTP ${res.status}${body ? " " + body : ""}`);
if (!res.ok) process.exit(1);
console.log(`  (value length ${value.length}, never printed)`);