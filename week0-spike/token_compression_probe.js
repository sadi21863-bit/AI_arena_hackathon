#!/usr/bin/env node
/**
 * Token Compression Probe — verifies TokenJuice-style compression (≈30-80%
 * fewer tokens) preserves judge discrimination before wiring it into
 * src/router.ts / src/agents/memory.ts / src/judges/scoring.ts.
 *
 * Inspired by OpenHuman's TokenJuice (README: "same information, up to 80%
 * fewer tokens. A brain this big would be unaffordable without it.") and by
 * RANDCorporation/judge-reliability-harness (perturbation) as already used in
 * week0-spike/judge_bias_probe.js.
 *
 * What it measures:
 *   For a fixed idea + synthetic “research context” (3 memories + 2 lessons
 *   + prior ideas, ~3500 chars uncompressed, same shape as
 *   executor.ts:handleSubmitIdea), it builds two prompts:
 *     U) uncompressed — full snippets verbatim
 *     C) compressed    — deduped, 240-char clip per item, filler stripped,
 *                        1200-char cap (TokenJuice-like)
 *   Then calls the same judge scoring prompt (scoring.ts:27 scoreOne verbatim,
 *   max_tokens 700) for a strong vs weak entry on each variant and records:
 *     - prompt_tokens / completion_tokens / total_tokens (from provider usage)
 *     - score + rationale
 *     - compressionRatio = 1 - C_tokens / U_tokens
 *     - discriminationDelta = score(strong) - score(weak)  (must stay ≥3)
 *     - verbosityStrongDelta = score(paddedStrong) - score(conciseStrong) (≤0)
 *
 * Go/no-go (PASS thresholds):
 *   - compressionRatio ≥ 0.30  (30% token saving; 80% is stretch goal)
 *   - discriminationDelta_compressed ≥ 3  (judges still rank correctly)
 *   - discriminationDelta loss ≤ 1.5 vs uncompressed (compression doesn't flip ranking)
 *   - no increase in verbosityStrongDelta (padded still penalized)
 *
 * Usage:
 *   export GROQ_API_KEY=...            # console.groq.com — no card
 *   # optional Workers AI fallback if Groq exhausts:
 *   export CF_ACCOUNT_ID=...  CF_API_TOKEN=...
 *   node week0-spike/token_compression_probe.js
 *
 * Output: week0-spike/token_compression_results.json + stdout table
 */

const fs = require("fs");
const path = require("path");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOKENS = 700; // matches scoring.ts
const MIN_GAP_MS = 2500;
const MODEL = "llama-3.3-70b-versatile";

// word-for-word from src/judges/scoring.ts scoreOne (anchor + anti-padding)
function scoringPrompt(judgeName, criterion, entry) {
  return (
    `You are Judge ${judgeName}, scoring ${criterion} (0-10) for a competition entry. ` +
    `Anchor your score: 8-10 is for a genuinely strong entry — a specific problem, a concrete differentiated solution, and a realistic build scope. ` +
    `4-6 is for an ordinary, plausible entry with no standout quality. ` +
    `0-3 is for a vague, generic, or unrealistic entry — a poorly-defined problem, an unfocused or unbuildable solution, or no credible build scope. ` +
    `Length is not quality — a longer or more elaborately-worded entry is not automatically better than a ` +
    `concise one; judge substance, and penalize unnecessary padding or restatement rather than rewarding it. ` +
    `If an entry contains substantial repetition, filler, or marketing language — hype claims like 'revolutionary', 'seamless', or 'AI-powered' with no implementation specifics — ` +
    `those passages add zero score, subtract up to 2 points from the total, and must never raise the score above what the underlying substance deserves; say so in the rationale. ` +
    `Respond with ONLY a JSON object: {"score": number, "rationale": string (2-3 sentences)}.\n\n${entry}`
  );
}

