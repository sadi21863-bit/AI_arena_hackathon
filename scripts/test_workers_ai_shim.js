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
const { normalizeToolCallIds, normalizeRequestBody, createSseRewriter } = require("./workers_ai_shim");

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

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
