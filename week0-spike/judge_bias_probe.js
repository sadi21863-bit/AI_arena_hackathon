#!/usr/bin/env node
/**
 * Judge bias probe — spec §13 risk mitigation, run standalone.
 *
 * Measures the 7 judges' reliability against the SAME prompt they score
 * real entries with (word-for-word copy of the scoring prompt in
 * src/judges/scoring.ts, anti-verbosity clause included) and the SAME
 * provider/model the arena actually pins for judging
 * (groq / llama-3.3-70b-versatile — see archive_events.judging_provider /
 * judging_model on the live DB).
 *
 * Inspired by RANDCorporation/judge-reliability-harness: perturbation
 * (padding), label-flip (known weak vs known strong), and stability
 * (identical re-run) measurement, adapted to this system's single-target
 * 0-10 scoring shape (head-to-head position bias does not apply — each
 * judge scores one entry, not a pair).
 *
 * Metrics per judge (pass thresholds in parentheses):
 *   verbosityStrongΔ = score(padded strong) − score(concise strong)   (≤ 0)
 *   verbosityWeakΔ   = score(padded weak)   − score(concise weak)     (≤ 0)
 *   discriminationΔ  = score(strong) − score(weak)                    (≥ 3)
 *   stabilityΔ       = |score(strong) − score(strong re-run)|         (≤ 2)
 *   marketNoveltyΔ   = score(market entry) − score(novelty entry)
 *                     (Nora/Market should be > 0; Owen/Novelty < 0)
 *
 * The strong/weak entries are the arena's own calibration anchors
 * (src/judges/calibration.ts), so this also sanity-checks that the
 * calibration ladder the event engine relies on actually discriminates.
 *
 * Usage:
 *   export GROQ_API_KEY=...
 *   node judge_bias_probe.js
 *
 * Output: judge_bias_results.json + a pass/fail table on stdout.
 * Exit code 0 (measurement ran; failures are reported, not fatal).
 */

const fs = require("fs");
const path = require("path");

const MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOKENS = 700; // matches scoring.ts
const MIN_GAP_MS = 2500; // ~24 req/min, under Groq's 30 RPM; token budget below handles TPM
const MINUTE_BUDGET_TOKENS = 8000; // safe margin under ~12K TPM published cap
const MAX_RETRIES = 3;

// word-for-word from src/judges/scoring.ts scoreOne()
function scoringPrompt(judgeName, criterion, entry) {
  return (
    `You are Judge ${judgeName}, scoring ${criterion} (0-10) for a competition entry. ` +
    `Length is not quality — a longer or more elaborately-worded entry is not automatically better than a ` +
    `concise one; judge substance, and penalize unnecessary padding or restatement rather than rewarding it. ` +
    `If an entry contains substantial repetition, filler, or marketing language without new substance, ` +
    `subtract up to 2 points from its score and say so in the rationale. ` +
    `Respond with ONLY a JSON object: {"score": number, "rationale": string (2-3 sentences)}.\n\n${entry}`
  );
}

// same 7 judges as src/judges/personas.ts
const JUDGES = [
  { name: "Mason", criterion: "Technical Feasibility" },
  { name: "Nora", criterion: "Market Viability" },
  { name: "Owen", criterion: "Novelty" },
  { name: "Piper", criterion: "Ethics & Impact" },
  { name: "Quinn", criterion: "Narrative Clarity" },
  { name: "Reed", criterion: "Code Quality" },
  { name: "Sage", criterion: "UX & Accessibility" },
];

