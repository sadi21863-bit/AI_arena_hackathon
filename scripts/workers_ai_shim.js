#!/usr/bin/env node
/**
 * Workers AI compatibility shim — the real fix for P0-0a's second crash
 * (`AI_InvalidResponseDataError: Expected 'id' to be a string.`).
 *
 * ## Why this exists
 *
 * docs/INVESTIGATION_2026-07-28.md concluded the crash was probably specific
 * to the GitHub Actions sandbox, because the identical prompt/model/config ran
 * clean outside Docker. That conclusion was wrong, and this file replaces it.
 * What actually happens:
 *
 *   - The error string belongs to the Vercel AI SDK, not to OpenCode and not
 *     to the sandbox. `@ai-sdk/openai-compatible` (docker/opencode.json's npm
 *     provider) validates every `tool_calls[].id` against the OpenAI spec,
 *     which requires a string, and throws `AI_InvalidResponseDataError` when
 *     it isn't one. Reported upstream against other providers whose models
 *     emit integer ids.
 *   - Cloudflare's 2026-02-17 changelog: "/v1/chat/completions now preserves
 *     original tool call IDs from models instead of regenerating them."
 *     Before that, every id was a Cloudflare-generated string and this class
 *     of bug was impossible; after it, whatever `@cf/openai/gpt-oss-120b`
 *     emits reaches the client untouched.
 *
 * That combination explains the evidence the "sandbox" theory never could:
 * the crash landing on the ~5th tool call after four clean round trips, and a
 * single un-sandboxed local run passing. It is a per-tool-call property of the
 * model's output, so it is nondeterministic — one clean local run was one
 * lucky sample, not a control proving the sandbox guilty.
 *
 * ## What it does
 *
 * Runs on the Actions runner (not inside the sandbox) between OpenCode and
 * Cloudflare, and normalizes both directions:
 *
 *   response  tool_calls[].id -> String(id)   the actual crash
 *   request   assistant content null -> ""    a second real incompatibility
 *                                             the same investigation hit
 *                                             directly against the API
 *
 * Both are lossless for well-formed traffic: a string id is already a string,
 * and only assistant messages that carry tool_calls are touched.
 *
 * ## Why it also holds the credential
 *
 * Because the shim injects `Authorization` itself, CF_API_TOKEN no longer has
 * to be handed to the container at all. The sandbox's whole egress-filtering
 * design (Squid + DOCKER-USER) exists to stop an --auto agent exfiltrating
 * that token; not putting it in the container is strictly better than
 * containing it.
 *
 * Exports its transforms so they can be tested without a network or an API
 * key — see scripts/test_workers_ai_shim.js.
 */

"use strict";

const http = require("http");
const https = require("https");

/**
 * Coerces non-string tool-call ids to strings, in place, for one parsed
 * response object. Handles both shapes the API returns: `choices[].delta`
 * while streaming and `choices[].message` when not.
 *
 * null/undefined ids are deliberately left alone rather than stringified —
 * String(null) would invent the id "null" and silently break the tool-result
 * correlation that ids exist for, turning a loud crash into a wrong answer.
 * Only values that are genuinely present but mistyped (numbers, mainly) are
 * converted.
 */
function normalizeToolCallIds(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];

  for (const choice of choices) {
    for (const container of [choice?.delta, choice?.message]) {
      const toolCalls = container && Array.isArray(container.tool_calls) ? container.tool_calls : null;
      if (!toolCalls) continue;
      for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        if ("id" in call && call.id !== null && call.id !== undefined && typeof call.id !== "string") {
          call.id = String(call.id);
        }
      }
    }
  }
  return payload;
}

/**
 * Replaces `content: null` with "" on assistant messages that carry
 * tool_calls. Workers AI's schema validator rejects the standard OpenAI
 * convention of a null content there ("Type mismatch of
 * '/messages/2/content', 'string' not in 'null'"), observed directly against
 * the live endpoint on 2026-07-28. Cloudflare's changelog claims this was
 * fixed on 2026-02-17, so this may now be redundant — it is kept because it
 * costs nothing on already-valid traffic and the observation is more recent
 * than the changelog entry.
 */
