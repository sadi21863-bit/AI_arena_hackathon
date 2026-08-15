#!/usr/bin/env node
/**
 * Tests for the Workers AI shim's transforms (scripts/workers_ai_shim.js).
 *
 * Runs with no network and no API key: the transforms are pure, so the crash
 * they fix can be reproduced from a synthetic response rather than by burning
 * a CI run and real Neurons hoping the model emits a bad id again. That
 * matters here specifically because the bug is nondeterministic — a live run
 * passing proves nothing, which is how it was misdiagnosed as sandbox-
 * specific in the first place.
 *
 *   node scripts/test_workers_ai_shim.js
 */

"use strict";

const assert = require("assert");
const http = require("http");
const { normalizeToolCallIds, normalizeRequestBody, createSseRewriter, upstreamPathFor, startServer } = require("./workers_ai_shim");

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
};

console.log("normalizeToolCallIds");

check("coerces an integer id in a streaming delta (the actual crash)", () => {
  const out = normalizeToolCallIds({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 12345, function: { name: "read" } }] } }],
  });
  assert.strictEqual(out.choices[0].delta.tool_calls[0].id, "12345");
});

check("coerces an integer id in a non-streaming message", () => {
  const out = normalizeToolCallIds({
    choices: [{ message: { role: "assistant", tool_calls: [{ id: 7, function: { name: "glob" } }] } }],
  });
  assert.strictEqual(out.choices[0].message.tool_calls[0].id, "7");
});

check("leaves a well-formed string id untouched", () => {
  const out = normalizeToolCallIds({ choices: [{ delta: { tool_calls: [{ id: "call_abc" }] } }] });
  assert.strictEqual(out.choices[0].delta.tool_calls[0].id, "call_abc");
});

check("does NOT invent an id from null — that would break tool correlation", () => {
  const out = normalizeToolCallIds({ choices: [{ delta: { tool_calls: [{ id: null }] } }] });
  assert.strictEqual(out.choices[0].delta.tool_calls[0].id, null);
});

check("tolerates responses with no tool_calls at all", () => {
  const out = normalizeToolCallIds({ choices: [{ delta: { content: "hello" } }] });
  assert.strictEqual(out.choices[0].delta.content, "hello");
});

check("tolerates a malformed payload without throwing", () => {
  assert.doesNotThrow(() => normalizeToolCallIds(null));
  assert.doesNotThrow(() => normalizeToolCallIds({ choices: "not-an-array" }));
});

console.log("normalizeRequestBody");

check("rewrites content:null to \"\" on an assistant message with tool_calls", () => {
  const out = normalizeRequestBody({
    messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call_1" }] }],
  });
  assert.strictEqual(out.messages[0].content, "");
});

check("leaves content:null alone when there are no tool_calls", () => {
  const out = normalizeRequestBody({ messages: [{ role: "assistant", content: null }] });
  assert.strictEqual(out.messages[0].content, null);
});

check("leaves real assistant content untouched", () => {
  const out = normalizeRequestBody({
    messages: [{ role: "assistant", content: "text", tool_calls: [{ id: "call_1" }] }],
  });
  assert.strictEqual(out.messages[0].content, "text");
});

console.log("createSseRewriter");

check("rewrites a bad id inside a complete SSE frame", () => {
  const r = createSseRewriter();
  const out = r.push('data: {"choices":[{"delta":{"tool_calls":[{"id":99}]}}]}\n\n');
  assert.ok(out.includes('"id":"99"'), `expected string id, got: ${out}`);
});

check("passes [DONE] through untouched", () => {
  const r = createSseRewriter();
  assert.strictEqual(r.push("data: [DONE]\n\n"), "data: [DONE]\n\n");
});

check("forwards a non-JSON data line verbatim instead of dropping it", () => {
  const r = createSseRewriter();
  assert.strictEqual(r.push("data: not json\n\n"), "data: not json\n\n");
});

check("reassembles a frame split mid-JSON across chunks", () => {
  // The failure mode a naive per-chunk parser has, and precisely the case a
  // long multi-tool-call stream hits: the JSON is cut in half by a TCP
  // boundary. Nothing may be emitted until the frame terminator arrives.
  const r = createSseRewriter();
  const first = r.push('data: {"choices":[{"delta":{"tool_c');
  assert.strictEqual(first, "", "must not emit a partial frame");
  const second = r.push('alls":[{"id":4242}]}}]}\n\n');
  assert.ok(second.includes('"id":"4242"'), `expected reassembled+rewritten frame, got: ${second}`);
});

check("handles several frames arriving in one chunk", () => {
  const r = createSseRewriter();
  const out = r.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"id":1}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"id":2}]}}]}\n\n'
  );
  assert.ok(out.includes('"id":"1"') && out.includes('"id":"2"'), `got: ${out}`);
});

