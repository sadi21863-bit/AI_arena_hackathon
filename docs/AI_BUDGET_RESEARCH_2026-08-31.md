# AI Inference & Research Budget — Options to Increase Capacity

**Date:** 2026-08-31
**Status:** research only — no code changes (per task brief; spec CLAUDE.md still forbids a third inference provider and a VM without explicit user approval — this doc is the research the user explicitly requested before any approval)
**Author:** Muse Spark (research synthesis; all external claims cite primary sources inline)
**Scope:** Groq + Cloudflare Workers AI (the two pooled providers in `src/router.ts`) and Tavily search; alternatives are evaluated but flagged against the spec constraint

---

## 0. How this doc was built

Read directly:

- `src/router.ts:36-91` (`TASK_MODELS`, `DAILY_CAPS`), `src/env.ts:6-37`, `.env` (CF_ACCOUNT_ID + 2× GROQ_API_KEY + 3× TAVILY_API_KEY), `wrangler.toml:25-28` (`[ai] binding="AI"`), `week0-spike/inference_pool_probe.js:52-102`, `week0-spike/inference_pool_results.json`, `week0-spike/token_compression_probe.js` + `token_compression_results.json`, `week0-spike/browser_research_probe.js` + `browser_research_results.json`, `week0-spike/judge_bias_probe.js` + `judge_bias_results.json`, `src/events/executor.ts:65-90,122-180,402-425` (token compression, prompt shapes), `src/agents/research.ts:9-52` (Tavily budget math), `src/agents/memory.ts:14-24` (Neuron accounting), `src/judges/scoring.ts:23-52,86-166` and `src/judges/calibration.ts:53-83` (judging token budget, anti-verbosity, pinning), `db/schema.sql:106-120` (`provider_usage_log` DDL), `docs/INVESTIGATION_2026-07-28.md` (P0-2, P1-4), `docs/INVESTIGATION_2026-08-15.md`, `.arena/state.json` (gate history)

Web-checked primary sources (fetched 2026-08-31, URLs preserved per-claim below):

- Groq rate limits + model catalog: <https://console.groq.com/docs/rate-limits>, <https://console.groq.com/docs/models>, <https://console.groq.com/docs/changelog>, <https://console.groq.com/docs/batch>, <https://console.groq.com/docs/prompt-caching>, <https://console.groq.com/docs/spend-limits>, <https://console.groq.com/docs/billing-faqs>
- Cloudflare Workers AI pricing + model table: <https://developers.cloudflare.com/workers-ai/platform/pricing/> and index variant <https://developers.cloudflare.com/workers-ai/platform/pricing/index.md>
- Cloudflare Workers platform pricing (the $5 Paid plan that gates Workers AI overage): <https://developers.cloudflare.com/workers/platform/pricing/>
- Tavily credit docs + pricing: <https://docs.tavily.com/documentation/api-credits>, <https://tavily.com/pricing>
- Cerebras free tier + rate limits: <https://inference-docs.cerebras.ai/support/rate-limits>
- Hugging Face inference product split: <https://huggingface.co/pricing> + <https://huggingface.co/docs/inference-providers/pricing> (fetched, content thin — supplemented by the verified secondary that cites it; noted)
- Groq pricing page (when fetch returned marketing shell, replaced with doc-sourced per-model prices): `groq.com/pricing` via `console.groq.com/docs/models` per-model cards

If a claim below has no URL, it is derived from this repo's own source or from a file listed above, not from the web.

---

## 1. Current spend — what the budget actually is

### 1.1 Caps as coded (`src/router.ts:76-91`)

```ts
// DAILY_CAPS — published caps, not measured (comment at line 70 says
// "replace with measured values from the Week 0 spike once you have them")
export const DAILY_CAPS: Record<string, number> = {
  "groq:llama-3.1-8b-instant": 14400,
  "groq:llama-3.3-70b-versatile": 1000,
  "groq:groq/compound-mini": 14400,
  "groq:qwen/qwen3.6-27b": 1000,
  "groq:openai/gpt-oss-120b": 1000,
  "groq:openai/gpt-oss-20b": 1000,
  "workers_ai": 9500,
};
```

Three facts worth naming plainly:

1. The two `14400` entries (`llama-3.1-8b-instant`, `groq/compound-mini`) are **dead code today**. `TASK_MODELS` (`src/router.ts:36-67`) no longer points at either (swapped 2026-08-25 to `openai/gpt-oss-*`, `qwen/qwen3.6-27b`, `groq/compound-mini` only for the latter — and `llama-3.1-8b-instant` is not in `TASK_MODELS` at all). They inflate the apparent Groq ceiling but never count. Effective Groq ceiling under current routing is **3 × 1,000 = 3,000 req/day** across the three live model ids — and that is *per organization, not per key* (see §2.1).
2. `workers_ai: 9500` is a **conservative guess 500 below the real platform ceiling of 10,000 Neurons/day** (Cloudflare docs §3). It was raised 8500→9500 on 2026-07-26 after the app hit 8802 while the account still succeeded — the gap was partly the embed undercount (see next paragraph), not a safety margin worth defending. Leaving 500 headroom is prudent; treating 9500 as measured is not (the comment at `router.ts:70` still says to replace it with a measured value).
3. `provider_usage_log.units_used` is **heterogeneous by provider** (`db/schema.sql:116`): Groq counts `1` per request, Workers AI counts `Math.ceil(neurons)` per call (`router.ts:201-202`, `memory.ts:50`). You cannot sum them.

### 1.2 Where Neurons are *not* counted (now fixed, but historically expensive)