// entries — strong/weak are the arena's own calibration anchors
const ENTRIES = {
  strong: "Title: Invoice Tone Ladder. Problem: freelancers spend 4-6 hours/month manually escalating " +
    "overdue-payment emails, and existing tools only send flat reminders, not escalating tone. Solution: " +
    "auto-generates a 3-tier escalating reminder sequence (polite -> firm -> final notice) via " +
    "Stripe/QuickBooks webhooks. Build scope: webhook listener, template engine, scheduler, dashboard — " +
    "buildable by a 2-person team in 4 days.",
  strongPadded: "Title: Invoice Tone Ladder. Problem: freelancers spend 4-6 hours/month manually escalating " +
    "overdue-payment emails, and existing tools only send flat reminders, not escalating tone. Solution: " +
    "auto-generates a 3-tier escalating reminder sequence (polite -> firm -> final notice) via " +
    "Stripe/QuickBooks webhooks. Build scope: webhook listener, template engine, scheduler, dashboard — " +
    "buildable by a 2-person team in 4 days. " +
    "Let me expand on why this matters: invoicing is the lifeblood of independent work, and every month, " +
    "millions of freelancers across every industry find themselves in the same exhausting cycle of chasing " +
    "clients who have simply forgotten to pay. It is a story as old as commerce itself — the awkward email, " +
    "the polite nudge, the growing frustration as days turn into weeks. This problem touches photographers, " +
    "designers, writers, consultants, developers, and countless others who trade their time for money. " +
    "Moreover, the emotional toll of unpaid invoices cannot be overstated — the stress of wondering whether " +
    "your next rent payment will arrive, whether a client is unhappy with the work, or whether you will need " +
    "to resort to awkward legal language that could damage a professional relationship. We have all heard " +
    "the stories, and we have all lived the anxiety. It is precisely this deeply human pain point, repeated " +
    "across millions of small businesses worldwide, that our solution addresses with empathy and precision, " +
    "because at the end of the day, this is not just a software product — it is a tool for human dignity " +
    "and financial peace of mind in the modern gig economy.",
  weak: "Title: EverythingApp. Problem: people use too many apps. Solution: one app that replaces all other " +
    "apps using AI to do whatever the user needs. Build scope: build the core AI engine, add integrations " +
    "for every major service, launch.",
  weakPadded: "Title: EverythingApp. Problem: people use too many apps. Solution: one app that replaces all " +
    "other apps using AI to do whatever the user needs. Build scope: build the core AI engine, add " +
    "integrations for every major service, launch. " +
    "In today's fast-paced digital world, consumers are overwhelmed by the sheer number of applications " +
    "demanding their attention, and this fragmentation represents one of the most significant obstacles to " +
    "modern productivity. We believe that the future belongs to unified platforms that seamlessly integrate " +
    "every aspect of daily life into one elegant, effortless experience. Our revolutionary AI engine will " +
    "understand users on a deeply personal level, anticipating their needs before they even articulate them, " +
    "and dynamically orchestrating the perfect solution for any task imaginable. From banking to social " +
    "media to document editing to ride hailing to home automation, our comprehensive ecosystem will connect " +
    "to every major service on the planet, creating a harmonious digital environment where everything just " +
    "works. This is not merely an incremental improvement — it is a paradigm shift, a bold reimagining of " +
    "what software can be, and we are confident that once users experience this level of integration, they " +
    "will never look back.",
  marketStrong: "Title: RetainerRenew. Problem: agencies lose 15-20% of monthly retainers to silent churn " +
    "because renewals are never proactively negotiated. Solution: tracks each client's contract renewal " +
    "date, surfaces churn-risk signals (reply latency, scope creep, support ticket sentiment), and drafts a " +
    "personalized renewal pitch for the account manager. Pricing: $49/mo per agency, 30x cheaper than a " +
    "churn-reduction consultant. TAM: 110k agencies in the US alone; pilot with 10 agencies in the first " +
    "month, targeting 30% renewal-rate recovery. Build scope: calendar/email integrations, a risk-scoring " +
    "model, one dashboard screen.",
  noveltyStrong: "Title: EchoFingerprint. Problem: deepfake voice fraud is rising but existing detectors " +
    "only flag synthetic audio after it is already in circulation. Solution: fingerprints each speaker's " +
    "micro-timbre glitches (sub-20ms energy dips unique to real microphones) at capture time, so a call " +
    "center can reject a cloned voice before authorization. No comparable approach exists — prior art " +
    "analyzes spectral averages post-hoc; this is the first capture-time, per-device acoustic signature. " +
    "Build scope: DSP feature extractor, small classifier, call-center middleware adapter.",
};

// extractJson equivalent of src/agents/json-helpers.ts
function extractJson(text) {
  if (typeof text !== "string") return null;
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : withoutThinking;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === opener) depth++;
    else if (candidate[i] === closer) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

// pacing state: per-minute token spend so we never blow the TPM cap mid-run
let minuteStart = Date.now();
let minuteTokens = 0;

