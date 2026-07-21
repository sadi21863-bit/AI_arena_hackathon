#!/usr/bin/env node
/**
 * Week 0 spike — inference probe (spec §6, §17).
 *
 * Tests both tiers of the §6 routing order — Groq, then Cloudflare Workers
 * AI — against real accounts, using task-shaped prompts (summarize / judging
 * / architecture), and writes machine-readable results for
 * scripts/check_inference_gate.py to consume.
 *
 * Usage:
 *   export GROQ_API_KEY=...
 *   export CF_ACCOUNT_ID=...        # Workers AI
 *   export CF_API_TOKEN=...
 *   node inference_pool_probe.js
 *
 * Both providers are confirmed no-card as of July 2026 (see spec §5, §18).
 * If any signup asks for a card, that's a change on their end — stop and
 * re-verify before proceeding, don't assume it's fine.
 */

const fs = require("fs");
const path = require("path");

const PROMPT_SHAPES = [
  {
    task: "summarize",
    prompt:
      "Summarize the following agent research thread in 3 sentences, preserving the key claim and its source:\n\n" +
      "AGENT ALEX (Friction Hunter): I've been digging into small business invoicing pain points. " +
      "Three independent sources point to the same friction: freelancers spend 4-6 hours/month manually " +
      "chasing overdue invoices, and existing tools treat this as a notification problem, not a negotiation " +
      "problem. The gap: nobody automates the escalation tone the way a human collections process would.",
  },
  {
    task: "judging",
    prompt:
      "You are Judge Mason, scoring Technical Feasibility (0-10) for the following idea. Give a score and " +
      "a 2-3 sentence rationale.\n\nIDEA: 'Invoice Tone Ladder' — a SaaS that auto-generates escalating " +
      "payment reminder emails based on days-overdue, integrated via Stripe/QuickBooks webhooks. Build " +
      "scope: webhook listener, a template engine with 3 escalation tiers, a scheduler, a dashboard. " +
      "Estimated build time: 4 days for a 2-person team.",
  },
  {
    task: "architecture",
    prompt:
      "Produce a build plan (tech stack, 3 major components, top 2 risks, fallback scope) for 'Invoice " +
      "Tone Ladder' — auto-escalating payment reminder emails based on days-overdue — in under 200 words. " +
      "Must work within a 4-day build window for a 2-person team, using only free-tier infrastructure.",
  },
];

// --- Groq ---
async function callGroq(model, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: 400 }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
    // Groq returns remaining daily requests in headers in the real client; the
    // fetch API here doesn't expose them as easily — check x-ratelimit-remaining-requests
    // via res.headers if you need exact remaining count instead of the estimate below.
    remaining_requests_header: res.headers.get("x-ratelimit-remaining-requests"),
  };
}

// --- Cloudflare Workers AI ---
async function callWorkersAI(model, prompt) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 400 }),
  });
  if (!res.ok) throw new Error(`Workers AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
  };
}

// Providers + models from spec §5. Skips a provider entirely if its env vars
// aren't set, so you can test one tier at a time.
const PROVIDERS = [
  {
    name: "groq", enabled: !!process.env.GROQ_API_KEY,
    models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
    call: callGroq,
  },
  {
    name: "workers_ai", enabled: !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN),
    models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
    call: callWorkersAI,
  },
];

async function main() {
  const results = [];
  const startedAt = new Date().toISOString();

  for (const provider of PROVIDERS) {
    if (!provider.enabled) {
      console.log(`\n=== ${provider.name}: SKIPPED (no API key set) ===`);
      continue;
    }
    for (const model of provider.models) {
      console.log(`\n=== ${provider.name} / ${model} ===`);
      for (const shape of PROMPT_SHAPES) {
        try {
          const out = await provider.call(model, shape.prompt);
          console.log(
            `  ${shape.task.padEnd(12)} in=${out.prompt_tokens}tok out=${out.completion_tokens}tok` +
            (out.remaining_requests_header ? `  remaining_today=${out.remaining_requests_header}` : "")
          );
          results.push({ provider: provider.name, model, task: shape.task, ...out, ok: true });
        } catch (err) {
          console.log(`  ${shape.task.padEnd(12)} FAILED: ${err.message}`);
          results.push({ provider: provider.name, model, task: shape.task, ok: false, error: err.message });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  const outPath = path.join(__dirname, "inference_pool_results.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({ started_at: startedAt, finished_at: new Date().toISOString(), results }, null, 2)
  );
  console.log(`\nWrote results to ${outPath}`);
  console.log(
    "\nCross-check exact remaining daily quota in each provider's own dashboard " +
    "(console.groq.com/settings/limits, Cloudflare Workers AI analytics) " +
    "rather than trusting this script's estimate alone — see spec §17 go/no-go criteria."
  );
}

main().catch((err) => { console.error("Probe failed:", err); process.exit(1); });