check("flush() returns an unterminated trailing frame rather than swallowing it", () => {
  const r = createSseRewriter();
  r.push('data: {"choices":[{"delta":{"tool_calls":[{"id":5}]}}]}');
  const rest = r.flush();
  assert.ok(rest.includes('"id":"5"'), `truncated stream must still be forwarded, got: ${rest}`);
});

check("end-to-end: a realistic 5-tool-call stream where only the last id is bad", () => {
  // Mirrors the observed failure shape — four clean round trips, then one
  // tool call whose id comes back as a number.
  const r = createSseRewriter();
  let out = "";
  for (let i = 1; i <= 4; i++) {
    out += r.push(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_${i}"}]}}]}\n\n`);
  }
  out += r.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":5}]}}]}\n\n');
  out += r.push("data: [DONE]\n\n");

  assert.ok(out.includes('"id":"call_4"'), "good ids preserved");
  assert.ok(out.includes('"id":"5"'), "bad id coerced");
  assert.ok(!/"id":5[,}]/.test(out), "no raw integer id may survive");
  assert.ok(out.trimEnd().endsWith("data: [DONE]"), "stream terminator preserved");
});

console.log("upstreamPathFor (authorization boundary)");

// The shim holds the account token and forwards whatever it is given, so a
// client-controlled path with `..` segments would reach the wider Cloudflare
// account API with full credentials. Only the allowlisted AI endpoints may
// ever be forwarded.
const BASE = "/client/v4/accounts/test-account/ai/v1";

check("maps the chat completions endpoint onto the upstream AI base", () => {
  assert.strictEqual(upstreamPathFor("/v1/chat/completions", BASE), `${BASE}/chat/completions`);
});

check("maps the models endpoint onto the upstream AI base", () => {
  assert.strictEqual(upstreamPathFor("/v1/models", BASE), `${BASE}/models`);
});

check("rejects a path-traversal attempt escaping the AI namespace", () => {
  assert.strictEqual(upstreamPathFor("/v1/../../accounts/test-account/images/v1", BASE), null);
});

check("rejects a URL-encoded traversal attempt", () => {
  assert.strictEqual(upstreamPathFor("/v1/%2e%2e/%2e%2e/members", BASE), null);
});

check("rejects a non-/v1 path outright", () => {
  assert.strictEqual(upstreamPathFor("/client/v4/accounts/test-account/storage/kv", BASE), null);
});

check("rejects any endpoint outside the allowlist, even under /v1", () => {
  assert.strictEqual(upstreamPathFor("/v1/images/v1", BASE), null);
});

check("rejects an empty/root path", () => {
  assert.strictEqual(upstreamPathFor("/", BASE), null);
  assert.strictEqual(upstreamPathFor("", BASE), null);
});

check("strips a query string rather than forwarding it upstream", () => {
  assert.strictEqual(upstreamPathFor("/v1/models?model=x", BASE), `${BASE}/models`);
});

console.log("startServer upstream timeout");

// The 2026-08-15 failure shape, pinned without network access: a stalled
// upstream must fail the request (502 + diagnostic) after the timeout, not
// hang the turn until the 120-min job cap kills it.
(async () => {
  // Stub the upstream with a request object that never delivers a response,
  // but that — like a real socket — emits 'error' when destroy(err) is called.
  const neverResponds = () => {
    const fake = {
      errorCb: null,
      timeoutFn: null,
      setTimeout(ms, fn) {
        this.timeoutFn = setTimeout(fn, ms);
        return this;
      },
      destroy(err) {
        if (this.timeoutFn) clearTimeout(this.timeoutFn);
        if (err && this.errorCb) process.nextTick(() => this.errorCb(err));
        return this;
      },
      on(ev, cb) {
        if (ev === "error") this.errorCb = cb;
        return this;
      },
      end() {
        return this;
      },
    };
    return fake;
  };

  const server = startServer({
    port: 3199,
    accountId: "test-account",
    apiToken: "test-token",
    upstreamTimeoutMs: 200,
    requestFn: neverResponds,
  });

  await new Promise((resolve) => server.listen(3199, "127.0.0.1", resolve));

  const start = Date.now();
  const outcome = await new Promise((resolve) => {
    const req = http.request({ port: 3199, host: "127.0.0.1", path: "/v1/chat/completions", method: "POST" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.end(JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }));
  });
  server.close();

  try {
    assert.strictEqual(outcome.status, 502, `expected 502, got ${outcome.status}`);
    assert.ok(outcome.body.includes("timed out"), `expected a timeout diagnostic in body, got: ${outcome.body}`);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 200, `should not respond before the timeout, responded after ${elapsed}ms`);
    assert.ok(elapsed < 5000, `should respond promptly after the timeout, took ${elapsed}ms`);
    console.log(`  ok   stalled upstream returns 502 + timeout diagnostic (${elapsed}ms)`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${err.message}`);
    process.exitCode = 1;
  }

  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
})();