async function pace(usage) {
  minuteTokens += (usage?.total_tokens ?? 0);
  const elapsed = Date.now() - minuteStart;
  if (elapsed > 60_000) { minuteStart = Date.now(); minuteTokens = usage?.total_tokens ?? 0; return; }
  if (minuteTokens > MINUTE_BUDGET_TOKENS) {
    const wait = Math.max(1000, 60_000 - elapsed);
    console.log(`    (pacing: ${minuteTokens} tokens in this minute, sleeping ${Math.round(wait / 1000)}s)`);
    await sleep(wait);
    minuteStart = Date.now();
    minuteTokens = 0;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callJudge(prompt) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: MAX_TOKENS,
        }),
      });
      const remaining = res.headers.get("x-ratelimit-remaining-requests");
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        if (res.status === 429 || res.status >= 500) {
          lastError = `${res.status}: ${body}`;
          await sleep(10_000 * (attempt + 1));
          continue;
        }
        throw new Error(`Groq ${res.status}: ${body}`);
      }
      const data = await res.json();
      await pace(data.usage);
      const raw = data.choices?.[0]?.message?.content;
      if (typeof raw !== "string") throw new Error("non-string content from Groq");
      const parsed = extractJson(raw);
      if (!parsed || typeof parsed.score !== "number") {
        throw new Error(`malformed judge JSON: ${raw.slice(0, 200)}`);
      }
      return {
        score: Math.max(0, Math.min(10, parsed.score)),
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
        raw,
        remaining_requests: remaining,
      };
    } catch (e) {
      lastError = e;
      if (!(e instanceof Error) || !/malformed judge JSON/.test(e.message)) await sleep(2000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY not set — export it first.");
    process.exit(1);
  }
  const startedAt = new Date().toISOString();
  const results = [];

  // Per judge: strong, strongPadded, weak, weakPadded, marketStrong,
  // noveltyStrong, then strong again (stability). Sequential: 7 judges x 7
  // calls, paced inside callJudge.
  for (const judge of JUDGES) {
    console.log(`\n=== Judge ${judge.name} (${judge.criterion}) ===`);
    const row = { judge: judge.name, criterion: judge.criterion, calls: {} };
    for (const [key, entry] of Object.entries(ENTRIES)) {
      const label = key === "strong" ? "strong" : key;
      try {
        const r = await callJudge(scoringPrompt(judge.name, judge.criterion, entry));
        row.calls[label] = { score: r.score, rationale: r.rationale, remaining_requests: r.remaining_requests };
        console.log(`  ${label.padEnd(14)} score=${r.score}  (${r.remaining_requests ?? "?"} req left today)`);
      } catch (e) {
        row.calls[label] = { error: e.message };
        console.log(`  ${label.padEnd(14)} ERROR: ${e.message}`);
      }
      await sleep(MIN_GAP_MS);
    }
    // stability re-run of the strong entry
    try {
      const r = await callJudge(scoringPrompt(judge.name, judge.criterion, ENTRIES.strong));
      row.calls.strongAgain = { score: r.score, rationale: r.rationale, remaining_requests: r.remaining_requests };
      console.log(`  strong-again    score=${r.score}`);
    } catch (e) {
      row.calls.strongAgain = { error: e.message };
      console.log(`  strong-again    ERROR: ${e.message}`);
    }
    await sleep(MIN_GAP_MS);
    results.push(row);
  }

  // ---- analysis ----
  console.log("\n\n======================  RESULTS  ======================");
  console.log(`${"judge".padEnd(8)} ${"verbStrongΔ".padEnd(12)} ${"verbWeakΔ".padEnd(10)} ${"discrimΔ".padEnd(9)} ${"stabilityΔ".padEnd(11)} ${"market−noveltyΔ".padEnd(15)} verdict`);
  const summary = { model: MODEL, started_at: startedAt, finished_at: new Date().toISOString(), judges: [] };

  for (const row of results) {
    const s = row.calls.strong, sp = row.calls.strongPadded, w = row.calls.weak, wp = row.calls.weakPadded,
          m = row.calls.marketStrong, n = row.calls.noveltyStrong, sa = row.calls.strongAgain;
    const num = (c) => (c && typeof c.score === "number" ? c.score : null);
    const vs = num(sp) !== null && num(s) !== null ? num(sp) - num(s) : null;
    const vw = num(wp) !== null && num(w) !== null ? num(wp) - num(w) : null;
    const disc = num(s) !== null && num(w) !== null ? num(s) - num(w) : null;
    const stab = num(s) !== null && num(sa) !== null ? Math.abs(num(s) - num(sa)) : null;
    const mn = num(m) !== null && num(n) !== null ? num(m) - num(n) : null;

    const fmt = (v) => v === null ? "  n/a" : String(Math.round(v * 100) / 100).padStart(5);
    const checks = [];
    if (vs !== null) { checks.push(vs <= 0 ? "verbosity-strong" : "VERBOSITY-STRONG FAIL"); }
    if (vw !== null) { checks.push(vw <= 0 ? "verbosity-weak" : "VERBOSITY-WEAK FAIL"); }
    if (disc !== null) { checks.push(disc >= 3 ? "discrimination" : "DISCRIMINATION FAIL"); }
    if (stab !== null) { checks.push(stab <= 2 ? "stability" : "STABILITY FAIL"); }
    if (row.judge === "Nora" && mn !== null) { checks.push(mn > 0 ? "market-sensitivity" : "MARKET-SENSITIVITY FAIL"); }
    if (row.judge === "Owen" && mn !== null) { checks.push(mn < 0 ? "novelty-sensitivity" : "NOVELTY-SENSITIVITY FAIL"); }
    const fails = checks.filter((c) => c.includes("FAIL"));
    const verdict = fails.length === 0 ? "PASS" : `${fails.length} FAIL`;

    console.log(
      `${row.judge.padEnd(8)} ${fmt(vs).padEnd(12)} ${fmt(vw).padEnd(10)} ${fmt(disc).padEnd(9)} ${fmt(stab).padEnd(11)} ${fmt(mn).padEnd(15)} ${verdict}`
    );

    summary.judges.push({
      judge: row.judge,
      criterion: row.criterion,
      scores: row.calls,
      metrics: { verbosityStrongDelta: vs, verbosityWeakDelta: vw, discriminationDelta: disc, stabilityDelta: stab, marketMinusNoveltyDelta: mn },
      checks,
      verdict,
    });
  }

  const allFails = summary.judges.flatMap((j) => j.checks.filter((c) => c.includes("FAIL")));
  summary.overall = allFails.length === 0 ? "PASS" : `${allFails.length} failing check(s)`;

  fs.writeFileSync(path.join(__dirname, "judge_bias_results.json"), JSON.stringify(summary, null, 2));
  console.log(`\nOverall: ${summary.overall}`);
  console.log(`Details written to week0-spike/judge_bias_results.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
