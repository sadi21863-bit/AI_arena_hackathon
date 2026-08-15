#!/usr/bin/env node
/**
 * Regression test for the tribunal carry-over recall (src/agents/memory.ts
 * recallLessons, src/events/executor.ts).
 *
 * The whole point of recallLessons (added 2026-08-15) is ONE line: it calls
 * queryArchive with `type: "reflection"` so an agent's tribunal synthesis
 * (spec §14, "carries into the next event") is guaranteed to surface in the
 * next event's ideation/critique prompts — instead of competing with every
 * idea/critique/research memory for the top-k similarity slots, which is why
 * the pre-existing recallMemory never reliably reached the prompt.
 *
 * That one line is also exactly the kind of thing a future refactor can
 * quietly drop — recallMemory looks like it "does the same thing" and a
 * merge could route recallLessons through it without the type filter, which
 * silently reverts the whole feature. Same shape as test_dispatch_cap.js:
 * the code under test is parsed straight out of the source so the test
 * cannot drift from what ships.
 *
 *   node scripts/test_recall_lessons.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "memory.ts"), "utf8");

// Lift recallLessons, queryArchive and toRecalledMemories out of the source.
// queryArchive is needed too because recallLessons delegates to it, and
// toRecalledMemories because queryArchive uses it — the filter we assert on
// is assembled inside queryArchive, so that is the code that actually has to
// be right for the feature to work.
function extractFunction(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in memory.ts — test is out of date with the source`);
  const open = SRC.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, `could not find the end of ${name}`);
  // Back up over a preceding `async ` so `export async function queryArchive`
  // keeps its async modifier — slicing from `function` alone silently turns
  // the extracted declaration into a non-async function that then fails
  // syntax on its `await` calls.
  let declStart = SRC.indexOf("function", start);
  if (SRC.slice(Math.max(0, declStart - 7), declStart).trim() === "async") {
    declStart -= 6;
  }
  return SRC.slice(declStart, end + 1).trim();
}

const body = [
  // embed's only job here is to return a vector so the query can run; the
  // assertion is on the filter, not the embedding.
  "async function embed() { return [0.1, 0.2, 0.3]; }",
  extractFunction("toRecalledMemories"),
  extractFunction("queryArchive"),
  extractFunction("recallLessons"),
].join("\n");

// Strip the TypeScript annotations from just that slice.
const js = body
  .replace(/: VectorizeMatches\["matches"\]/g, "")
  .replace(/: Promise<RecalledMemory\[\]>\)/g, ")")
  .replace(/: Promise<RecalledMemory\[\]> \{/g, " {")
  .replace(/: RecalledMemory\[\] \{/g, " {")
  .replace(/\?:\s*ArchiveQueryFilter/g, "")
  .replace(/: Env/g, "")
  .replace(/: string/g, "")
  .replace(/: Record<string, string>/g, "");

let seenQuery = null;
const ctx = {
  globalThis: null, // assigned below; vm needs a mutable object
  ARCHIVE_VECTORS: {
    query: (values, options) => {
      seenQuery = { values, options };
      return { matches: [] };
    },
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(js + "\nglobalThis.recallLessons = recallLessons;", ctx);

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

console.log("tribunal carry-over recall (recallLessons)");

check("recallLessons is present in memory.ts", () => {
  assert.ok(SRC.includes("export async function recallLessons("), "recallLessons function missing");
});

check("recallLessons delegates to queryArchive with a type filter", async () => {
  seenQuery = null;
  await ctx.recallLessons(ctx, "agent_1", "lesson from my past performance", 2);
  assert.ok(seenQuery, "queryArchive was not called");
  // deepStrictEqual fails on prototype identity across the vm boundary even
  // for identical shapes — compare the plain fields instead.
  const filter = seenQuery.options.filter;
  assert.strictEqual(filter.agent_id, "agent_1");
  assert.strictEqual(filter.type, "reflection");
  assert.strictEqual(Object.keys(filter).length, 2);
  assert.strictEqual(seenQuery.options.topK, 2);
});

check("recallLessons filters type=reflection (the whole feature)", async () => {
  // Assert on the source itself, so this cannot regress via an edit that
  // bypasses the spy: the call must carry the literal reflection filter.
  const callStart = SRC.indexOf("export async function recallLessons(");
  const callEnd = SRC.indexOf("\n}", callStart);
  const callSite = SRC.slice(callStart, callEnd);
  assert.ok(callSite.includes('type: "reflection"'), 'recallLessons must filter type="reflection"');
  assert.ok(callSite.includes("agentId"), "recallLessons must scope to the agent");
});

check("recallMemory still has NO type filter (they must stay different)", () => {
  // The two functions exist for different reasons — recallMemory is generic
  // agent recall, recallLessons is the guaranteed carry-over. If someone
  // routes recallLessons through recallMemory, the type filter dies.
  const recallMemoryStart = SRC.indexOf("export async function recallMemory(");
  const recallLessonsStart = SRC.indexOf("export async function recallLessons(");
  const recallMemoryBody = SRC.slice(recallMemoryStart, recallLessonsStart);
  assert.ok(!recallMemoryBody.includes("type:"), "recallMemory must remain unfiltered");
});

check("ideation and critique prompts reference their recalled lessons", () => {
  // The injection only matters if the executor actually feeds the recalled
  // lessons into the LLM prompt — assert both call sites are wired.
  const executor = fs.readFileSync(path.join(__dirname, "..", "src", "events", "executor.ts"), "utf8");
  assert.ok(executor.includes("const lessons = await recallLessons("), "executor must call recallLessons");
  assert.ok(executor.includes("recallLessons(env, agent.id, `${agent.lens} lesson from my past performance to apply this event`, 2)"),
    "ideation lesson recall missing");
  assert.ok(executor.includes("recallLessons(env, agent.id, `${agent.lens} lesson about giving useful critiques`, 2)"),
    "critique lesson recall missing");
  assert.ok(executor.includes("${lessonsText}"), "ideation prompt must interpolate lessonsText");
  assert.ok(executor.includes("${priorViewsText}${lessonsText}"), "critique prompt must interpolate lessonsText");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
