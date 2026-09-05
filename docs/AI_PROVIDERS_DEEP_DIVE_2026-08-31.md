# AI Providers — Official Docs Deep Dive + New Provider Evaluation

**Date:** 2026-08-31
**Sources:** primary docs fetched 2026-08-31 (URLs inline). All prices/limits are Free-tier unless marked Paid.

## 1. Current providers (as coded in `src/router.ts:36-91` `DAILY_CAPS`)

### Groq — `console.groq.com/docs/rate-limits` + `groq.com/pricing` + `console.groq.com/docs/models`

| Model (live in `TASK_MODELS`) | Free RPM | Free RPD | Free TPM | Free TPD | Paid $/1M in / out | Context |
|---|---|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | 1,000 | 8,000 | 200,000 | $0.15 / $0.60 (cached $0.075) | 131K |
| `openai/gpt-oss-20b` | 30 | 1,000 | 8,000 | 200,000 | $0.075 / $0.30 (cached $0.0375) | 131K |
| `qwen/qwen3.6-27b` | 30 | 1,000 | 8,000 | 200,000 | $0.60 / $3.00 | 131K |
| `groq/compound-mini` | 30 | 250 | 70,000 | — | — | — |
| `llama-3.1-8b-instant` (legacy in `DAILY_CAPS` but **not routable**, now Enterprise) | 30 | 14,400 | 6,000 | 500,000 | $0.05 / $0.08 | — |
| `llama-3.3-70b-versatile` (legacy) | 30 | 1,000 | 12,000 | 100,000 | $0.59 / $0.79 | — |

- Limits **per organization, not per key** (`console.groq.com/docs/rate-limits`: “Rate limits apply at the organization level”). Second key `GROQ_API_KEY_2` (`router.ts:149` random split) helps burst only if second org.
- **Paid Developer:** ~10× limits, zero min, `Spend Limits $1/$10/$100…` (`console.groq.com/docs/spend-limits`), `Batch 50% off` (`/docs/batch`), `Prompt caching 50% off` cached input, non-stackable (`/docs/prompt-caching`), `Flex 498 capacity_exceeded` (`/docs/flex-processing`).
- **This Arena TPD-bound:** 870 tok/call × 252 judge calls = 219K tokens > 200K TPD → hits TPD before RPD.

### Cloudflare Workers AI — `developers.cloudflare.com/workers-ai/platform/pricing`

- **Free:** 10,000 Neurons/day (Free & Paid), resets 00:00 UTC. **Paid:** Workers Paid $5/mo min (`workers/platform/pricing`) then $0.011 / 1K Neurons over 10K. Dashboard: `dash.cloudflare.com/?to=/:account/ai/workers-ai`.
- **Per-model Neurons (selected):** `llama-3.3-70b-instruct-fp8-fast` 26,668 in / 204,805 out per M; `deepseek-r1-distill-qwen-32b` 45,170 / 443,756; `bge-base-en-v1.5` 6,058 / M in, `bge-small` 1,841 (3.3× cheaper) — table §“LLM/Embeddings model pricing”. At 870 tok judge call: ~46 Neurons (llama-3.3) vs ~89 (deepseek). Free pool ≈ 217 vs 112 such calls/day.
- **Note:** 700 max_tokens directly scales output Neurons (2× input cost).

### Tavily — `docs.tavily.com/documentation/api-credits` + `tavily.com/pricing`

- 1,000 credits/mo free, Basic=1, Advanced=2, Extract=1 per 5 URLs. Resets 1st. Pooled 3×1K=3K/mo, `MONTHLY_CEILING 2700` (`research.ts:52`). Usage 84–120/event → 8–12% pool. Not bottleneck.

## 2. New providers — official docs

### Cerebras — `inference-docs.cerebras.ai/support/rate-limits` + `cerebras.ai/pricing`

- **Paid-first, not free-forever:** “No permanently free tier. Free Trial $5 credits, expire 30 days after grant, require verified payment method. After credits expire → Pay-as-you-go” (FAQ accordion). Once credits gone, API stops until purchase.
- **Free Trial limits (while credits last):** ~1M tokens/day on Llama 3.3 70B, ~30 req/min, 8K context cap on free tier (secondary `pricepertoken.com` + primary FAQ). Developer first purchase → 10× limits, no daily cap.
- **Paid:** $0.10–$1.20 /1M (Llama 3.1 8B $0.10/$0.10, Llama 3.3 70B $0.85/$1.20, Qwen 3 32B $0.40/$0.80 — `costbench.com` verified 2026-08-06 + `cerebras.ai/pricing`).
- **Fit:** 1M/day is 5× Groq 200K TPD, 1,800 tok/s fastest — but trial expiry + $10 min + 5 RPM on free makes it not free-forever for Arena's 252-judge burst. Best as paid fallback, not free tier.