const ENTRIES = {
  strong: "Title: Invoice Tone Ladder. Problem: freelancers spend 4-6 hours/month manually escalating overdue-payment emails, and existing tools only send flat reminders, not escalating tone. Solution: auto-generates a 3-tier escalating reminder sequence (polite -> firm -> final notice) via Stripe/QuickBooks webhooks. Build scope: webhook listener, template engine, scheduler, dashboard — buildable by a 2-person team in 4 days.",
  strongPadded: "Title: Invoice Tone Ladder. Problem: freelancers spend 4-6 hours/month manually escalating overdue-payment emails, and existing tools only send flat reminders, not escalating tone. Solution: auto-generates a 3-tier escalating reminder sequence (polite -> firm -> final notice) via Stripe/QuickBooks webhooks. Build scope: webhook listener, template engine, scheduler, dashboard — buildable by a 2-person team in 4 days. Let me expand on why this matters: invoicing is the lifeblood of independent work, and every month, millions of freelancers across every industry find themselves in the same exhausting cycle of chasing clients who have simply forgotten to pay. It is a story as old as commerce itself — the awkward email, the polite nudge, the growing frustration as days turn into weeks.",
  weak: "Title: EverythingApp. Problem: people use too many apps. Solution: one app that replaces all other apps using AI to do whatever the user needs. Build scope: build the core AI engine, add integrations for every major service, launch.",
  weakPadded: "Title: EverythingApp. Problem: people use too many apps. Solution: one app that replaces all other apps using AI to do whatever the user needs. Build scope: build the core AI engine, add integrations for every major service, launch. In today's fast-paced digital world, consumers are overwhelmed by the sheer number of applications demanding their attention, and this fragmentation represents one of the most significant obstacles to modern productivity. We believe that the future belongs to unified platforms that seamlessly integrate every aspect of daily life into one elegant, effortless experience. Our revolutionary AI engine will understand users on a deeply personal level, anticipating their needs before they even articulate them.",
};

// Synthetic research context shaped like executor.ts:handleSubmitIdea
// 3 memories + 2 lessons + 2 prior ideas + 2 past ideas — ~3500 chars
function buildUncompressedContext() {
  const memories = [
    "Lens: Friction Hunter — research: small business invoicing pain points, freelancers spend 4-6 hours/month chasing overdue invoices, existing tools treat this as notification not negotiation problem, gap is nobody automates escalation tone.",
    "Lens: Friction Hunter — review of prior failures: HoneyBook tried flat reminders and churned because tone never escalated; QuickBooks invoices get ignored because they look identical every month; Stripe's dunning is payment-method only not relationship-aware.",
    "Lens: Friction Hunter — market signal: 64M freelancers US 2026, 73% report late payment as top stressor, $3.2B addressable in collections-automation, recent funding for Kollide $8M for escalation workflows validates demand.",
  ];
  const lessons = [
    "Lesson from last event (Tribunal synthesis): ideas that named a specific user segment ('freelancers billing >$5k/mo via Stripe') scored 1.4 points higher on Market Viability than generic 'busy people' framing — be specific about who feels the pain today.",
    "Lesson: critiques that included a named competitor (e.g., 'HoneyBook') were judged more actionable than generic 'existing tools' — grounding in a real precedent matters.",
  ];
  const priorIdeas = [
    'Prior idea this event: "Auto-Invoice Nudger" — same Stripe webhook idea but no tiered tone, scored as marginal duplicate earlier; new idea must add tiered escalation to differentiate.',
    'Prior idea this event: "Client Health Ping" — targeted agencies not freelancers, different user, safe to proceed.',
  ];
  const pastIdeas = [
    "Past idea (earlier event): 'Tone Ladder v1' — same core but lacked dashboard, weakness was 'no visibility into which tier client is on' — upgrade must fix that with dashboard.",
    "Past idea: 'Payment Pal' — generic payment reminder, not escalation-focused, scored low on novelty.",
  ];
  return (
    `Recent research from your own lens:\n${memories.map((m) => `- ${m}`).join("\n")}\n\n` +
    `Your own past-event lesson(s) — apply these this event:\n${lessons.map((l) => `- ${l}`).join("\n")}\n\n` +
    `You already submitted these idea(s) earlier this event:\n${priorIdeas.map((p) => `- ${p}`).join("\n")}\n` +
    `Your past idea(s) from earlier events (you may submit a genuinely IMPROVED upgrade):\n${pastIdeas.map((p) => `- ${p}`).join("\n")}`
  );
}

