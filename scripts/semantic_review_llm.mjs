#!/usr/bin/env node
/**
 * Independent semantic reviewer (R-3, 2026-11-01).
 *
 * The first semantic sample was one reviewer, one pass. This script produces a
 * second, model-independent pass over the same deterministic sample so the
 * sample can be checked for inter-rater agreement instead of asserted. It is an
 * operations tool, not part of the event loop and not a judge: nothing is
 * written back to D1, and the output is a review sheet, not a score.
 *
 * Usage:
 *   node scripts/semantic_review_llm.mjs --input=%TEMP%/semantic_sample.json
 *        [--out=docs/SEMANTIC_REVIEW_B_2026-10-31.json]
 *        [--model=nvidia/nemotron-3-ultra-550b-a55b:free]
 *        [--dry-run]
 *
 * Input is the `--json` output of scripts/semantic_sample.mjs. The reviewer must
 * return one verdict per idea, using pass/weak/fail for each criterion.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const inputPath = path.resolve(root, option("input", ""));
const outPath = option("out", null);
const dryRun = args.includes("--dry-run");
const model = option("model", "nvidia/nemotron-3-ultra-550b-a55b:free");
const DEFAULT_OUT = `docs/SEMANTIC_REVIEW_B_${new Date().toISOString().slice(0, 10)}.json`;

if (args.includes("--help") || args.includes("-h") || !option("input", null)) {
  console.log(
    "Usage: node scripts/semantic_review_llm.mjs --input=path [--out=path] [--model=id] [--dry-run]",
  );
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const sample = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const ideas = Array.isArray(sample.ideas) ? sample.ideas : [];
if (!ideas.length) {
  console.error("No ideas in the sample.");
  process.exit(1);
}

const ideaBlock = ideas
  .map((idea, index) => {
    const field = (value) => (value ? String(value).trim() : "(empty)");
    return [
      `### ${index + 1}. ${field(idea.title)}`,
      `id: ${idea.id}`,
      `one-liner: ${field(idea.one_liner)}`,
      `problem: ${field(idea.problem)}`,
      `solution: ${field(idea.solution)}`,
      `target user: ${field(idea.target_user)}`,
      `build scope: ${field(idea.build_scope)}`,
      `research anchor: ${field(idea.research_anchor)}`,
    ].join("\n");
  })
  .join("\n\n");

const prompt = `You are an independent reviewer of hackathon product ideas. You have not seen any prior review of these ideas. Do not infer or reuse one.

For each idea, judge four criteria:
- specific_problem: is the problem narrow, evidenced and clearly stated, or is it a broad theme?
- differentiated: is the solution meaningfully different from the obvious generic app, or is it a familiar wrapper?
- build_scope: can a two-agent team build the core demo in the 5-day hackathon window, with one repository, one run command and at most one external integration mocked with local fixtures? Be strict: Kubernetes, blockchain, custom model training, multi-cloud, real EHR integration or multi-week platform work is a fail.
- research_evidence: does the idea carry a non-empty research anchor, and does that anchor plausibly support the idea? An empty anchor is a fail, even if the idea looks researched.

Use this rubric so the verdicts are comparable:
- "pass": the idea is specific, differentiated and buildable as submitted, with only cosmetic cuts.
- "weak": the core idea could still be built as a 5-day demo after cutting the submitted scope to one repository and at most one mocked external integration. The idea survives the cut; only its ambition shrinks.
- "fail": the core value depends on excluded technology (Kubernetes, blockchain, custom model training, multi-cloud, real EHR) or on more than one external integration, so cutting it to the event window would change the idea rather than shrink it. A generic undifferentiated wrapper is also a fail.

Do not reward ambition. Judge the demo that could exist on day 5, not the platform in the pitch.
Overall is your holistic verdict using the same definitions, not an average.

Return ONLY valid JSON, with exactly ${ideas.length} verdicts in the same order as the ideas:
{"verdicts":[{"id":"<copied id>","specific_problem":"pass|weak|fail","differentiated":"pass|weak|fail","build_scope":"pass|weak|fail","research_evidence":"pass|weak|fail","overall":"pass|weak|fail","note":"one concrete sentence"}]}

Ideas:

${ideaBlock}`;

const envFile = readEnvFile(path.join(root, ".env"));
const apiKey =
  process.env.OPEN_ROUTER_API_KEY_1 ||
  process.env.OPENROUTER_API_KEY_1 ||
  envFile.OPEN_ROUTER_API_KEY_1 ||
  envFile.OPENROUTER_API_KEY_1;
if (!apiKey && !dryRun) {
  console.error("No OPEN_ROUTER_API_KEY_1 found (environment or .env).");
  process.exit(1);
}

console.log(
  `Reviewing ${ideas.length} idea(s) from ${sample.event?.id ?? "unknown event"} with ${model}` +
    `${dryRun ? " (dry run)" : ""}.`,
);

if (dryRun) {
  console.log(`Prompt characters: ${prompt.length}`);
  process.exit(0);
}

let res;
let body;
let text;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/sadi21863-bit/AI_arena_hackathon",
        "X-Title": "The Arena semantic review",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        // This model reasons before answering; a 4k ceiling was consumed by
        // hidden reasoning and returned empty content. Keep the answer affordable.
        max_tokens: 16000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(180000),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    body = { error: { message: err instanceof Error ? err.message : String(err) } };
    res = undefined;
  }
  text = body?.choices?.[0]?.message?.content;
  if (res?.ok && typeof text === "string" && text.trim()) break;
  const transient = !res || res.status === 429 || res.status >= 500 || !text;
  if (!transient || attempt === 3) break;
  const waitMs = attempt * 5000;
  console.log(`Attempt ${attempt} failed (${res?.status ?? "network"}); retrying in ${waitMs / 1000}s.`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

if (!res || !res.ok) {
  console.error(`OpenRouter HTTP ${res?.status ?? "network"}: ${JSON.stringify(body?.error ?? body).slice(0, 500)}`);
  process.exit(1);
}

if (typeof text !== "string" || !text.trim()) {
  const choice = body?.choices?.[0];
  console.error(
    `OpenRouter returned no text content (finish=${choice?.finish_reason ?? "none"}, ` +
      `reasoning_tokens=${body?.usage?.completion_tokens_details?.reasoning_tokens ?? "unknown"}, ` +
      `refusal=${JSON.stringify(choice?.message?.refusal ?? null).slice(0, 200)}, ` +
      `error=${JSON.stringify(body?.error ?? null).slice(0, 300)}, choices=${body?.choices?.length ?? 0}).`,
  );
  process.exit(1);
}

const start = text.indexOf("{");
const end = text.lastIndexOf("}");
if (start < 0 || end <= start) {
  console.error(`No JSON object in the response: ${text.slice(0, 500)}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text.slice(start, end + 1));
} catch (err) {
  console.error(`Malformed JSON: ${err instanceof Error ? err.message : err}\n${text.slice(0, 800)}`);
  process.exit(1);
}

const ALLOWED = new Set(["pass", "weak", "fail"]);
const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
const expectedIds = ideas.map((idea) => idea.id);
const gotIds = verdicts.map((v) => v.id);
const missing = expectedIds.filter((id) => !gotIds.includes(id));
const extra = gotIds.filter((id) => !expectedIds.includes(id));

if (verdicts.length !== ideas.length || missing.length || extra.length) {
  console.error(
    `Reviewer returned ${verdicts.length}/${ideas.length} verdicts; missing=${missing.length}, extra=${extra.length}.`,
  );
  process.exit(1);
}

for (const verdict of verdicts) {
  for (const field of ["specific_problem", "differentiated", "build_scope", "research_evidence", "overall"]) {
    if (!ALLOWED.has(verdict[field])) {
      console.error(`Bad ${field} for ${verdict.id}: ${verdict[field]}`);
      process.exit(1);
    }
  }
}

const result = {
  generated_at: new Date().toISOString(),
  event: sample.event ?? null,
  reviewer: `model:${model}`,
  source: path.relative(root, inputPath).replace(/\\/g, "/"),
  requested: ideas.length,
  verdicts: verdicts.map((v) => ({
    id: v.id,
    specific_problem: v.specific_problem,
    differentiated: v.differentiated,
    build_scope: v.build_scope,
    research_evidence: v.research_evidence,
    overall: v.overall,
    note: typeof v.note === "string" ? v.note.slice(0, 500) : "",
  })),
  usage: body.usage ?? null,
};

const target = path.resolve(root, outPath ?? DEFAULT_OUT);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");

const counts = (key) =>
  result.verdicts.reduce((acc, v) => ({ ...acc, [v[key]]: (acc[v[key]] ?? 0) + 1 }), {});
console.log(
  `Wrote ${result.verdicts.length} verdict(s) to ${target} ` +
    `(overall: ${JSON.stringify(counts("overall"))}).`,
);