### Together AI — `together.ai/pricing`

- **Free:** $5 credits on signup (no recurring refill). 68 models at no cost historically cited but primary pricing page shows **usage-based no free refill** — after $5, pay per token. Agent `cloudzero 2026-05-11` notes $25 free → now $5 (shrank). No daily free reset.
- **Paid:** $0.05–$9.00 /1M (GPT-OSS 20B $0.05/$0.20, GPT-OSS 120B $0.15/$0.60, DeepSeek V3.1 $0.60/$1.70, V4 Pro $2.10/$4.40, R1 $3.00/$7.00 — `aipricing.guru 2026-08-29`). Batch 50% off, cached input ~5× cheaper on GLM-5.2 ($1.40→$0.26).
- **Fit:** Broadest catalog (200+ models, Turbo/Lite/Reference quant). No daily free means not a Groq replacement for free Arena.

### Hugging Face — `huggingface.co/pricing` + `huggingface.co/docs/inference-providers/pricing` + `klymentiev 2026-06-10`

- **3 products:** Serverless Inference API (free few hundred req/hr, <10B params, cold start 10–30s) vs Inference Endpoints (dedicated GPU $0.50/GPU/hr, $0.03/CPU/hr) vs Inference Providers (gateway to Groq/Together/Cerebras etc, pass-through).
- **Free:** Serverless shared, few hundred/hr, <10B — 70B+ gated/heavily limited. **PRO $9/mo**: higher Serverless limits + 25 min/day H200 ZeroGPU + 2M Provider credits + 1TB private.
- **Fit:** Serverless not for 70B judging; Providers gateway is duplicate of direct Groq/Together.

### OpenRouter — `openrouter.ai/pricing`

- **Free:** 26 free models (`:free`), **20 RPM / 200 req/day / 50 req/day per OpenRouter docs**, no card. Rotating set (Llama 3.3 70B, Qwen3 Coder, Gemma 4 31B, GPT-OSS 120B free variant).
- **Paid:** 355+ models, $0.075–$15 /1M, **5.5% credit purchase fee**, BYOK 5% fee. $5 min purchase, non-refundable. Upstream provider throttles still apply.
- **Fit:** Widest model access via one key + fallback chains; but 200/day is 80% of one Arena's judge needs. Free models rotate without notice — not stable pin target.

### Mistral — `mistral.ai/pricing` + `La Plateforme`

- **Free:** “Free (Experiment)” — rate-limited Mistral Small & Nemo, OpenAI-compatible, no card. Not production.
- **Paid:** Large $2.00 in / $6.00 out per M, Small $0.10–$0.20 /M, batch 50% off. Also consumer Le Chat $0–$14.99/mo separate.
- **Fit:** European, open-weight + Codestral code model. Free too thin for 252 judges.

### Others quickly (secondary but cited)

| Provider | Free | Paid | Note |
|---|---|---|---|
| **Cohere** | trial credits | $0.15–$15 /M | — |
| **AI21** | $5 trial | — | — |
| **Anyscale** | $10 trial | $0.15/M | — |
| **Brave Search** (search, not inference) | 2,000 queries/mo free | $3/1K | +67% search pool vs Tavily, snippet-only |

## 3. Comparison for Arena (252 judge calls × 870 tok = 219K tokens/event)

| Provider | Free daily capacity for this workload | Events before hit | Cost to double capacity | Stable pin? |
|---|---|---|---|---|
| **Groq Free** | 1K RPD / 200K TPD | 0.9 events on gpt-oss-120b (TPD) | $0.25–4/mo Developer (10×) | Yes — official ids |
| **Workers Free** | 10K Neurons ≈112 deepseek /217 llama judge calls | 0.4–0.9 events if fallback | $5/mo + $0.011/1K | Yes |
| **Cerebras Trial** | 1M tokens ≈4.5 events (then $5 expired) | 4.5 then stop | $10 min (10× limits) | No — trial expiry |
| **Together** | $5 credits ≈ 8–16 events (one-time) | ~10 then pay | $0.60/$1.70 DeepSeek | Medium |
| **HF Serverless** | few hundred/hr <10B | 0 events for 70B | $9 PRO | No |
| **OpenRouter Free** | 200/day | 0.8 events | 5.5% fee + per-token | No — rotating |

## 4. Recommendation (unchanged but now grounded)

1. **Groq Developer** + **Workers Paid $5** = $5.25–9/mo, removes both walls. Lowest friction, stays 2-provider (`CLAUDE.md:68`).
2. **E-caching/embed** $0 next sprint regardless.
3. **Cerebras/Together/OpenRouter** only if user explicitly approves third provider — Cerebras best free volume but trial-bound, Together best catalog, OpenRouter best gateway — none free-forever at Arena scale.