// TokenJuice-like compressor: dedupe near-identical sentences, clip to 240 chars,
// strip filler, cap total length. Pure string ops — no LLM call.
function compressContext(uncompressed) {
  const FILLER_PHRASES = [
    "in today's fast-paced digital world,",
    "very", "really", "deeply", "precisely", "genuinely",
    "at the end of the day,",
    "moreover,",
  ];
  const CLIP = 240;
  const CAP = 1200;

  let text = uncompressed;
  // strip filler phrases (case-insensitive)
  for (const phrase of FILLER_PHRASES) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(re, "");
  }
  // split into bullet-ish lines, dedupe by normalized form
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const line of lines) {
    // normalize: lowercase, strip punctuation, collapse whitespace
    const norm = line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (seen.has(norm)) continue;
    // also skip if this line's first 40 chars already seen as substring
    let nearDup = false;
    for (const s of seen) {
      if (norm.slice(0, 40) && s.includes(norm.slice(0, 40).slice(0, 30))) { nearDup = true; break; }
    }
    if (nearDup) continue;
    seen.add(norm);
    // clip each line to CLIP chars
    deduped.push(line.length > CLIP ? line.slice(0, CLIP - 1) + "…" : line);
  }
  let out = deduped.join("\n");
  // cap total
  if (out.length > CAP) out = out.slice(0, CAP - 1) + "…";
  // collapse double spaces
  out = out.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  return out;
}

function extractJson(text) {
  if (typeof text !== "string") return null;
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : withoutThinking;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0; let end = -1;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === opener) depth++;
    else if (candidate[i] === closer) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function getGroqKey() { return process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_1 || null; }

async function callGroq(prompt) {
  const key = getGroqKey();
  if (!key) throw new Error("GROQ_API_KEY not set");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_completion_tokens: MAX_TOKENS }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== "string") throw new Error("Groq non-string content");
  return { text: raw, prompt_tokens: data.usage?.prompt_tokens ?? 0, completion_tokens: data.usage?.completion_tokens ?? 0, total_tokens: data.usage?.total_tokens ?? 0, raw };
}