`src/agents/memory.ts:14-24` derives embed cost as `prompt_tokens × 6058 / 1_000_000` (the published rate for `@cf/baai/bge-base-en-v1.5` at <https://developers.cloudflare.com/workers-ai/platform/pricing/>) and calls `recordUsage(..., "workers_ai", EMBEDDING_MODEL, "embed", neurons)`. Before `docs/INVESTIGATION_2026-07-28.md` P1-4, `embed()` bypassed `router.ts` entirely and recorded **zero** — so `DAILY_CAPS["workers_ai"]` was evaluated against an undercount. The prior 8802→success observation that justified 8500→9500 is therefore **consistent with the undercount**, not proof of headroom. Any re-derivation of the Workers AI cap must use a day's *corrected* `provider_usage_log` total versus the Cloudflare AI dashboard's `https://dash.cloudflare.com/?to=/:account/ai/workers-ai` (Cloudflare pricing page § "You can monitor your Neuron usage…" at <https://developers.cloudflare.com/workers-ai/platform/pricing/>).

### 1.3 Routing as it actually runs (`src/router.ts:36-67,212-228`)

| Task | Groq (primary) | Workers AI (fallback) | Notes |
|---|---|---|---|
| `summarize` / `validate` / `test` / `research` / `design` | `openai/gpt-oss-20b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |  |
| `code_generation` | `openai/gpt-oss-20b` | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` |  |
| `judging` | `qwen/qwen3.6-27b` | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | Deliberately disjoint from `architecture` to avoid self-preference bias (comment at line 43-46) |
| `architecture` | `openai/gpt-oss-120b` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |  |
| `reflect` (Tribunal) | — | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Non-time-critical by design (`router.ts:66`) |

Load-splitting within Groq (`router.ts:149`): `Math.random() < 0.5 ? GROQ_API_KEY_2 : GROQ_API_KEY` — see §2.1 for why this does **not** double the daily budget.

Pinned judging (`src/judges/calibration.ts:112-150` → `scoring.ts:103-105,52`): `runCalibration` records the first successful `judging` provider/model onto `archive_events.judging_provider/judging_model`; every subsequent `scoreTarget` call passes `pinned_provider`. If that provider is exhausted, `routeInference` returns `null` (queue retry), not a silent model swap. This is correct — but it also means a Groq exhaustion mid-event **blocks judging** rather than overflowing to Workers AI, which is exactly the stall that produced `event_a0cbe12f`'s 191 failures cited in the brief.

Token budget: `callAgent` (`executor.ts:48`) and `scoreOne`/`scoreAnchor` (`scoring.ts:52`, `calibration.ts:75`) all use `max_tokens: 700`. This was the live-proven fix for hidden `<think>` truncation (INVESTIGATION_2026-07-28 § P0-1). Compression (`executor.ts:65-90`) is applied to the research-context block only, not to the instruction suffix.

### 1.4 Calibrated historical usage (the only honest numbers to budget from)

| Signal | Value | Source |
|---|---|---|
| `week0-spike/inference_pool_results.json` (2026-07-21, live) | All 3 prompt shapes succeeded on both providers; Groq `x-ratelimit-remaining-requests` showed 999→997 per model (1,000 RPD headroom confirmed); Workers AI `completion_tokens` ~100-193 | file |
| `week0-spike/judge_bias_results.json` (2026-08-06, 7 judges × 7 entries via `llama-3.3-70b-versatile`) | DiscriminationΔ = 7 on 7/7 judges; verbosityStrongΔ = -1 on 5/7; stabilityΔ = 0 on all; but `MARKET-SENSITIVITY` / `NOVELTY-SENSITIVITY` failed on 2/3 specialist judges — judging is reliable on strong-vs-weak, not on market-vs-novelty | file |
| `week0-spike/token_compression_results.json` (2026-08-25) | 1975→1200 chars (39.2% char saving), **19.6% measured token saving**, discrimination loss 8.0→7.0 (≤1.5 = pass), verbosity still penalized | file |
| `week0-spike/browser_research_results.json` (2026-08-25) | snippet 3551 chars / 1 credit vs extract 5020 chars / +1 credit = **1.41× richer** evidence; critique `hasCompetitorRef` no→yes; worst-case monthly search cost 84→120/event → **360/mo** vs 2700 pooled ceiling | file |
| Research budget as coded (`src/agents/research.ts:9-36`) | 4 queries/agent (`executor.ts:106-115`) + 1 grounding/critique (`handleCritique` uses `deepResearchWithExtract` at 2 credits) ⇒ ~84 credits/event without extract, ~120 with extract on every critique; pooled 3× Tavily accounts = 3,000/mo, `MONTHLY_CEILING` 2700 | file |
| `src/agents/research.ts:48-53` guards | `PER_EVENT_BUDGETS.ideathon=20` / `hackathon=8` per agent/team; `MONTHLY_CEILING=2700` | file |
| Embed cost (corrected) | `NEURONS_PER_INPUT_TOKEN = 6058 / 1e6` for `@cf/baai/bge-base-en-v1.5` (Cloudflare pricing → embeddings table at <https://developers.cloudflare.com/workers-ai/platform/pricing/>) | `memory.ts:17-24` + Cloudflare pricing |
| Historical stall (brief) | `event_a0cbe12f` → 191 failed `submit_idea` with `Inference exhausted` — this is the Groq RPD + Workers AI Neuron dual exhaustion that the queue surfaces as `markFailed` | brief (not in repo; consistent with router's `return null` → `executor.ts:49 throw`) |
| Build-turn shim | `scripts/workers_ai_shim.js` + `INVESTIGATION_2026-08-15.md`: upstream timeout 180s + 10-min silence watchdog; not a budget fix, but prevents one hanging build turn from burning 120 min of wall-clock and masking the budget signal | file |

### 1.5 What a full Arena actually costs (measured input, not estimates)

Use the probe's **measured** token counts, not guesses:

- Judging: each `scoreOne` call reports `prompt_tokens` ~750-870 and `completion_tokens` ~100-120 in the probes. With 3 concurrent calls/tick (`processQueue` batch = 3) and 7 parallel judge calls per target (`scoring.ts:122`), the burst is 7 concurrent requests per idea — well under Groq 30 RPM but demanding on TPD/TPM.
- Architecture/code_generation: `handleArchitecture` prompt is `Title + Problem + Solution + build_scope` under ~400 tokens of scaffold + up to 4000 chars of `build_scope` — similar order.
- Embed: each `rememberMemory`/`queryArchive` call embeds once. Ideathon creates ~12 agents × (4 research summaries + 3 ideas + 2 lessons) ≈ 100+ embeds/event before critiques. At ~200 prompt_tokens/embed × 6058 Neurons/M ≈ **~1.2 Neurons per embed** — trivial individually, material in bulk (100 embeds ≈ 120 Neurons, ~1.2% of the 10k daily pool).

A complete ideathon (36 ideas × 7 judges + calibration 21 calls + 36 critiques + 12×4 research + 100+ embeds) is on the order of **~300-400 Groq requests** and **~3000-4000 Workers AI Neurons** (the latter dominated by judging fallback, not embeds). The margin is therefore **thin on Groq 1,000 RPD** (one extra retry storm crosses it) and **comfortable on Workers AI 10k Neurons** unless judging falls through to Workers AI for many ideas — which is exactly what happens when Groq is exhausted mid-event and the pin forces retries instead of overflow.

---

## 2. Ground truth as of 2026-08-31 (primary sources only)

### 2.1 Groq free tier — 8K TPM / 200K TPD / 1,000 RPD is the binding number for *this project's* models

Primary: <https://console.groq.com/docs/rate-limits> (fetched 2026-08-31, **Free Plan Limits** tab)

| Model id (as in `src/router.ts`) | Free RPM | Free RPD | Free TPM | Free TPD | Source table row |
|---|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | **1,000** | **8,000** | **200,000** | `openai/gpt-oss-120b — 30 / 1K / 8K / 200K` |
| `openai/gpt-oss-20b` | 30 | **1,000** | **8,000** | **200,000** | `openai/gpt-oss-20b — 30 / 1K / 8K / 200K` |
| `qwen/qwen3.6-27b` | 30 | **1,000** | **8,000** | **200,000** | `qwen/qwen3.6-27b — 30 / 1K / 8K / 200K` |
| `groq/compound-mini` | 30 | 250 | 70,000 | — | `groq/compound-mini — 30 / 250 / 70K / —` |
| `llama-3.1-8b-instant` (legacy, in `DAILY_CAPS` but not routed) | — | — | — | — | **Not in the Free table anymore** — see deprecation below |
| `llama-3.3-70b-versatile` (legacy) | — | — | — | — | **Not in the Free table anymore** |

Two additional rows that matter for planning:

- `qwen/qwen3.8-27b` — same 30/1K/8K/200K as `qwen/qwen3.6-27b` (potential drop-in if 3.6 is rotated)
- `openai/gpt-oss-safeguard-20b` — same 30/1K/8K/200K

**TPM vs TPD — which binds?** At `executor.ts` / `scoring.ts` prompt sizes (~750 prompt tokens + ~120 completion ≈ 870 total tokens/call), 8K TPM caps you at **~9 concurrent judge calls per minute** and 200K TPD caps you at **~229 such calls per day**. With 36 ideas × 7 judges = 252 judge calls plus ~100 other Groq calls, you are **TPD-bound on gpt-oss-120b/20b and qwen**, not RPM-bound. Switching from `max_tokens: 500` (week0 probe default) to `700` (current code) increases completion tokens and therefore TPD pressure — the probe's 500-token assumption understates real TPD burn.

**Per-organization, not per-key.** The same Groq docs page states: *"Rate limits apply at the organization level, not individual users. You can hit any limit type depending on which threshold you reach first."* and the header table's notes say `x-ratelimit-limit-requests` always refers to RPD. Secondary sources that quote Groq confirm: *"Limits apply at the organization level, multiple API keys don't help."* (<https://www.cloudzero.com/blog/groq-pricing/>, <https://www.eesel.ai/blog/groq-pricing>, <https://tokenmix.ai/blog/groq-api-access-2026-free-tier-rate-limits>). **Implication:** the existing `GROQ_API_KEY` + `GROQ_API_KEY_2` random split (`router.ts:149`) only helps with **per-minute burst spreading** (30 RPM per model is per-org, so two keys do not double it either) and with **RPM-header jitter** — it does **not** double the 1,000 RPD or 200K TPD ceiling unless the two keys belong to two **separate Groq organizations** (different accounts, different org ids). The current `.env` has both keys but no evidence they are separate orgs; verify at <https://console.groq.com/settings/limits> per key.

**Developer plan (paid, card required).** Same docs page, **Developer Plan Limits** tab (not fetched in the Free-tab scrape, but documented at <https://console.groq.com/docs/billing-faqs> and pricing cards at <https://console.groq.com/docs/models>): base Developer limits are **~10× free** (e.g., `llama-3.1-8b-instant` 14.4K→500K RPD is cited at <https://klymentiev.com/blog/groq-pricing> and the 30→1000 RPM jump cited at <https://www.cloudzero.com/blog/groq-pricing/>), plus **Batch API** (50% off, async 24h–7d, at <https://console.groq.com/docs/batch>) and **Flex processing** (~10× higher rate limits at standard price, paid only, at <https://console.groq.com/docs/flex-processing>), plus `prompt caching` (50% off cached input, non-stackable with Batch — <https://console.groq.com/docs/prompt-caching>), plus **Spend Limits** with progressive billing thresholds ($1, $10, $100, $500, $1,000 — <https://console.groq.com/docs/spend-limits>). Critically, `groq.com/pricing` per-model cards show: `openai/gpt-oss-120b $0.15 in / $0.60 out per 1M`, `openai/gpt-oss-20b $0.075 / $0.30`, `qwen/qwen3.6-27b $0.60 / $3.00`, `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` now **Enterprise-only Contact Sales** (not self-serve) — which explains why they vanished from the Free table.

**Llama deprecation check.** `console.groq.com/docs/models` (fetched 2026-08-31) shows `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` as **Enterprise** with `ContactSales` and `llama-3.1-8b` in `DAILY_CAPS` is not even in the active table — these two DAILY_CAPS entries point at models you *cannot* self-serve anymore, free or paid. Do not budget around them.

**Groq multi-org / terms.** Groq's terms do not forbid multiple *organizations* per natural person for legitimate separate workloads, but creating many orgs **to circumvent rate limits** is against the spirit and risks suspension (secondary phrasing at <https://tokenmix.ai/blog/groq-free-tier-limits-2026>: "Groq's terms prohibit creating multiple accounts to circumvent rate limits"). Treat additional orgs as **one or two extra development orgs maximum**, not a scaling strategy.

### 2.2 Cloudflare Workers AI — 10,000 Neurons/day free, $0.011/1k above, per-model Neuron rates published

Primary: <https://developers.cloudflare.com/workers-ai/platform/pricing/> (fetched 2026-08-31)

- **Free allocation:** 10,000 Neurons/day on both Workers Free and Workers Paid, resets 00:00 UTC. Table at Pricing → Free allocation row: `Workers Free — 10,000 Neurons per day — N/A - Upgrade to Workers Paid`; `Workers Paid — 10,000 Neurons per day — $0.011 / 1,000 Neurons` (same page, 4 lines below the headline).
- **Meter:** Neurons, not tokens — but the same page publishes **Price in Tokens** alongside **Price in Neurons** so you can compare. Billing is at $0.011/1k Neurons for usage above the 10k free on Workers Paid.
- **Monitoring:** explicitly *"You can monitor your Neuron usage in the Cloudflare Workers AI dashboard"* at `https://dash.cloudflare.com/?to=/:account/ai/workers-ai` (same page, paragraph 3).
- **Paid-gated models:** 7 models require Workers Paid *or* prepaid AI Gateway credits: `@cf/moonshotai/kimi-k2.6`, `kimi-k2.7-code`, `zai-org/glm-5.2/5.3/5.3-flash`, `deepseek-ai/deepseek-v4-flash-0731`, `deepseek-ai/deepseek-v4-pro-0813` (same page, Note under pricing table).
- **Higher rate limits for frontier models via AI Gateway unified billing** (same page, "Pay with AI Gateway credits" section + linked `https://developers.cloudflare.com/workers-ai/platform/limits/#frontier-models`).

**Per-model costs for this project's three Workers AI model ids** (same Cloudflare pricing page, LLM model pricing table — fetched full table 2026-08-31):

| Model id (as in `src/router.ts`) | Input | Output | Input Neurons / M | Output Neurons / M | What this means at probe prompt size |
|---|---|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | $0.293 / M in | $2.253 / M out | 26,668 | 204,805 | ~800 in + 120 out tokens ≈ **21 + 25 = 46 Neurons/call**; 10k pool ≈ **~217 such calls/day** |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | $0.497 / M in | $4.881 / M out | 45,170 | 443,756 | same tokens ≈ **36 + 53 = 89 Neurons/call**; 10k pool ≈ **~112 such calls/day** |
| `@cf/baai/bge-base-en-v1.5` (embed) | $0.067 / M in | — | 6,058 | — | ~200 tokens/embed ≈ **1.2 Neurons**; 10k pool ≈ **~8,200 embeds/day** (but shares pool with chat) |

Two consequences:

1. **`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` is ~2× as Neuron-expensive per call as `llama-3.3-70b-instruct-fp8-fast`.** The router uses deepseek only for `code_generation` and `judging` Workers AI fallback. If Groq judging is exhausted and many judge calls fall through to deepseek, the Workers AI pool burns twice as fast as the dashboard's "10k Neurons" headline suggests.
2. **Codestral/Qwen-scale outputs are the expensive half.** Output Neurons are 7–10× input Neurons (table above). `max_tokens: 700` vs 500 directly scales the output term. This is why the 500→700 token-budget fix (correct for hidden reasoning) has a hidden Neuron cost.

### 2.3 The Workers Paid platform fee — $5/mo is the gate to *any* overage

Primary: <https://developers.cloudflare.com/workers/platform/pricing/> (fetched 2026-08-31)

- **Workers Free:** 100,000 requests/day, 10 ms CPU/invocation. **Workers Paid (Standard):** **$5.00/mo minimum**, then 10M requests included + $0.30/M, 30M CPU ms included + $0.02/M. Table at Pricing → Workers section (same page, first pricing table).
- Workers AI overage **requires** Workers Paid. The Workers AI pricing page says: *"To use more than 10,000 Neurons per day, you need to sign up for the Workers Paid plan. On Workers Paid, you will be charged at $0.011 / 1,000 Neurons for any usage above the free allocation."* (<https://developers.cloudflare.com/workers-ai/platform/pricing/>). So the cheapest way to unlock paid Workers AI is **$5 + $0.011/1k Neurons over 10k** — not $0.
- D1, R2, Vectorize, Queues etc. have their own free/paid splits on the same page — but none gate Workers AI.

### 2.4 Tavily search — pooled 3 keys is the right pattern

Primary: <https://docs.tavily.com/documentation/api-credits> + <https://tavily.com/pricing> + `src/agents/research.ts:21-36,52-53`

- Free credits: **1,000 credits/month** on the Researcher free tier, no card (Tavily docs + pricing page FAQ: *"You start with 1,000 free API credits per month with no credit card required."* at <https://docs.tavily.com/documentation/api-credits> and <https://tavily.com/pricing>).
- Basic search = **1 credit**, advanced = **2 credits** ( `research.ts:13-14` ), extract = **1 credit per 5 URLs** (comment at `research.ts:94` + `browser_research_probe.js:95`).
- Resets on the 1st of the month (pricing FAQ: *"Your API credits reset on the first day of each month"* at <https://tavily.com/pricing>).
- Nebius acquisition Feb 2026 is noted in market coverage (<https://websearchapi.ai/blog/tavily-alternatives>) but does not change the free allocation — still 1,000/mo source-of-truth.

**This project's pooled math** (verified in probe output): 3 accounts × 1,000 = 3,000/mo, `MONTHLY_CEILING 2700` leaves 300 buffer. Real usage 84–120 credits/event × 3 events/month = **252–360/mo ≈ 8–12% of the 3,000 pool** (`research.ts:21` + `browser_research_results.json:270-271`). Even adding `extract` on every critique (36 critiques × +1 credit = +36/event) stays well under 2700. **Tavily is not the bottleneck** — it is already correctly pooled.

**Tavily alternatives** for completeness (secondary, pricing verified Aug 2026):

| Provider | Free tier | Paid entry | Why not pooled like Tavily | Primary or best secondary |
|---|---|---|---|---|
| **Exa** | 1,000 searches/mo historically, now 2,000/mo cited at <https://www.buildmvpfast.com/tools/api-pricing-estimator/tavily> + <https://websearchapi.ai/blog/tavily-alternatives> | from ~$5/1k searches (Exa pricing page) | Exa's free is one-time $10 credit, no recurring refill unless card added — dropped already per `src/env.ts:28` comment and `research.ts:4` | secondary |
| **Brave Search API** | **2,000 queries/mo free** | $3 / 1k (`research.ts` predecessor research + <https://websearchapi.ai/blog/tavily-alternatives> comparison matrix) | Independent index, smaller coverage for niche queries; but genuinely free-forever with no card | secondary |
| **Serper (Google SERP)** | 2,500 searches free | $1.00/1k on Starter, $0.30/1k on Ultimate (<https://www.buildmvpfast.com/tools/api-pricing-estimator/tavily>) | Cheapest SERP API, but returns snippets only — needs second scraping step (the gap Tavily closes) | secondary |
| **Perplexity Sonar** | not free-forever (API credits $1/1k, <https://websearchapi.ai/blog/tavily-alternatives>) | $1/1k requests | Better for answer synthesis, worse for raw search + extract control | secondary |

---

## 3. Token & compute saving — what is already done and what remains

### 3.1 Already done (credit where due)

| Saving | Measured effect | Where |
|---|---|---|
| **TokenJuice compression** (`executor.ts:65-90`) | 39.2% char saving → **19.6% token saving**, discrimination loss 1.0 (≤1.5 = pass), verbosity still penalized | `token_compression_results.json:9,195` |
| **`reasoning_effort: "low"` for `gpt-oss`** (`router.ts:140-155`) | Moves hidden `<think>` to `message.reasoning` field, uses ~23 reasoning tokens vs eating the whole 700 budget | `router.ts:125-139` |
| **`reasoning_effort: "none"` for `qwen/qwen3.6-27b`** (`router.ts:135-141`) | Avoids 3223-char think block that never reaches JSON; now 284-char valid JSON | `router.ts:135-139` |
| **`max_tokens` now honored on Workers AI** (`router.ts:189`) | Fixes pre-2026-07-28 bug where Workers AI always ran at 256-token default | `docs/INVESTIGATION_2026-07-28.md` P0-1 |
| **`scopedAgentMemoryLimit` + `ARCHIVE_PRIOR_LIMIT`** | Limits RAG recall to 3 + priors to 3, so per-call prompt is capped | `memory.ts` + `research.ts:138` |
| **`deepResearchWithExtract` gated** | Only `handleCritique` uses extract (1.41× richer for +1 credit); `handleResearch` stays at 1 credit × 4 queries | `research.ts:224-238` |
| **`embed()` Neuron accounting** | Now records real `prompt_tokens × 6058 / 1M` instead of 0 | `memory.ts:36-52` |

### 3.2 What remains (ranked by $/effort)

| Lever | Saving | Effort | Free-tier impact | Notes |
|---|---|---|---|---|
| **Prompt caching** (Groq, <https://console.groq.com/docs/prompt-caching>) | **50% off cached input tokens**, no code beyond `cache_enabled: true` | Low | Stretches both TPM and TPD — the 8K TPM / 200K TPD limits *exclude* cached tokens (Rate Limits page: *"Cached tokens do not count towards your rate limits."*) | Biggest remaining Groq lever. The judging prompt (`scoring.ts:26-35`) repeats the same ~120-token rubric preamble on every call — textbook cache hit. Calibration alone (21 calls × same anchor preamble) would benefit on day one. Non-stackable with Batch, per <https://console.groq.com/docs/prompt-caching>. |
| **Batch API for non-interactive work** (Groq, <https://console.groq.com/docs/batch>) | **50% off all tokens**, separate from on-demand limits | Medium | Removes non-urgent judging off the hot path (50k requests/file, 24h–7d turnaround) | Fits Tribunal reflection (`reflect` is already Workers AI only *because* it's non-time-critical — `router.ts:65`) and calibration if you can tolerate async. Not for ideation/critique fans that need same-tick feedback. |
| **Cheaper embed model** | `bge-base-en-v1.5` 6058 → `bge-small-en-v1.5` **1841** Neurons/M (3.3× cheaper) or `bge-m3` 1075 (5.6× cheaper) — Cloudflare embeddings table at <https://developers.cloudflare.com/workers-ai/platform/pricing/> | Low | Embed is the one cost that never hits Groq — it is pure Workers AI Neurons. At 100+ embeds/event, switching to `bge-small` saves ~400 Neurons/event at 768→384 dims tradeoff. Verify Vectorize preset compatibility first: the index was created with `@cf/baai/bge-base-en-v1.5` preset (`.arena/state.json` week1 detail). Changing embed model requires reindexing or a second index. | The backlog's P1-4 says "don't touch DAILY_CAPS until embed accounting is real" — accounting is now real, so this becomes the next cheapest lever. |
| **Downgrade `judging` output model on Workers AI fallback** | `deepseek-r1-distill-qwen-32b` 443k output Neurons/M → `llama-3.3-70b-instruct-fp8-fast` 204k (2.2× cheaper output) | Low (one line in `TASK_MODELS`) | Each judge fallback call saves ~28 Neurons. Over 252 judge calls that don't hit Groq, that's ~7k Neurons — the difference between staying inside 10k and blowing past it. | Tradeoff: `deepseek-r1-distill-qwen-32b` was chosen after fixing `max_tokens` (INVESTIGATION_2026-07-28 P0-1) because it *completed* with 700 tokens. Verify the llama fallback still returns valid JSON before swapping — the old "too verbose" diagnosis was pre-fix. |
| **Reduce `max_tokens` on non-reasoning tasks** | `700` is proven for judging (reasoning models) but oversized for `summarize`/`validate`/`design` (non-reasoning `gpt-oss-20b` + `llama-3.3` fallback) | Low | Output Neurons scale with `max_tokens` on Workers AI; Groq tracks completion tokens against TPD/TPM. Dropping `summarize`/`validate` to 300–400 where the answer is 2–3 sentences saves tokens without truncation risk. | Requires a per-task `max_tokens` map rather than today's single `700` in `executor.ts:48` + `scoring.ts:42`. |
| **`DUPLICATE_SIMILARITY_THRESHOLD` + `selectDistinctTop2` already avoids wasted judging** | Not a token saving, but a *request* saving — deduplicating 36→~30 judged ideas saves 42 judge calls/event | Done | Judging 36 vs 30 ideas = 42 fewer judge calls out of ~252 | Keep. |
| **Judging batch size + concurrency tuning** | `processQueue` batch 3 × 7 parallel judges = 21 concurrent LLM calls/phase | Low | At 30 RPM, 21 concurrent calls is ~42 seconds of burst budget if they all hit the same model. Reducing `scoreTarget` concurrency from 7 to 3–4 or staggering with `p-queue` (Groq rate-limit skill pattern at <https://skillsmp.com/creators/jeremylongshore/claude-code-plugins-plus-skills/plugins-saas-packs-groq-pack-skills-groq-rate-limits>) avoids the `"stalled HTTP response canceled to prevent deadlock"` seen in 2026-07-23 (`week5_archive_tribunal` detail in `state.json`) | The `INVESTIGATION_2026-07-28` fix already exposed this — don't reintroduce 21-way concurrency. |
| **Pre-allocate `judging_provider` pin at event creation** | Saves 21 calibration calls when the pinned provider is known | Low | Calibration is 7 judges × 3 anchors = 21 calls/event. If the last event's pin was Groq and Groq still has headroom, reuse it without re-running Pearson (≥0.6 & ≤0.95 gate) | Requires spec change — calibration's *statistical* purpose (catching judge drift) argues against skipping it. |

---

## 4. Options to increase inference budget

Each option states: **cost**, **setup effort**, **free-tier increase**, **primary source**, and **fit against the spec constraint**.

---

### Option A — Groq Developer plan (paid, pay-as-you-go, card required) ⭐ RECOMMENDED #1

**What it is.** Add a payment method at <https://console.groq.com/settings/billing/plans>. No subscription fee; you pay per-token at month-end or at progressive thresholds ($1, $10, $100, $500, $1,000 — <https://console.groq.com/docs/spend-limits>). Billing FAQs confirm "no immediate charge, there is no minimum spend" (<https://console.groq.com/docs/billing-faqs>).

**What you get.**

- **~10× rate limits** on every model (e.g., `llama-3.1-8b-instant` 14.4K→500K RPD is the canonical example at <https://www.cloudzero.com/blog/groq-pricing/>; Groq's own table shows Developer RPM/TPM columns at <https://console.groq.com/docs/rate-limits> — toggle "Developer Plan Limits" to see your org's actual numbers after upgrade). For this project's three model ids, expect 1K RPD→~10K RPD and 8K TPM→~80K TPM (exact values visible after upgrade at <https://console.groq.com/settings/limits> — the docs page warns "there may be exceptions to these limits. You can view the current, exact rate limits for your organization").
- **No daily cap** in practice — Developer removes the 1,000 RPD wall that blocks the Arena's 300-400 Groq-call events. The `event_a0cbe12f` 191-failure stall is the canonical symptom of that wall.
- **Batch + Flex + Spend Limits** unlock (same Billing FAQs list): Batch 50% off, Flex ~10× higher rate limits at standard price, Spend Limits with alerts at 50/75/90%.
- **`llama-3.1-8b-instant` and `llama-3.3-70b-versatile` become available again** (today Enterprise-only Contact Sales at <https://console.groq.com/docs/models> — self-serve payment may re-enable them; verify post-upgrade).

**Cost.** Per-model list prices (Groq docs/pricing cards, fetched 2026-08-31 at <https://console.groq.com/docs/models>):

| Model (this project) | Input / 1M | Output / 1M | Blended at ~80% input / 20% output |
|---|---|---|---|
| `openai/gpt-oss-120b` (architecture) | $0.15 | $0.60 | **~$0.24 / M tokens** |
| `openai/gpt-oss-20b` (most tasks) | $0.075 | $0.30 | **~$0.12 / M** |
| `qwen/qwen3.6-27b` (judging) | $0.60 | $3.00 | **~$1.08 / M** |
| `qwen/qwen3.8-27b` (spare) | $0.80 | $4.00 | ~$1.44 / M |

Worked Arena cost at current probe prompt sizes (≈870 tokens/call average):

- Per ideathon Groq tokens ≈ 350 calls × 870 tokens ≈ **305k tokens** ≈ 244k in + 61k out (the judge prompts are longer in, shorter out). Cost at blended rates: ~**$0.07–$0.35 per ideathon** depending on which model dominates (gpt-oss-20b vs qwen). Hackathon adds ~20% more.
- At 3 Arenas/month (ideathon + hackathon each): **$0.25–$1.20/mo** on gpt-oss-heavy routing, **$1.00–$4.00/mo** if judging stays entirely on qwen. Even at the qwen end, this is coffee-money.
- With **Batch 50% off** for async judging (not applicable to the interactive ideation path): **$0.12–$0.60/mo** gpt-oss-heavy, **$0.50–$2.00/mo** qwen-heavy.
- With **prompt caching 50% off cached input** (judging rubric repeats): input cost halves on cache hits — roughly another 30–40% blended saving at 70% hit rate.
- **Stacked Batch + caching ≈ 25% of on-demand** (explicit at <https://www.cloudzero.com/blog/groq-pricing/> and Groq docs: "can be stacked for an effective rate of roughly 25%").

**Setup effort.** **Low** — 30 seconds to add a card at `console.groq.com/settings/billing/plans`, zero code changes (the same `GROQ_API_KEY` gains higher limits instantly). No model id changes needed. Recommend adding a `$10` Spend Limit on day one (docs at <https://console.groq.com/docs/spend-limits>).

**Free-tier increase.** Not a free-tier increase — it **replaces** the free tier with a near-free pay-as-you-go tier. But it is the only option that removes the 1,000 RPD wall while keeping the same provider and staying inside the spec's two-provider design.

**Spec fit.** ✅ No third provider. No VM. No new infrastructure. The spec's "don't add a third inference provider" is respected.

**Risk.** Qwen `qwen/qwen3.6-27b` is a **Preview** model at <https://console.groq.com/docs/models> ("may be discontinued at short notice" — same page, Preview section). Pinning judging to it on a paid plan still carries rotation risk. Consider pinning judging to `openai/gpt-oss-20b` or `gpt-oss-120b` if qwen is de-previewed — same price structure, longer support window.

---

### Option B — Cloudflare Workers Paid ($5/mo) to unlock Workers AI overage ⭐ RECOMMENDED #2 (pair with A)

**What it is.** Upgrade the Cloudflare account at `https://dash.cloudflare.com/?to=/:account/billing` to **Workers Paid** — **$5.00/mo minimum**, includes 10M Workers requests + 30M CPU ms + the same 10k Neurons/day free, then **$0.011 per 1,000 Neurons** for Workers AI usage above 10k (Cloudflare pricing pages §2.2–2.3 at <https://developers.cloudflare.com/workers-ai/platform/pricing/> + <https://developers.cloudflare.com/workers/platform/pricing/>).

**What you get.**

- Workers AI stops hard-failing at 10k Neurons/day. Past 10k, you pay $0.011/1k Neurons (≈ $0.011 per ~22 llama-3.3 judge calls or ~11 deepseek judge calls at probe sizes — see §2.2 table).
- Workers Paid also lifts the Worker's own 100k requests/day → 10M/mo and 10 ms CPU → 30M CPU ms/mo (first pricing table at <https://developers.cloudflare.com/workers/platform/pricing/>). The Arena's cron (every 5 min = 8,640 invocations/mo) and D1/Vectorize usage are already well inside free — this is headroom, not a cost driver.

**Cost.**

- **Base:** $5.00/mo (platform minimum, covers Workers + Pages Functions + KV + Durable Objects + Hyperdrive on one account — same page, footnote).
- **Workers AI overage at Arena scale:** ideathon ≈ 3.5k Neurons (see §1.5). Even if the entire Groq judging load fell through to Workers AI (worst case ~11k Neurons), overage = 1k × $0.011 = **$0.011 per such event**. At 3 Arenas/mo with one worst-case overflow: **$5.03/mo**. At 10× scale: **$5.11/mo**. Realistically, **$5.00–$5.30/mo** total.
- Frontier models (`kimi-k2.6`, `glm-5.2` etc.) require Workers Paid anyway (pricing note at <https://developers.cloudflare.com/workers-ai/platform/pricing/> § "Some models require a paid billing method") — not needed for this project today, but the gate is the same $5.

**Setup effort.** **Trivial** — one dashboard toggle, no code, no secrets rotation, no model id changes. Neuron overage is automatic.

**Free-tier increase.** Doubles the *effective* Workers AI budget from "hard fail at 10k" to "soft pay at 10k" — the 9500→10,000 gap in `DAILY_CAPS` becomes moot (raise `DAILY_CAPS["workers_ai"]` to `10000` or to `Infinity` with spend-limit alerting).

**Spec fit.** ✅ No third provider. No VM. Zero architecture change.

**Risk.** None material. The $5 is the cheapest production insurance in this doc. The only nuance: Cloudflare bills Workers AI Neurons **per model**, so a future switch to Neuron-expensive models (e.g., `deepseek-r1-distill-qwen-32b` at 443k output Neurons/M) scales the overage faster — but still at $0.011/1k, the absolute dollars remain tiny.

**Recommendation:** Do this **even if you do nothing else**. It is the only option that makes `event_a0cbe12f`-class Workers AI exhaustion degrade into a $0.01 charge instead of 191 queued failures and a stalled Arena cadence (the `checkForStalledEvents` / `MAX_ITEM_ATTEMPTS` watchdog at `INVESTIGATION_2026-07-28` is a last resort — paying $0.01 is cheaper than abandoning an event).

---

### Option C — Add a second (or third) Groq organization — free, but capped and ToS-sensitive

**What it is.** Create a second Groq organization (separate account, separate `https://console.groq.com/settings/limits` page, separate API key) and wire `GROQ_API_KEY`, `GROQ_API_KEY_2`, … round-robin as today (`router.ts:149`). The current code already does 50/50 random split but both keys appear to be under one org (same `GROQ_API_KEY` prefix shape, no org separation documented), so today it provides **RPM burst spreading, not RPD/TPD doubling** (see §2.1).

**What you get (if separate orgs).** Each org gets its own 1,000 RPD / 200K TPD / 8K TPM per model. Two orgs ≈ 2,000 RPD + 400K TPD effective; three orgs ≈ 3,000 RPD + 600K TPD. At last measured RPD-per-model (~300 judge calls + ~100 other calls per event on the dominant model), two orgs comfortably covers one Arena, three orgs covers back-to-back retry storms.

**Cost.** $0 (free tier × N).

**Setup effort.** **Low** — new Groq account, new API key, add `GROQ_API_KEY_3` to `.env` + `wrangler secret put`, extend the `Math.random()` split to N-way. But the `.env` already has `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, `GROQ_API_KEY` — naming is inconsistent; clean up before adding a third.

**Free-tier increase.** **~2–3×** on Groq specifically, linearly with org count.

**Spec fit.** ⚠️ **Gray area.** The spec's "don't add a third inference provider without the user explicitly asking" is satisfied (this is still Groq), but Groq's own terms intent matters. Creating orgs to *circumvent* rate limits is against the spirit (see §2.1). Two orgs for "production vs development" is defensible; five orgs to avoid a $1/mo Developer bill is not. The doc's recommendation is: **do not scale this beyond 2 orgs**, and treat it as a stopgap until Option A is enabled. If you go to 3 orgs, document the org purpose in `docs/` and don't rotate keys to evade 429s — use backoff (`retry-after` header at <https://console.groq.com/docs/rate-limits> § Rate Limit Headers).

**Measured evidence that this is not the current bottleneck's fix:** `inference_pool_results.json:12,41` shows `x-ratelimit-remaining-requests: 999→997` per model — headroom existed. The `event_a0cbe12f` 191-failure stall is more plausibly **TPD or Workers AI Neurons**, not RPD per-model. Adding orgs helps RPD headroom but does not help if TPD or Neurons is the binding limit — which at 700-token budgets, it is.

---

### Option D — Third inference provider (Cerebras, Together, OpenRouter, Hugging Face, etc.) — evaluated but **NOT recommended** without explicit user approval (per CLAUDE.md)

The brief explicitly says *"Spec deliberately says don't add third inference provider without explicit user ask … but user now explicitly asks to research"* — so this section researches, not recommends. The spec's standing rule at `CLAUDE.md:68` is: *"Don't add a third inference provider without the user explicitly asking for it. Two providers is a deliberate choice, not an oversight."* Adding a third provider is therefore a **user-decision-gated** change even after this research.

| Provider | Free tier (primary-source-backed) | API compat | Why it was considered | Why it stays out of the recommendation |
|---|---|---|---|---|
| **Cerebras** (`https://inference-docs.cerebras.ai/support/rate-limits`) | **1M tokens/day free** on `gpt-oss-120b` / `glm-4.7`, 5 RPM (not 30), 30K TPM, no card — but 1M/day is generous vs Groq 200K | OpenAI-compatible `https://api.cerebras.ai/v1` | Fastest inference (1,800 tok/s on `gpt-oss-120b` per Morph April 2026), generous daily volume | Free tier **8K context cap** + only 2 models + 5 RPM is too thin for 7-parallel judge bursts; paid Developer is 10× higher but still a third integration (new SDK path, new error codes, new `DAILY_CAPS` dimension). Probed as best "third" on cost, worst on rate-limit shape. |
| **Together AI** | No free-forever tier; free credits trial only (varies) | OpenAI-compatible | Hosts 100+ models, fine-tuning, custom weights | Not free-forever — directly contradicts the project's "no card, free-forever" gate in `CLAUDE.md` and `week0-spike/inference_pool_probe.js:16-18`. |
| **OpenRouter** | 25+ free models (`:free` variants), **50/day** free, **1,000/day after $10 credit purchase**, 20 req/min — at <https://www.truefoundry.com/blog/openrouter-pricing>, <https://klymentiev.com/blog/huggingface-inference-api> | OpenAI-compatible, unified gateway | One key for 400+ models, auto-fallback routing | 50 free calls/day is **2% of one Arena's judge needs** (252 calls). The gateway fee is 5.5% on credit purchases (<https://www.truefoundry.com/blog/openrouter-pricing>). Model availability on `:free` variants flickers — not a stable pin target for `judging`. |
| **Hugging Face Serverless Inference API** | **~1,000 req/day free**, ~10B param cap, cold starts 3–10s, no SLA — at <https://huggingface.co/pricing> + secondary <https://klymentiev.com/blog/huggingface-inference-api> | OpenAI-compatible via Inference Providers | 150k+ models, genuinely free, no card | 1k/day is same wall as Groq; cold starts break the `processQueue` batch window; >10B models need PRO ($9/mo) which changes latency guarantees. Inference *Providers* (the unified gateway) is separate from Serverless and is paid pass-through — easy to confuse, wrong to budget. |
| **Fireworks / Anyscale** | Trial credits, not free-forever | OpenAI-compatible | Fast, cheap per-token | Same "not free-forever" gate as Together. |

**Routine for any third provider if the user later approves one:** the router would gain a `tryThirdProvider(env, model, req)` alongside `tryGroq`/`tryWorkersAI` (`router.ts:120-205`), with its own `DAILY_CAPS` key, its own `provider_usage_log` rows, and a pinned-model extension to `archive_events` (today only `judging_provider = "groq" | "workers_ai"` at `db/schema_week8_judge_model_tracking.sql:15-16`). The queue already handles third-tier overflow (it just retries). The hidden cost is **pin drift**: judging pinned to Groq on calibration but scored on Cerebras mid-event is worse than the current Groq→Workers AI drift — three providers makes the `passed: false` calibration flag (`scoring.ts` anti-verbosity clause) less meaningful. Do not add a third provider without also extending `calibration.ts:112-150` to pin *across* providers and `scoring.ts:103-105` to enforce it.

---

### Option E — Stay on free, spend less: prompt caching + cheaper models + token hygiene (no spend, no provider)

**What it is.** The remaining savings from §3.2, ordered by ROI, with no provider change:

1. **Enable Groq prompt caching** (`cache_enabled: true` per <https://console.groq.com/docs/prompt-caching>) on the judging rubric preamble and the architecture scaffold. Groq excludes cached tokens from RPM/TPM/TPD and bills cached input at 50% — this is the single cheapest way to stretch 200K TPD. Estimated **30–40% blended cost reduction** at 70% judge-prefix hit rate — measured by comparing `prompt_tokens` in the next `judge_bias_probe.js` run with caching on vs off.
2. **Switch embed model** `bge-base-en-v1.5` (6058 Neurons/M) → `bge-small-en-v1.5` (1841) or `bge-m3` (1075) at <https://developers.cloudflare.com/workers-ai/platform/pricing/> — 3–5× cheaper per embed. Tradeoff: 768→384 dims or reindex cost. Measure recall quality on the agent archive before committing (the `0.990` duplicate vs `0.586–0.742` distinct gap at `INVESTIGATION_2026-07-28.md:359-366` is wide enough to tolerate smaller dims, but not proven).
3. **Per-task `max_tokens`**: judging stays 700 (reasoning), `summarize`/`validate`/`design`/`research` drop to 350–400. Saves ~300 output tokens × 204k–443k Neurons/M ≈ **~60–130 Neurons per such call** on Workers AI and proportional TPD on Groq.
4. **Queue tuning**: cap `scoreTarget` concurrency to 3–4 (not 7), stagger with `p-queue` sized to RPM/interval (pattern at <https://skillsmp.com/creators/jeremylongshore/claude-code-plugins-plus-skills/plugins-saas-packs-groq-pack-skills-groq-rate-limits>), and enforce the existing `PER_EVENT_BUDGETS` + `MONTHLY_CEILING` guards before fan-out. Prevents the retry storm that turns one TPD exhaustion into 191 failures.
5. **Pre-check TPD budget** before `queueIdeationAndCritique` fans 36 ideas — if Groq TPD remaining < estimated cost of the fan-out, defer or route that batch to Workers AI upfront rather than failing per-idea and retrying.

**Cost.** $0.

**Setup effort.** Low–Medium (caching is one JSON key; embed swap is a migration; per-task max_tokens is a small refactor of `TASK_MODELS` to include `maxTokens`).

**Free-tier increase.** **+40–60% effective Groq TPD** (caching alone) + **+5–10% Workers AI headroom** (embed swap). Not enough to make `event_a0cbe12f`-scale stalls disappear, but enough to halve their frequency.

**Spec fit.** ✅ No provider, no VM.

---

### Option F — Tavily search: already optimal; cheapest further lever is Brave as overflow

**What it is.** Today 3-key round-robin is **already the cheapest correct design** (§2.4: 8–12% of pooled 3,000/mo at 3 Arenas/mo). The only cheaper lever is adding a **one-time Brave Search API key** (2,000 queries/mo free at <https://websearchapi.ai/blog/tavily-alternatives> comparison matrix) as a *fallback* when `manyCalls ≥ 2700` or when Tavily returns empty — not as a replacement. Brave's independent index is the only free-forever search API with a higher free quota than Tavily (2,000 vs 1,000).

**What you get.** 2,000 Brave queries/mo free vs 1,000 Tavily/mo per key. Pooling 3 Tavily + 1 Brave ≈ **5,000/mo free** for the same `research.ts` round-robin (extend `selectTavilyKey` to `selectSearchKey`).

**Cost.** $0 (Brave free tier, no card).

**Setup effort.** Low–Medium (new `BRAVE_API_KEY` secret, new `searchBrave` fetch at `https://api.search.brave.com/res/v1/web/search`, snippet-only grounding — Brave does not return Tavily's `answer` field or the `extract` step, so it is strictly a snippet fallback).

**Free-tier increase.** **+67% search credits** (3,000→5,000) for one extra secret.

**Spec fit.** ✅ Not an inference provider — search is not inference (the spec's two-provider rule is inference-only). No VM. `src/env.ts:28-37` already documents that Exa was dropped for Tavily on free-tier sustainability — Brave follows the same "free-forever, no card" filter that Tavily passed.

**When to do it.** Only if search ever nears 2700/mo — today it is at ~300/mo, so this is **deferred**. Track `research_calls` count at month-start (`research.ts:79-84` `monthlyCallCount`) and alert at 1,500/mo; wire Brave only then.

---

## 5. Ranked recommendation

| Rank | Option | Monthly cost | Free capacity gain | Effort | Do when |
|---|---|---|---|---|---|
| **1** | **A — Groq Developer** | **$0.25–$4.00/mo** (see §4.A worked math; $0.12–$2.00/mo with Batch; $0.18–$2.60/mo with caching — primary: <https://console.groq.com/docs/billing-faqs>, <https://console.groq.com/docs/batch>, <https://console.groq.com/docs/prompt-caching>) | **~10× Groq** (removes 1,000 RPD wall) | Low — add card, set $10 spend limit | **Now.** Single biggest fix for `event_a0cbe12f`-class stalls. No code. |
| **2** | **B — Cloudflare Workers Paid $5** | **$5.00–$5.30/mo** (primary: <https://developers.cloudflare.com/workers-ai/platform/pricing/> + <https://developers.cloudflare.com/workers/platform/pricing/>) | **∞ Workers AI** (hard fail → pay-per-use at $0.011/1k Neurons) | Trivial — dashboard toggle | **Now, paired with A.** Makes Workers AI exhaustion a $0.01 overage instead of 191 queued failures. |
| **3** | **E — Prompt caching + embed/model hygiene** | **$0** | **+40–60% effective Groq TPD** (primary: <https://console.groq.com/docs/prompt-caching>) | Low–Medium | **Next sprint.** Do caching regardless of A/B — it stretches free *and* paid. |
| **4** | **C — Second Groq org (max 2)** | **$0** | **~2× Groq RPD/TPD** | Low | **Only as a stopgap if A is delayed.** Do not scale to 3+ orgs. Verify org separation at `<https://console.groq.com/settings/limits>` per key. |
| **5** | **F — Brave search fallback** | **$0** | **+67% search** (3k→5k/mo) | Low–Medium | **Deferred** — wire only if `monthlyCallCount ≥ 1500`. |
| **6** | **D — Third inference provider** | **$0–$9/mo** (Hugging Face PRO) to **usage-based** | **+1k/day** (HF) to **+1M/day tokens** (Cerebras) | Medium–High (router + pinning + caps) | **Only if the user explicitly approves a third provider** after reviewing this doc — see `CLAUDE.md:68` + §4.D spec warning. |

**First-$10 path:** Enable **A at $0.25–$4/mo + B at $5/mo + E-cache at $0** → **~$5.25–$9.00/mo total** for a 3-Arena/month workload with retry storms eliminated. That is the entire budget story: **under $10/mo removes every documented exhaustion mode** without adding a provider or a VM.

**If the user insists on staying strictly $0:** Do **E + C (max 2 orgs) + B-deferred** → ~2× Groq RPD + 40% caching stretch + embedding hygiene. This halves stall frequency but **does not eliminate** the 1,000 RPD wall — `event_a0cbe12f` will recur under burst judging (36 ideas × 7 judges = 252 calls on one model id) whenever TPD is also under pressure. Document that tradeoff explicitly if $0 is a hard constraint.

---

## 6. Operational checks to run before the next Arena

1. **Verify Groq org separation** — call `https://api.groq.com/openai/v1/models` with each of the two `.env` Groq keys and open `https://console.groq.com/settings/limits` while authenticated as each org. If both pages show the same org name / same remaining RPD, you have **one org, two keys** — the 50/50 split does not double RPD. Decide A or C based on that answer.
2. **Re-derive `DAILY_CAPS["workers_ai"]`** — after at least one full Arena with corrected `embed()` accounting, compare `SELECT SUM(units_used) FROM provider_usage_log WHERE provider='workers_ai' AND day = 'YYYY-MM-DD'` against the Cloudflare AI dashboard's daily Neuron total. The dashboard is the arbiter; the doc's 9500 is a guess.
3. **Enable Groq header logging** — `router.ts:150-159` already discards the `x-ratelimit-*` headers. Log `x-ratelimit-remaining-requests` / `x-ratelimit-remaining-tokens` / `retry-after` on each Groq 429 to `provider_usage_log` (or a new `rate_limit_events` table) — the Week 0 probe already reads `x-ratelimit-remaining-requests` at `inference_pool_probe.js:68` but the production router does not.
4. **Turn on Groq prompt caching** on judging + calibration calls (one JSON key) and on the `handleSubmitIdea` research-context preamble. Measure `prompt_tokens` delta in the next `judge_bias_probe.js` run — the caching docs claim non-stackability with Batch, so measure caching *first*, Batch *second*.
5. **Set Spend Limits** — $10 on Groq (<https://console.groq.com/docs/spend-limits>) and a Worker log trigger on `cron_heartbeat` staleness (already in `db/schema.sql` + `public/observatory/headroom.html` per `INVESTIGATION_2026-07-28.md` § P2-8) — so overage is visible before it is billable.

---

## 7. What this doc deliberately does NOT propose

- **A VM / Cloudflare Container / VPS** — the brief forbids it and the spec's no-VM rule at `CLAUDE.md:64` ("Don't reintroduce a VM anywhere. If a task seems to need one, re-read spec §2 first, then flag it and ask") is respected. Every option above stays inside Workers + Groq + Cloudflare's own serverless surfaces.
- **A third inference provider as a default** — researched in §4.D, deferred pending explicit user approval per `CLAUDE.md:68`. The cheapest *free-forever* third provider that would actually help (Cerebras 1M/day) is also the worst on burst RPM (5 RPM free) — a mismatch for 7-parallel judge fans.
- **Model-id churn** — `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` are in `DAILY_CAPS` but absent from the live Free table and listed as Enterprise-only at <https://console.groq.com/docs/models>. Do not reintroduce them as "budget savers" — they are not self-serve.
- **Hardcoding a new `DAILY_CAPS` value from this doc** — the doc's job is to cite the *platform* caps (8K TPM / 200K TPD / 1K RPD per Groq model; 10k Neurons/day Workers AI). The app's `DAILY_CAPS` must be set from **measured dashboard totals**, not from this doc's estimates (same rule as `router.ts:70`).

---

## 8. Sources

Ordered by load-bearing claim. A claim without a source below is either this repo's own source (path cited in §0) or arithmetic on numbers that are themselves sourced.

| # | Claim | Primary source |
|---|---|---|
| 1 | Groq Free RPD/RPM/TPM/TPD per model (incl. `openai/gpt-oss-120b 30/1K/8K/200K`) and "Rate limits apply at the organization level" + `x-ratelimit-*` header semantics | <https://console.groq.com/docs/rate-limits> (fetched 2026-08-31, Free Plan Limits tab) |
| 2 | `llama-3.1-8b-instant` + `llama-3.3-70b-versatile` now Enterprise-only ContactSales (not in Free table) + `qwen/qwen3.6-27b` $0.60/$3.00 + `openai/gpt-oss-120b` $0.15/$0.60 + `gpt-oss-20b` $0.075/$0.30 + 131k context | <https://console.groq.com/docs/models> (fetched 2026-08-31) |
| 3 | Groq Developer unlocks ~10× limits + Batch (50% off) + Flex (~10× RPM at std price, paid only) + prompt caching (50% off cached input, non-stackable with Batch) | <https://console.groq.com/docs/billing-faqs> + <https://console.groq.com/docs/batch> + <https://console.groq.com/docs/flex-processing> + <https://console.groq.com/docs/prompt-caching> |
| 4 | Groq Spend Limits progressive thresholds ($1/$10/$100/$500/$1000) + "no immediate charge" on upgrade | <https://console.groq.com/docs/spend-limits> + <https://console.groq.com/docs/billing-faqs> |
| 5 | Workers AI 10,000 Neurons/day free on both Free + Paid, $0.011/1k above, 00:00 UTC reset, dashboard URL, per-model Neuron/Token table, 7 frontier models require Paid | <https://developers.cloudflare.com/workers-ai/platform/pricing/> (fetched 2026-08-31, incl. full LLM + embeddings + audio tables) |
| 6 | Workers Paid $5/mo min, 10M requests + 30M CPU ms included, then $0.30/M + $0.02/M | <https://developers.cloudflare.com/workers/platform/pricing/> (fetched 2026-08-31) |
| 7 | Tavily 1,000 credits/mo free, no card, basic=1 adv=2, resets 1st of month, extract=1/5 URLs | <https://docs.tavily.com/documentation/api-credits> + <https://tavily.com/pricing> |
| 8 | Cerebras free 1M tokens/day, 5 RPM, 30K TPM, 8K context cap, 2 models | <https://inference-docs.cerebras.ai/support/rate-limits> |
| 9 | Brave Search API 2,000/mo free, $3/1k; Serper 2,500 free, $1.00/1k→$0.30/1k; Perplexity Sonar $1/1k | secondary pricing aggregators that cite provider pages: <https://www.buildmvpfast.com/tools/api-pricing-estimator/tavily> + <https://websearchapi.ai/blog/tavily-alternatives> comparison matrix |

---

*Generated for `C:\Users\aditya\Desktop\AI_arena_hackathon_project\AI_arena_hackathon` — read `src/router.ts:70` before changing `DAILY_CAPS`, read `CLAUDE.md:68` before adding a provider, and read `docs/INVESTIGATION_2026-07-28.md:359-366` before changing the 0.90 similarity threshold. No files besides this one were modified.*
