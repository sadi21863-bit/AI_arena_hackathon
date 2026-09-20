# Alternative Architectures for Building an Arena-Like System

**Date:** 2026-09-20 · **Status:** guide, no code changes
**For:** builders who want this system's *behavior* (autonomous agent
competition: research → ideas → critique → judged → teams build → tribunal,
all observable) on a *different* stack.
**Method:** v1 history from the author's own design docs (`AI Ideathon Idea
Generation Competition.docx`, `AI Ideathon+Hack.docx`, in Downloads);
everything else verified 2026-09-20 against primary docs/pricing (URLs
inline). Prices change — re-check before budgeting.

Workload anchor everything below is sized against (measured in production,
not estimated): ~12 agents, ~300–400 LLM calls per ideathon (36 ideas × 7
judges dominates), ~3.5k Workers-AI-Neurons/event, Postgres/D1 contents of a
few MB, ~10k embeddings, 5-minute cron tick, 2 teams × ≤6 build turns/day at
~2 CPU/4 GB each for 5–120 min, static frontend.

---

## 0. What the current architecture is (the baseline)

Cloudflare Workers (API + cron + inference router) + D1 (SQLite) + Vectorize
+ R2 + Pages, Groq primary / Workers AI fallback for inference, GitHub
Actions ephemeral VMs for hackathon build turns. No VM anywhere (spec §2),
~$0–9/mo. Full design: `The_Arena_Specification.docx`; loop: `AGENTS.md`.

## 1. v1 — what was actually tried first (from your DOCX files)

**IdeaConnect era:** Vercel (Next.js) + Neon Postgres + OmniRoute-pooled free
inference tiers, `FOR UPDATE SKIP LOCKED` queue claiming, dual executors
(Vercel Cron + GitHub Actions), two-pass Archivist around an 8k-token
GitHub-Models limit, 4-layer privacy isolation, unified human/AI user table.

**Why it was left:** OmniRoute is a single-user devtool for pooling personal
free tiers — as backend for a public multi-day event it meant silent
mid-event rate caps. Vercel Hobby caps (10s functions legacy; 5-min cron
impossible — Hobby allows once/day) strangle agent loops. IdeaConnect's
human-product needs and the Arena's autonomous needs pulled opposite ways,
so it spun out as its own project.

**The Oracle pivot that was debated and declined:** single ARM VM (Docker
builds, Nginx, SQLite/Postgres, possibly Ollama) + Vercel frontend via
Cloudflare Tunnel. Declined on verified constraints that still hold —
**with one correction from today's research:** the DOCX says 4 OCPU/24 GB
Always Free; Oracle's own docs
(`docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm`)
say Always Free A1 = **2 OCPU/12 GB** (4/24 is the paid-rate equivalent).
Plus 7-day idle reclaim (<20% CPU/net/mem), out-of-capacity realities
("might take several days"), no SLA. The critique's conclusion stands and
is now the project's standing rule: no VM (spec §2).

## 2. Managed-serverless alternatives (no VM, different vendors)

### A. Supabase all-in — $0 → $25/mo
Free: 500 MB DB, 5 GB egress, 500k edge-function invocations, 200 concurrent
realtime connections/2M messages; pgvector fully supported, no add-on
(`supabase.com/pricing`, `/docs/guides/database/extensions/pgvector`). Pro
$25/mo (+compute): 8 GB disk, 2M functions, 400 s wall / 2 s CPU-time per
request.
**Fit:** Postgres + vector + storage + realtime in one — the closest
single-vendor mirror. **Misfit:** 400 s wall + 2 s CPU/request forces
chunked/stepped agent loops; no 5-min cron on free semantics here either
(schedule via pg_cron/Tirmedge or external tick). Pick when you want one
dashboard and can live with stepped turns.

### B. Neon + Vercel (v1, refined) — $0 → ~$20/mo
Neon: Free 0.5 GB storage, 100 CU-h/mo, scale-to-zero, full pgvector + HNSW
(`neon.tech/pricing`, `neon.com/docs/extensions/pgvector`); pay-as-you-go
after ($0.106/CU-h Launch). Vercel: Hobby 300 s Fluid functions but
**once-per-day cron max** (`vercel.com/docs/cron-jobs`); 5-min ticks need
Pro $20/mo (+800 s functions).
**Fit:** best pure-Postgres (branching per event is genuinely useful:
branch-per-arena for experiments). **Misfit:** cron story forces Pro;
long turns need fan-out. This is v1 with the prices updated — choose it if
you already live on Vercel.

### C. AWS serverless — ~$0 → usage
Lambda: 1M req + 400k GB-s free, **15-min timeout**
(`aws.amazon.com/lambda/pricing`, limits docs) — the longest turn budget
of any serverless option here. EventBridge Scheduler: **14M invocations/mo
free** (`aws.amazon.com/eventbridge/pricing`) — the 5-min tick (~8.6k/mo)
is noise. Bedrock: Llama 3.3 70B $0.72/$0.72 per 1M
(`aws.amazon.com/bedrock/pricing`) — pay-per-token judging without daily
caps. DynamoDB free: 25 GB + 25 WCU/RCU.
**Fit:** longest turns + free cron + cap-free inference in one vendor.
**Misfit:** DynamoDB is KV, not pgvector — keep Postgres (RDS/Aurora/Neon)
if vector queries must stay SQL; highest console complexity of this list.

### D. Firebase/GCP — ~$0 → usage
Cloud Run: 2M req + 180k vCPU-s free, **timeout to 60 min**, concurrency
1000/instance (`cloud.google.com/run/pricing`, configuring docs) — the best
cron-loop host here (Jobs or min-instance service). Firestore free:
1 GiB, 50k reads/20k writes per day, KNN vector add-on billed per batch
(`firebase.google.com/pricing`). Vertex: Gemini Flash-class ~$0.75/$3.75
per 1M promo through 2026 (`cloud.google.com/vertex-ai/.../pricing`).
**Fit:** long-loop hosting + Google-model inference. **Misfit:** NoSQL core;
pgvector needs AlloyDB/Cloud SQL (~$9+/mo starter) or an external Postgres.

### E. Turso (edge SQLite) — $0 → $5/mo
Free: 5 GB storage, 500M rows-read/mo; native vector (`vector_distance_cos`,
DiskANN `vector_top_k`) — no extension (`turso.tech/pricing`,
`docs.turso.tech/features/ai-and-embeddings`).
**Fit:** D1-style read-heavy + 10k embeddings co-located at the edge.
**Misfit:** not pgvector wire-compatible (`vector_top_k` + SQLite
semantics) — a rewrite, not a swap, for Postgres tooling.

## 3. Self-hosted / VM paths (you operate it)

### F. Single VPS (Hetzner-class) + Docker Compose — ~€5–15/mo + ops
4 vCPU/8 GB NVMe cloud boxes (CX33/CAX21/CPX32 lines) with 20 TB EU traffic
included (`hetzner.com/cloud/*`, traffic docs; € figures are JS-rendered —
verify live, not from memory). One box runs Postgres + pgvector, the tick
loop (systemd/cron), object storage via local disk or R2-style S3, Caddy
for TLS, and Docker builders side by side.
**Fit:** everything in one place, predictable bill, no duration walls, real
browsers/builds trivially. **Misfit:** you are the on-call (backups,
patching, disk-full at 3 AM); idle capacity still bills; single point of
failure unless you run two boxes. Choose when $10/mo beats ops-aversion.

### G. Oracle Always Free — $0 + ops + risk
Corrected reality (see §1): 2 OCPU/12 GB ARM + 2× x86 micros (1 GB each),
200 GB block total, 10 TB outbound, 7-day idle reclaim, no SLA, frequent
out-of-capacity on free shapes
(`oracle.com/cloud/free`, `/faq/`).
**Fit:** Postgres + tick + small Docker cache if kept warm. **Misfit:** sole
build fleet (12 GB total), reclaim risk during quiet phases, no support.
The DOCX's 24 GB figure was wrong — size for 12 GB or don't use it.

### H. Kubernetes (k3s) — only past real scale
Nothing in this workload needs K8s (single-digit GBs, 2 concurrent builds).
Listed so it can be dismissed on record: orchestration overhead for an
orchestrator that cron + queue already provide.

## 4. Inference alternatives (any stack above can use these)

- **Pay-as-you-go APIs:** Groq Developer (~10× free limits, Batch −50%:
  `console.groq.com/docs/*`); Together ($0.05–9/1M, $5 signup credit:
  `together.ai/pricing`); Cerebras (trial $5/30d, then $0.10–1.20/1M:
  `cerebras.ai/pricing`, `inference-docs.cerebras.ai/support/rate-limits`);
  OpenRouter gateway (26 free models at 20 RPM/200/day + 5.5% fee:
  `openrouter.ai/pricing`); HuggingFace Serverless (few-hundred req/hr,
  <10B params: `huggingface.co/pricing`); Mistral La Plateforme
  (Small/Nemo free tier, Large $2/$6: `mistral.ai/pricing`). Full 2026
  comparison with worked Arena costs: `docs/AI_BUDGET_RESEARCH_2026-08-31.md`,
  `docs/AI_PROVIDERS_DEEP_DIVE_2026-08-31.md`.
- **Self-hosted:** Ollama 8B ≈ 5–8 GB (fits 8–12 GB VRAM/RAM), 70B ≈ 43 GB
  disk → 48 GB+ VRAM (`ollama.com/library/llama3.1`, `docs.ollama.com/gpu`);
  vLLM needs NVIDIA 7.5+ compute, 2+N cores (`docs.vllm.ai`); rentals —
  RTX 4090 $0.34–0.74/hr, A100-80G $1.59/hr, H100 $2.89/hr (RunPod pricing,
  updated 2026-09-13). Rule of thumb: self-host 8B for dev/test, buy API
  for 70B judging unless utilization is sustained — a 400-call event cannot
  amortize an H100.
- **What not to repeat:** pooled personal free tiers as backend (the
  OmniRoute lesson) — one exhausted key must never silently cap an event.
  Whatever provider you pick, record per-call provenance
  (`provider_usage_log` pattern) and pin judging models per event.

## 5. Build-execution alternatives (the hackathon half)

| Option | 100 turns/mo sketch | Egress control | Verdict |
|---|---|---|---|
| GitHub Actions, public repo, standard 2-core | **$0** (free) | hosts-file only | Current choice; 6 h/job cap; larger+VNET if you need real firewalling (`docs.github.com/en/billing/.../actions-runner-pricing`) |
| Self-hosted runners | $0 + your VM | yours (subnet/firewall) | Cheapest private-repo path **iff** you build JIT + clean-VM-per-job yourself; GitHub's own docs warn against it for untrusted code without that |
| Modal Sandboxes | ~$4 (in $30 free tier) | CIDR + domain allowlist + block-all, per-second billing (`modal.com/pricing`, `/docs/guide/sandbox-networking`) | Finest egress policy of the list; watch the 5-min default sandbox lifetime |
| Daytona | ~$2.8 (in $200 grant) | CIDR/domain/proxy, tier-gated (`daytona.io/pricing`, `/docs/en/network-limits`) | Most agent-native API; managed free grant is generous |
| Fly Machines | ~$0.50 | static egress IP + own proxy | Cheapest API-driven micro-VM, but you build image caching, cleanup, firewall, browser harness yourself |
| E2B | ~$0.11/hr pace, $100 trial credits | allow/deny outbound, `e2b.dev/pricing` | Purpose-built for untrusted code; 1-hr Hobby cap, no GPUs |
| Coolify/Dokku on VPS | flat VPS | VPS firewall | Preview-deploy target (`git push` → URL), **not** a per-turn sandbox |

Notes: Daytona's open-source self-host path froze June 2026 (AGPL) — pin or pay.
Modal's 5-min default sandbox lifetime must be raised explicitly for 120-min
turns. GitHub larger runners are never free, even on public repos.

## 6. Decision matrix (honest version)

| Priority | Pick | Why |
|---|---|---|
| Stay $0 forever, no ops | Current (Cloudflare + Groq + Actions) | Only stack here with $0 at every layer and no duration walls on the hot paths |
| One dashboard, $25 OK | Supabase | Postgres+vector+storage+realtime unified; accept stepped turns |
| Longest serverless turns | AWS (Lambda 15 min + EventBridge) or GCP (Cloud Run 60 min) | Pay per use, keep Postgres elsewhere for vectors |
| One box, predictable € | Hetzner + Compose + Coolify previews | No walls at all; you own failures |
| Cheapest per-turn sandbox | Fly Machines ($0.50/100 turns) or Daytona grant | Only if you outgrow Actions or need finer egress than hosts-file |
| Never | Pooled free-tier aggregators as primary; K8s at this scale; local 70B on CPU against a 5-min tick | Each already failed or provably can't fit |

## 7. What transfers unchanged to any stack

The portable parts (steal these regardless of vendor): queue-with-claims +
idempotency anchors per item; judging-model pin recorded per score row;
per-call provider usage log against caps; phase-gated scheduler with
predictive pause instead of retry-burn; build-turn verify-behind-commit
(commit work first, flip conclusion after); stall watchdog + revival
distinction (day-gated waits are not stalls); evidence-backed UI (rationale
+ provenance visible, not just scores). These are in `src/events/`,
`src/judges/`, `src/router.ts` — the vendor-specific code is a thin shell
around them.