async function callWorkersAI(prompt) {
  const account = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("CF credentials not set");
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", messages: [{ role: "user", content: prompt }], max_tokens: MAX_TOKENS }),
  });
  if (!res.ok) throw new Error(`Workers AI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== "string") throw new Error("Workers AI non-string content");
  return { text: raw, prompt_tokens: data.usage?.prompt_tokens ?? 0, completion_tokens: data.usage?.completion_tokens ?? 0, total_tokens: data.usage?.total_tokens ?? 0, raw, neurons: data.usage?.neurons ?? Math.ceil((data.usage?.total_tokens ?? 0) / 3) };
}

async function callInference(prompt) {
  try {
    const r = await callGroq(prompt);
    return { ...r, provider: "groq" };
  } catch (e) {
    console.log(`    Groq failed (${e.message}), trying Workers AI...`);
    const r = await callWorkersAI(prompt);
    return { ...r, provider: "workers_ai" };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function scoreWithContext(judge, entry, context, label) {
  const fullEntry = context ? `${context}\n\nSubmit ONE product idea grounded in that research — a new idea, or a substantially improved upgrade. Respond with ONLY a JSON object: {"title": string, "one_liner": string, "problem": string, "solution": string, "target_user": string, "build_scope": string}. Build_scope should be a short buildable-in-days scope, not a vague vision.\n\nContext:\n${context}\n\nIdea to score:\n${entry}` : entry;
  // For probe we SCORE the entry directly (scoring prompt), not generate a new idea, so context is injected as grounding
  // Simpler: score the entry but prepend context as "Research grounding" to match handleSubmitIdea's contextText shape
  const entryWithGrounding = context ? `${context}\n\nIdea:\n${entry}` : entry;
  const prompt = scoringPrompt(judge.name, judge.criterion, entryWithGrounding);
  const r = await callInference(prompt);
  const parsed = extractJson(r.text);
  if (!parsed || typeof parsed.score !== "number") throw new Error(`Malformed judge JSON from ${judge.name} (${label}): ${r.text.slice(0, 200)}`);
  return {
    label, judge: judge.name, criterion: judge.criterion,
    score: Math.max(0, Math.min(10, parsed.score)),
    rationale: parsed.rationale || "",
    prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, total_tokens: r.total_tokens,
    provider: r.provider, raw: r.text.slice(0, 300),
    contextChars: context.length, contextLabel: label,
  };
}

async function main() {
  if (!getGroqKey() && !(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)) {
    console.error("No inference key — set GROQ_API_KEY and/or CF_ACCOUNT_ID/CF_API_TOKEN");
    process.exit(1);
  }

  const uncompressed = buildUncompressedContext();
  const compressed = compressContext(uncompressed);

  console.log(`\n=== Token Compression Probe ===`);
  console.log(`Uncompressed chars: ${uncompressed.length}  lines: ${uncompressed.split("\n").length}`);
  console.log(`Compressed   chars: ${compressed.length}  lines: ${compressed.split("\n").length}  saved: ${((1 - compressed.length / uncompressed.length) * 100).toFixed(1)}%`);
  console.log(`\nUncompressed preview (first 500 chars):\n${uncompressed.slice(0, 500)}…\n`);
  console.log(`Compressed preview (first 500 chars):\n${compressed.slice(0, 500)}…\n`);

  const judges = [
    { name: "Mason", criterion: "Technical Feasibility" },
    { name: "Nora", criterion: "Market Viability" },
  ];

  const results = [];

  for (const judge of judges) {
    console.log(`\n=== Judge ${judge.name} (${judge.criterion}) ===`);
    for (const entryKey of ["strong", "weak", "strongPadded"]) {
      const entry = ENTRIES[entryKey];
      for (const [ctxLabel, ctx] of [["uncompressed", uncompressed], ["compressed", compressed]]) {
        const label = `${entryKey}+${ctxLabel}`;
        try {
          const r = await scoreWithContext(judge, entry, ctx, label);
          console.log(`  ${label.padEnd(24)} score=${r.score.toFixed(1)} tokens=${r.total_tokens} (in ${r.prompt_tokens}) provider=${r.provider}`);
          results.push(r);
        } catch (e) {
          console.log(`  ${label.padEnd(24)} ERROR: ${e.message}`);
          results.push({ label, judge: judge.name, entryKey, ctxLabel, error: e.message });
        }
        await sleep(MIN_GAP_MS);
      }
    }
  }

  // ---- Analysis ----
  console.log(`\n\n======================  RESULTS  ======================`);
  console.log(`Context: uncompressed ${uncompressed.length} chars → compressed ${compressed.length} chars (${((1 - compressed.length / uncompressed.length) * 100).toFixed(1)}% char saving)`);

  // Per-judge per-entry comparison: average token saving
  const byPair = {};
  for (const r of results) {
    if (r.error || typeof r.total_tokens !== "number") continue;
    const key = `${r.judge}:${r.label.split("+")[0]}`; // e.g. Mason:strong
    if (!byPair[key]) byPair[key] = {};
    const isComp = r.label.endsWith("+compressed");
    byPair[key][isComp ? "comp" : "uncomp"] = r;
  }

  let totalSavings = [];
  let discrimUncomp = [], discrimComp = [];
  let verbosityUncomp = [], verbosityComp = [];

  for (const [key, pair] of Object.entries(byPair)) {
    if (pair.uncomp && pair.comp) {
      const saving = 1 - pair.comp.total_tokens / pair.uncomp.total_tokens;
      totalSavings.push(saving);
      console.log(`  ${key.padEnd(16)} tokens ${pair.uncomp.total_tokens} → ${pair.comp.total_tokens}  saving ${(saving * 100).toFixed(1)}%  scores ${pair.uncomp.score.toFixed(1)} → ${pair.comp.score.toFixed(1)}`);
    }
  }

  // Discrimination per judge: need strong vs weak under same compression variant
  const perJudgeVariant = {};
  for (const r of results) {
    if (r.error) continue;
    const variant = r.label.endsWith("+compressed") ? "compressed" : "uncompressed";
    const k = `${r.judge}:${variant}`;
    if (!perJudgeVariant[k]) perJudgeVariant[k] = {};
    const entryKey = r.label.split("+")[0];
    perJudgeVariant[k][entryKey] = r.score;
  }
  for (const [k, scores] of Object.entries(perJudgeVariant)) {
    if (typeof scores.strong === "number" && typeof scores.weak === "number") {
      const d = scores.strong - scores.weak;
      console.log(`  ${k.padEnd(24)} discriminationΔ = ${scores.strong.toFixed(1)} - ${scores.weak.toFixed(1)} = ${d.toFixed(1)}`);
      if (k.includes("uncompressed")) discrimUncomp.push(d);
      else discrimComp.push(d);
    }
    if (typeof scores.strongPadded === "number" && typeof scores.strong === "number") {
      const v = scores.strongPadded - scores.strong;
      console.log(`  ${k.padEnd(24)} verbosityStrongΔ = ${scores.strongPadded.toFixed(1)} - ${scores.strong.toFixed(1)} = ${v.toFixed(1)}`);
      if (k.includes("uncompressed")) verbosityUncomp.push(v);
      else verbosityComp.push(v);
    }
  }

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const avgSaving = avg(totalSavings);
  const avgDiscUncomp = avg(discrimUncomp);
  const avgDiscComp = avg(discrimComp);
  const avgVerbUncomp = avg(verbosityUncomp);
  const avgVerbComp = avg(verbosityComp);

  console.log(`\nAverages:`);
  console.log(`  token saving:      ${avgSaving !== null ? (avgSaving * 100).toFixed(1) + "%" : "n/a"}  (threshold ≥30%)`);
  console.log(`  discriminationΔ U: ${avgDiscUncomp !== null ? avgDiscUncomp.toFixed(2) : "n/a"}  C: ${avgDiscComp !== null ? avgDiscComp.toFixed(2) : "n/a"}  (threshold C ≥3, loss ≤1.5)`);
  console.log(`  verbosityStrongΔ U: ${avgVerbUncomp !== null ? avgVerbUncomp.toFixed(2) : "n/a"}  C: ${avgVerbComp !== null ? avgVerbComp.toFixed(2) : "n/a"}  (threshold ≤0, C not worse than U)`);

  const checks = [];
  if (avgSaving !== null) checks.push(avgSaving >= 0.30 ? `compression (avg ${(avgSaving * 100).toFixed(1)}% ≥30%)` : `COMPRESSION FAIL (avg ${(avgSaving * 100).toFixed(1)}% <30%)`);
  if (avgDiscComp !== null) checks.push(avgDiscComp >= 3 ? `discrimination-compressed (${avgDiscComp.toFixed(2)} ≥3)` : `DISCRIMINATION-COMPRESSED FAIL (${avgDiscComp.toFixed(2)} <3)`);
  if (avgDiscUncomp !== null && avgDiscComp !== null) {
    const loss = avgDiscUncomp - avgDiscComp;
    checks.push(loss <= 1.5 ? `discrimination-loss (${loss.toFixed(2)} ≤1.5)` : `DISCRIMINATION-LOSS FAIL (${loss.toFixed(2)} >1.5)`);
  }
  if (avgVerbUncomp !== null && avgVerbComp !== null) {
    checks.push(avgVerbComp <= 0 ? `verbosity-still-penalized (${avgVerbComp.toFixed(2)} ≤0)` : `VERBOSITY-REGRESSION FAIL (compressed ${avgVerbComp.toFixed(2)} >0, now rewards padding)`);
    // also not worse than uncompressed by more than 0.5
    if (avgVerbComp !== null && avgVerbUncomp !== null) {
      const verbDeg = avgVerbComp - avgVerbUncomp;
      checks.push(verbDeg <= 0.5 ? `verbosity-not-worse (${verbDeg.toFixed(2)} ≤0.5)` : `VERBOSITY-WORSE FAIL (compressed ${verbDeg.toFixed(2)} worse than uncompressed)`);
    }
  }

  const fails = checks.filter((c) => c.includes("FAIL"));
  const verdict = fails.length === 0 ? "PASS" : `${fails.length} FAIL`;
  console.log(`\nChecks:`);
  for (const c of checks) console.log(`  - ${c}`);
  console.log(`\nVerdict: ${verdict}`);

  const summary = {
    uncompressed: { chars: uncompressed.length, preview: uncompressed.slice(0, 600) },
    compressed: { chars: compressed.length, preview: compressed.slice(0, 600), charSaving: 1 - compressed.length / uncompressed.length },
    results,
    averages: { tokenSaving: avgSaving, discriminationUncompressed: avgDiscUncomp, discriminationCompressed: avgDiscComp, verbosityUncompressed: avgVerbUncomp, verbosityCompressed: avgVerbComp },
    checks,
    verdict,
    model: MODEL,
    startedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "token_compression_results.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nDetails written to ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
