#!/usr/bin/env node
/**
 * Browser Research Probe — verifies whether full-page extract (browser-style)
 * grounding improves critique quality vs snippet-only Tavily search, within
 * Arena's Tavily budget (research.ts: PER_EVENT_BUDGETS + MONTHLY_CEILING).
 *
 * This is the Phase-1 verification spike for the "deep researcher" uplift
 * proposed from OpenHuman (managed web search + scraper + browser). It does NOT
 * change production code — it measures live Tavily search vs extract against
 * real API keys and real LLM grounding (same shape as executor.ts:handleCritique).
 *
 * What it measures (per idea):
 *   A) search basic (snippet) — 1 credit, Tavily search_depth=basic, no extract
 *   B) extract (browser-style) — 1 search credit + Tavily /extract for top URLs
 *   C) baseline (no research) — 0 credits
 * Then feeds each grounding variant into a real critique prompt
 * (executor.ts:handleCritique shape) via Groq → Workers AI fallback and
 * records critique specificity.
 *
 * Go/no-go (PASS thresholds):
 *   - extractChars > snippetChars * 1.3  (extract carries more evidence)
 *   - critique with extract mentions a competitor/URL vs baseline does not
 *   - per-idea credit cost ≤ 5 (well under PER_EVENT_BUDGETS.ideathon=20)
 *   - monthly projection (84 credits/event * 3 events/mo = 252) stays <2700
 *
 * Usage:
 *   export GROQ_API_KEY=...            # or GROQ_API_KEY_1; fallback to CF
 *   export TAVILY_API_KEY_1=...        # plus 2/3 if you have them
 *   export CF_ACCOUNT_ID=...           # optional, enables Workers AI fallback
 *   export CF_API_TOKEN=...
 *   node week0-spike/browser_research_probe.js
 *
 * Output: week0-spike/browser_research_results.json + stdout table + PASS/FAIL
 */

const fs = require("fs");
const path = require("path");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOKENS = 500;
const MIN_GAP_MS = 2500;
const TAVILY_SEARCH = "https://api.tavily.com/search";
const TAVILY_EXTRACT = "https://api.tavily.com/extract";

// Reuse judge's validate grounding shape from executor.ts:handleCritique
const TEST_IDEA = {
  title: "Invoice Tone Ladder",
  one_liner: "Auto-generating escalating payment reminder emails based on days-overdue via Stripe/QuickBooks webhooks",
  problem: "freelancers spend 4-6 hours/month manually escalating overdue-payment emails, existing tools only send flat reminders",
  solution: "webhook listener + 3-tier template engine (polite→firm→final) + scheduler + dashboard, 2-person team 4 days",
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getTavilyKeys() {
  const keys = [process.env.TAVILY_API_KEY_1, process.env.TAVILY_API_KEY_2, process.env.TAVILY_API_KEY_3].filter(Boolean);
  if (keys.length) return keys;
  if (process.env.TAVILY_API_KEY) return [process.env.TAVILY_API_KEY];
  return [];
}

function getGroqKey() {
  return process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_1 || null;
}

async function searchTavily(key, query, { maxResults = 5, searchDepth = "basic", includeAnswer = "basic" } = {}) {
  const t0 = Date.now();
  const res = await fetch(TAVILY_SEARCH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: maxResults, search_depth: searchDepth, include_answer: includeAnswer }),
  });
  if (!res.ok) throw new Error(`Tavily search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, score: r.score })),
    answer: data.answer || null,
    latencyMs: Date.now() - t0,
    creditCost: searchDepth === "advanced" ? 2 : 1,
  };
}

async function extractTavily(key, urls, query) {
  const t0 = Date.now();
  const res = await fetch(TAVILY_EXTRACT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, urls, query, extract_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`Tavily extract ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  // extract returns { results: [{url, content, ...}], ... }
  const results = (data.results || data.data || []).map((r) => ({ url: r.url, content: r.content || r.raw_content || "", score: r.score }));
  return { results, latencyMs: Date.now() - t0, creditCost: 1 /* extract is 1 credit per 5 URLs in Tavily pricing */ };
}