function normalizeRequestBody(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant" && message.content === null && Array.isArray(message.tool_calls)) {
      message.content = "";
    }
  }
  return payload;
}

/**
 * Stateful SSE rewriter. Returns a function taking a raw chunk and returning
 * the rewritten bytes to forward.
 *
 * Buffers until a frame terminator arrives, because SSE frames split across
 * TCP chunks at arbitrary offsets — parsing per-chunk instead of per-frame
 * would corrupt exactly the long multi-tool-call streams this is meant to
 * fix. `flush()` returns whatever trailing bytes never got terminated so a
 * truncated stream is passed through rather than swallowed.
 */
function createSseRewriter() {
  let buffer = "";

  const rewriteFrame = (frame) => {
    // A frame is one or more lines; only `data:` lines carry JSON, and
    // `data: [DONE]` is a sentinel that must pass through untouched.
    return frame
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const raw = line.slice("data:".length).trim();
        if (raw === "" || raw === "[DONE]") return line;
        try {
          return "data: " + JSON.stringify(normalizeToolCallIds(JSON.parse(raw)));
        } catch {
          return line; // not JSON we understand — forward verbatim, never drop
        }
      })
      .join("\n");
  };

  return {
    push(chunk) {
      buffer += chunk;
      let out = "";
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        out += rewriteFrame(buffer.slice(0, index)) + "\n\n";
        buffer = buffer.slice(index + 2);
      }
      return out;
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return rest ? rewriteFrame(rest) : "";
    },
  };
}

function startServer({ port, accountId, apiToken }) {
  const upstreamBase = `/client/v4/accounts/${accountId}/ai/v1`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);

      // Only rewrite bodies we can parse as JSON; anything else is forwarded
      // byte-for-byte rather than guessed at.
      if (body.length) {
        try {
          body = Buffer.from(JSON.stringify(normalizeRequestBody(JSON.parse(body.toString("utf8")))), "utf8");
        } catch {
          /* forward unchanged */
        }
      }

      const suffix = req.url.replace(/^\/v1/, "");
      const headers = {
        "content-type": req.headers["content-type"] || "application/json",
        "content-length": Buffer.byteLength(body),
        // Injected here, so the sandbox never holds the credential.
        authorization: `Bearer ${apiToken}`,
        accept: req.headers.accept || "*/*",
      };

      const upstream = https.request(
        { hostname: "api.cloudflare.com", port: 443, path: upstreamBase + suffix, method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode || 502, {
            "content-type": up.headers["content-type"] || "application/json",
            // No content-length: rewriting changes byte counts, and the
            // streaming case has none anyway.
            "cache-control": up.headers["cache-control"] || "no-cache",
          });

          const isStream = String(up.headers["content-type"] || "").includes("text/event-stream");
          if (isStream) {
            const rewriter = createSseRewriter();
            up.setEncoding("utf8");
            up.on("data", (chunk) => res.write(rewriter.push(chunk)));
            up.on("end", () => {
              res.write(rewriter.flush());
              res.end();
            });
          } else {
            const outChunks = [];
            up.on("data", (c) => outChunks.push(c));
            up.on("end", () => {
              const raw = Buffer.concat(outChunks).toString("utf8");
              try {
                res.end(JSON.stringify(normalizeToolCallIds(JSON.parse(raw))));
              } catch {
                res.end(raw);
              }
            });
          }
        }
      );

      upstream.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `shim upstream error: ${err.message}` } }));
      });

      upstream.end(body);
    });
  });

  // 0.0.0.0 so the sandboxed container can reach it via host.docker.internal.
  // The runner is a single-use ephemeral VM and the DOCKER-USER rules still
  // block the container from reaching anything else.
  server.listen(port, "0.0.0.0", () => {
    console.log(`workers-ai shim listening on ${port} -> api.cloudflare.com${upstreamBase}`);
  });
  return server;
}

module.exports = { normalizeToolCallIds, normalizeRequestBody, createSseRewriter, startServer };

if (require.main === module) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error("CF_ACCOUNT_ID and CF_API_TOKEN must be set");
    process.exit(1);
  }
  startServer({ port: Number(process.env.SHIM_PORT || 3129), accountId, apiToken });
}
