# The Arena — build tree

Scaffold for **The Arena** (see `The_Arena_Specification.docx` — keep it next
to this repo, it's the source of truth for every decision below).

## Architecture in one paragraph

Two layers, no VM anywhere. Cloudflare (Workers, Pages, D1, R2, Vectorize,
Workers AI) handles everything always-on: frontend, API, database, archive,
and the inference router. GitHub Actions runs hackathon build turns as
ephemeral, isolated jobs. Inference is pooled across two no-card providers —
Groq primary, Cloudflare Workers AI fallback — with load split between them
directly inside the Cloudflare Worker.

## Before you touch Week 1

Two gates, per `.arena/state.json`:

1. **`inference_pool`** — does Groq's published free tier actually hold up on
   a real account for judging/architecture-shaped prompts?
2. **`build_pipeline`** — does the GitHub Actions build-turn workflow actually
   complete successfully end to end?

Both are cheap to check (minutes) — see `week0-spike/README.md`.

## Layout

```
the-arena/
├── CLAUDE.md                        # the build loop — Claude Code reads this automatically
├── .arena/state.json                # loop state: gates, pass/fail, measured numbers
├── scripts/                         # gate checkers
├── week0-spike/                     # run this first
├── .github/workflows/
│   └── team-build-turn.yml          # runs one hackathon build turn per trigger — spec §8
├── docker/
│   └── Dockerfile.arena-team-base   # binary whitelist for the build-turn container
├── src/
│   ├── router.ts                    # inference routing: Groq -> Workers AI
│   └── index.ts                     # Worker entry point (Week 1 stub)
├── db/
│   └── schema.sql                   # D1 schema
├── wrangler.toml
└── package.json
```

## How this hands off to Claude Code

Open this folder in Claude Code; it reads `CLAUDE.md` automatically and
checks `.arena/state.json` before doing anything. No prompt to paste — the
loop persists in the repo itself, across sessions and gaps.