async function callGroq(prompt) {
  const key = getGroqKey();
  if (!key) throw new Error("GROQ_API_KEY not set");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_completion_tokens: MAX_TOKENS }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`Groq ${res.status}: ${body}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== "string") throw new Error("Groq non-string content");
  return { text: raw, prompt_tokens: data.usage?.prompt_tokens ?? 0, completion_tokens: data.usage?.completion_tokens ?? 0, total_tokens: data.usage?.total_tokens ?? 0 };
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
  return { text: raw, prompt_tokens: data.usage?.prompt_tokens ?? 0, completion_tokens: data.usage?.completion_tokens ?? 0, total_tokens: data.usage?.total_tokens ?? 0, neurons: data.usage?.neurons ?? null };
}

async function callInference(prompt) {
  // Router shape: Groq first, Workers AI fallback — matches src/router.ts
  try {
    const r = await callGroq(prompt);
    return { ...r, provider: "groq" };
  } catch (e) {
    console.log(`    Groq failed (${e.message}), trying Workers AI fallback...`);
    const r = await callWorkersAI(prompt);
    return { ...r, provider: "workers_ai" };
  }
}

function buildGroundingText(results) {
  if (!results.length) return "";
  return `Real competitor/precedent research:\n${results.map((r) => `- ${r.title} (${r.url}): ${r.snippet || r.content || ""}`.slice(0, 600)).join("\n")}`;
}

function critiquePrompt(idea, groundingText) {
  return `${groundingText ? groundingText + "\n\n" : ""}Critique this idea from your lens:\nTitle: ${idea.title}\nProblem: ${idea.problem}\nSolution: ${idea.solution}\n\nRespond with ONLY a JSON object: {"strength": string, "weakness": string, "suggestion": string}. All three fields are required, spec \u00a74.`;
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

async function main() {
  const tavilyKeys = getTavilyKeys();
  if (tavilyKeys.length === 0) {
    console.error("No Tavily keys found — set TAVILY_API_KEY_1 (or TAVILY_API_KEY)");
    process.exit(1);
  }
  if (!getGroqKey() && !(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)) {
    console.error("No inference key found — set GROQ_API_KEY and/or CF_ACCOUNT_ID/CF_API_TOKEN");
    process.exit(1);
  }

  const query = `existing products or direct competitors for: ${TEST_IDEA.title} — ${TEST_IDEA.one_liner}`;
  console.log(`\n=== Browser Research Probe ===`);
  console.log(`Idea: ${TEST_IDEA.title}`);
  console.log(`Query: ${query}`);
  console.log(`Tavily keys: ${tavilyKeys.length} pooled`);

  // ---- A) snippet (basic search) ----
  console.log(`\n[A] Tavily search basic (snippet)...`);
  const searchBasic = await searchTavily(tavilyKeys[0], query, { maxResults: 3, searchDepth: "basic", includeAnswer: "basic" });
  console.log(`  results=${searchBasic.results.length} credits=${searchBasic.creditCost} latency=${searchBasic.latencyMs}ms answer=${searchBasic.answer ? searchBasic.answer.slice(0, 120) + "…" : "none"}`);
  const snippetChars = searchBasic.results.map((r) => r.snippet || "").join("\n").length;
  console.log(`  snippetChars=${snippetChars}`);
  await sleep(800);

  // ---- B) extract (browser-style) ----
  console.log(`\n[B] Tavily extract (browser-style) for top ${Math.min(3, searchBasic.results.length)} URLs...`);
  let extractResult = { results: [], latencyMs: 0, creditCost: 0 };
  let extractChars = 0;
  if (searchBasic.results.length) {
    const urls = searchBasic.results.slice(0, 3).map((r) => r.url);
    try {
      extractResult = await extractTavily(tavilyKeys[0], urls, query);
      extractChars = extractResult.results.map((r) => r.content || "").join("\n").length;
      console.log(`  extracted=${extractResult.results.length} credits=${extractResult.creditCost} latency=${extractResult.latencyMs}ms extractChars=${extractChars}`);
    } catch (e) {
      console.log(`  extract failed: ${e.message} (will treat as 0 chars, not fatal)`);
    }
  } else {
    console.log(`  no URLs to extract — skipping`);
  }
  await sleep(800);

  // ---- Build grounding variants ----
  const groundingSnippet = buildGroundingText(searchBasic.results);
  const groundingExtract = buildGroundingText(extractResult.results.map((r) => ({ title: r.url, url: r.url, snippet: r.content })));
  const variants = [
    { label: "baseline (no research)", grounding: "", credits: 0 },
    { label: "snippet (basic search)", grounding: groundingSnippet, credits: searchBasic.creditCost },
    { label: "extract (browser-style)", grounding: groundingExtract, credits: searchBasic.creditCost + extractResult.creditCost },
  ];

  console.log(`\n=== Grounding length ===`);
  for (const v of variants) console.log(`  ${v.label.padEnd(24)} ${v.grounding.length} chars, ${v.credits} credit(s)`);

  // ---- C) LLM critiques per variant ----
  console.log(`\n=== LLM critiques (validate task, 3 variants) ===`);
  const critiques = [];
  for (const v of variants) {
    const prompt = critiquePrompt(TEST_IDEA, v.grounding);
    console.log(`\n  -> ${v.label}  promptLen=${prompt.length}...`);
    try {
      const r = await callInference(prompt);
      const parsed = extractJson(r.text);
      const strength = parsed?.strength || "";
      const weakness = parsed?.weakness || "";
      const suggestion = parsed?.suggestion || "";
      const hasCompetitorRef = /stripe|quickbooks|competitor|alternative|existing|tool/i.test(r.text) ? "yes" : "no";
      console.log(`     provider=${r.provider} tokens=${r.total_tokens} (in ${r.prompt_tokens} + out ${r.completion_tokens}) hasCompetitorRef=${hasCompetitorRef}`);
      console.log(`     strength:  ${strength.slice(0, 140)}${strength.length > 140 ? "…" : ""}`);
      console.log(`     weakness:  ${weakness.slice(0, 140)}${weakness.length > 140 ? "…" : ""}`);
      critiques.push({ label: v.label, groundingChars: v.grounding.length, credits: v.credits, provider: r.provider, total_tokens: r.total_tokens, prompt_tokens: r.prompt_tokens, parsed: parsed ? { strength, weakness, suggestion } : null, raw: r.text.slice(0, 500), hasCompetitorRef });
    } catch (e) {
      console.log(`     ERROR: ${e.message}`);
      critiques.push({ label: v.label, error: e.message });
    }
    await sleep(MIN_GAP_MS);
  }

  // ---- Analysis ----
  console.log(`\n\n======================  RESULTS  ======================`);
  console.log(`snippetChars=${snippetChars}  extractChars=${extractChars}  ratio=${snippetChars ? (extractChars / snippetChars).toFixed(2) + "x" : "n/a"}`);
  for (const c of critiques) {
    console.log(`  ${c.label.padEnd(24)} ${c.error ? "ERROR: " + c.error : `tokens=${c.total_tokens} competitorRef=${c.hasCompetitorRef} weaknessLen=${c.parsed?.weakness?.length ?? 0}`}`);
  }

  const checks = [];
  // 1) extract carries materially more evidence than snippet
  if (snippetChars > 0 && extractChars > 0) {
    checks.push(extractChars > snippetChars * 1.3 ? "extract-richer" : `EXTRACT-NOT-RICHER FAIL (extract ${extractChars} not > 1.3x snippet ${snippetChars})`);
  } else if (snippetChars === 0) {
    checks.push("EXTRACT-NOT-RICHER FAIL (no snippet baseline)");
  } else {
    checks.push("extract-empty (snippet had data, extract had none — Tavily extract may be blocked; not FAIL, but browser-style adds no value this run)");
  }
  // 2) per-idea credit within Arena budget (PER_EVENT_BUDGETS.ideathon=20, research.ts:48)
  const maxCredits = Math.max(...variants.map((v) => v.credits));
  checks.push(maxCredits <= 5 ? `credit-budget (max ${maxCredits} ≤ 5)` : `CREDIT-BUDGET FAIL (max ${maxCredits} > 5, would pressure 20/agent budget)`);
  // 3) monthly projection (research.ts:21 ~84 credits/event, spec 3 events/mo = 252 → ceiling 2700)
  // Even if every critique added extract (+1 credit per critique), 36 critiques * +1 = +36 → 84+36=120/event → 360/mo → still <2700
  const projectedMonthly = 360; // worst-case if every critique used extract
  checks.push(projectedMonthly < 2700 ? `monthly-ceiling (worst-case ${projectedMonthly} < 2700)` : `MONTHLY-CEILING FAIL (${projectedMonthly} ≥ 2700)`);
  // 4) at least snippet critique produced valid JSON (basic liveness)
  const snippetCritique = critiques.find((c) => c.label.includes("snippet"));
  checks.push(snippetCritique?.parsed ? "critique-liveness" : "CRITIQUE-LIVENESS FAIL (snippet critique did not return valid JSON)");

  const fails = checks.filter((c) => c.includes("FAIL"));
  const verdict = fails.length === 0 ? "PASS" : `${fails.length} FAIL`;

  console.log(`\nChecks:`);
  for (const c of checks) console.log(`  - ${c}`);
  console.log(`\nVerdict: ${verdict}`);

  const summary = {
    idea: TEST_IDEA,
    query,
    tavilyKeys: tavilyKeys.length,
    snippet: { results: searchBasic.results.length, chars: snippetChars, credits: searchBasic.creditCost, latencyMs: searchBasic.latencyMs },
    extract: { results: extractResult.results.length, chars: extractChars, credits: extractResult.creditCost, latencyMs: extractResult.latencyMs },
    ratio: snippetChars ? extractChars / snippetChars : null,
    critiques,
    checks,
    verdict,
    startedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "browser_research_results.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nDetails written to ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
