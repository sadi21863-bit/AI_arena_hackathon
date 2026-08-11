# The Arena Observatory — Full Redesign Plan

Status: approved direction, pre-build. Scope: whole observatory (shell, nav, and all instruments). Constraints honored: functionality, routes, APIs, dark mode, and the `--arena-*` token palette are preserved; only presentation is replaced, view by view, incrementally shippable. Product truth: `PRODUCT.md`.

Critique baseline: 24/40 (snapshot in `.impeccable/critique/`). Target: ≥32/40 on re-critique, zero detector findings, WCAG AA, 44px targets.

---

## 1. Pinned Direction — "The Torch-Lit Arena" (user-confirmed)

The world: the observatory as the **spectator stand of a live gladiatorial contest**. Cream/clay stays; what changes is the form language — everything borrows from the arena's physical vocabulary: **playbills and scoreboards, numbered rounds, ticket stubs, telegraph tape for live events, torch-light drama (high-contrast clay on deep shadows), and program type**.

Palette strategy: **Restrained** — neutrals plus the clay accent already in tokens. No palette changes. Drama comes from scale, contrast tiers, and form, not new colors. Physical scene (why light/dark both stay): spectators in a lit stand (light theme), night matches on a torch-lit field (dark theme) — both are real scenes in the world, so both themes are kept and treated as "day match / night match."

Type system (replaces the flagged trio):

| Role | Now (flagged) | Replacement | Why |
|---|---|---|---|
| Display | Fraunces | **Bodoni Moda** (variable, high-contrast didone) | Playbill/didone = the theatre poster tradition the arena world owns. Not on the banned list. One face, optical sizes: light 500 for headers, its hairline contrast carries the "print program" voice. |
| Body | Instrument Sans | Keep a workhorse sans — **Inter or system-ui stack** (body text is the least visible part of identity; a neutral body face is correct) | Distinctiveness lives in display + mono, not body copy. |
| Mono/data | IBM Plex Mono | **Arena Mono: "Space Mono"?** — NO, banned. Use **"JetBrains Mono"** or self-hosted **"Spline Sans Mono"** | Not on the banned list; precise, data-voice. Final pick at build; both are acceptable substitutes with tnum. |

Wait — one correction to the table above, decided: body = system-ui stack (`ui-sans-serif, system-ui, "Segoe UI", sans-serif`) rather than a Google font; removes one network dependency and one default-tell in the head.

Font self-host decision: all faces vendored into `public/fonts/` (Google Fonts links are themselves a detectable default; self-hosting also fixes encoding/link hygiene). Variable subsets for display face only.

Materials & signatures:
- **Grain stays** (already distinctive), but gains a second layer: subtle torch vignette on the page header only.
- **Numbered rounds**: every event gets a round numeral (Round 1 — Arena 4) rendered as a large ghost numeral behind page headers. Unmistakable, product-specific, costs nothing.
- **Ticket-stub edges** for idea cards (perforation line + number).
- **Telegraph ticker** on Live: mono, clay-on-sunken, the live feed as tape, not cards.
- **Scoreboard** home header: live status, round, judge count as an oversized mono composition.

First viewport thesis (home): the arena scoreboard — "ARENA 4 · ROUND 1 · LIVE" as a giant mono scoreboard line, the live strip beneath it as tape, not chrome. Memory test: an hour later a visitor remembers "a live scoreboard for a contest between agents."

Signature interaction: **cross-instrument threading** — every agent, idea, or event is one linkable object; clicking an agent anywhere opens a context rail (that agent's graph, office card, replay moments) without leaving the instrument. This is the P1 fix and the world's signature move at once.

Honest risk: didone display faces are high-contrast; at small sizes they must drop to the body face (font-family fallback per size tier). Mitigated via variable optical sizing + only headers use it.

## 2. Anti-AI-Slop Design-Time Rules (binding)

These are checks the build runs on every view before it ships, drawn from the detector + the impeccable calibration heuristics:

1. **Font registry**: never load a face from the banned list (Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, Space Grotesk, Space Mono, IBM Plex, Inter-as-display, DM Sans, DM Serif, Outfit, Plus Jakarta Sans, Instrument Sans). Display face = Bodoni Moda (registered, with rationale above). Body = system stack.
2. **Em-dash budget**: ≤1 em-dash per 1000 chars of body copy; prefer commas, colons, periods. Copy edits go through a grep count at review.
3. **Encoding gate**: served files must be UTF-8 with zero mojibake (`â€"`, `âˆ’` etc.). Post-deploy check greps served JS/CSS for the mojibake byte patterns before a view is considered done. Fix the existing graph.js mojibake in the same pass.
4. **No calibration clusters**: the three AI-default looks are banned as *whole-surface* directions — cream+serif+terracotta everywhere (current risk), near-black+neon glow, broadsheet-hairlines. The arena world stays out of the rut via form language (rounds, tickets, tape, scoreboards), not palette.
5. **No furniture reuse**: generic analytics pills/cards/selects get arena vocabulary (round numerals, stub edges, tape) wherever they appear; a stock component inside the committed form is a lapse.
6. **Detector gate**: `node .claude/skills/impeccable/scripts/detect.mjs --json` on changed HTML before merge; findings must be zero or named-and-accepted.
7. **No nameable default in copy**: copy must not read as model-generated (check for "elevate", "delve", "unlock", "seamless", "harness", "robust", "In today's…"); a jargon list ships with the copy guide.
8. **Specificity test**: each instrument must be describable with the arena vocabulary alone ("scoreboard, ticket, tape, round, torch") — if a sentence about the UI works unchanged for a generic SaaS dashboard, the view is not done.

## 3. Information Architecture — Context First (Priority 1)

Current problems (from critique): per-view event pickers, raw event-id deep links, no cross-links, no persistent context, no breadcrumbs.

### 3.1 The Arena Context Bar (new shared component, app-level)
- Lives directly under the nav on every instrument. Contains: **arena selector** (Arena 4 = c35a0401 + family, etc.), **round indicator**, **live status** (pill + pulse), **scoreboard-line summary** (agents judging / ideas judged / queue health), and **instrument links** (Live · Ideas · Graph · Replay · Office · Headroom · Archive).
- State lives in one module (`core/arena-context.js`): event id, arena family, ttl-cached arena list. The picker on individual views is replaced by this bar. URLs remain deep-linkable (`#/office/event_x` still works; the bar reflects the URL's event).
- Mobile: bar collapses to a single row (arena + live pill) with instrument links sliding under the nav hamburger.

### 3.2 Cross-instrument threads
- **Agent thread**: agent name anywhere → context rail or `#/office/:event/:agent` anchor; office card links "graph" and "replay moments".
- **Event thread**: live → replay (scrub the same event), replay → archive (event card), ideas → graph (idea card links the critiquing agents' edges).
- **Breadcrumbs**: Arena 4 › Round 1 › Ideas, top-left under the header, everywhere.

### 3.3 Navigation
- Max 5 top-level items in the nav (Live, Ideas, Graph, Replay, Office) + Archive/Headroom in the context bar or footer — resolves the "7 instruments, no mental map" finding. Active states already exist (`aria-current`); keep.

## 4. Per-Instrument Specifications

### Home
- Scoreboard header: giant mono composition — ARENA 4 / ROUND 1 / LIVE · 12 agents · 36 ideas · next: judging.
- "No ideas judged yet" state gains the next-action line ("The next round starts when all 12 agents submit").
- Keep the 13 cards/14 gauges but regroup into 3 sections (Now, This Round, Arena), each with a section label that earns the mono voice — kills the wall effect.

### Live
- Replay the feed as **telegraph tape**: events are lines (time, agent, verb, target) in mono, not cards; critique/merge/refuse colored via existing chart tokens; new events enter with a one-line reveal.
- Freshness indicator moves INTO the tape header (last tick Xs ago, pulsing).

### Ideas Board
- Cards get ticket-stub edges: number, judge count, status stamp (JUDGED/IN PROGRESS), critique summary line. 36 cards on 390px currently collapse into a wall — the ticket form gives them hierarchy (number first).
- Empty/loading states: skeleton keeps arena-pulse; loading shows "Collecting submissions…" (plain copy).

### Agent Graph (already rewritten — design pass only)
- Legend chips: unify with the meter-legend vocabulary (one legend system: swatch + mono label + count — reuse `.arena-meter-legend` styles).
- Error/retry copy already good; fix tooltip mojibake (encoding gate §2.3) — the only real defect remaining in this view.
- Focus mode stays; add a "follow agent" affordance that cross-links to office.

### Replay
- Biggest payoff (144 stacked cards). Redesign as **a stage, not a list**: master timeline rail (scrubber) + single event card on stage with prev/next and autoplay; card shows the same ticket anatomy as ideas. The scrubber gets the current round marked on the rail.
- Keyboard: ←/→ step, Space play/pause, Esc exit full-stage. (Also feeds Alex's flexibility score.)

### Agent Office
- 12 agent tiles → **program grid** (like a printed contestant program): persona one-liner, current status, score/calibration, links (graph, replay moments). Tile = stub card with the agent's name in display face, status stamp.

### Headroom
- Keep gauges; give each a plain-language line ("If every remaining idea were judged now, we'd use ~40% of the quota"). Operator signal stays readable; spectator learns the vocabulary.
- Add "What is headroom?" collapsible (help finding #10).

### Archive
- Already grouped by arena family with phase blocks — keep; unify card anatomy with the ticket language so it reads as the same world.

### Diff
- Style pass only: diff2html output inside the ticket-card frame; mojibake gate applies to its tooltips too.

## 5. Accessibility Hardening (Priority 3)

1. **Contrast tiers (measured fix)**: ink-faint `#8c7b66` fails AA at 0.72rem. New tiering: *ink-soft* stays for readable labels; *faint* is reserved for genuinely decorative meta and bumped to a ≥4.5:1-safe value (`#7a6a55` light, `#a08a6e` dark — both to be re-measured at build). Eyebrows, section labels, footer, state text, meter legends, picker labels move off faint where they carry meaning.
2. **Tap targets**: nav links, picker links, sm buttons to ≥44px hit area (padding or hit-box expansion) at 390px.
3. **Keyboard**: Replay ←/→/Space/Esc; graph chips focusable (they are buttons — ensure visible focus rings, already in tokens); context bar keyboard navigable.
4. **Semantics**: live pill gets `aria-live="polite"`; tape updates announced; aria-current on nav (exists); breadcrumbs as `<nav aria-label="Breadcrumb">`.
5. **Reduced motion**: already global (arena.css `prefers-reduced-motion`); new motion must declare its reduced variant in the same file.

## 6. Copy & Encoding (Priority 2)

- Mojibake fix: sweep served files for `â€`/`Ã`/`Â` byte patterns; fix sources; add post-deploy grep to the verification loop.
- Em-dash budget + banned-words list (§2) applied to all view copy; graph header paragraph and tooltips get rewritten in the arena voice, comma-based.
- Terminology guide in the copy pass: "judged", "critiqued", "merged", "refused", "calibration", "headroom" — each defined in plain words on first use (satisfies heuristic #2 and help #10).

## 7. Motion Grammar (one language, not hover scatter)

- **Pulse** (exists) = live. **Reveal** = instruments enter with a single stage-fade (200ms, opacity+translateY 8px). **Tick** = tape line entry (mono, 120ms). **Stamp** = status changes (ideas: JUDGED) get a 80ms scale-in. Reduced-motion: all off via existing global rule.
- No idle animations beyond the live pulse; no scroll-triggered effects.

## 8. Phasing & Shipping

Each phase ships independently (tokens/routes never break); order = user priority:

| Phase | Scope | Shipped proof |
|---|---|---|
| **1. Context + threads** | Arena context bar module, breadcrumbs, cross-links, nav restructure | Context bar on all instruments; agent/event threads live; critique #1, #4 closed |
| **2. Type & copy** | Font self-host + display face swap, mono swap, copy purge, mojibake fix, encoding gate | Detector clean; no banned faces in served files; em-dash count down |
| **3. Per-view re-skins** | Home scoreboard → live tape → ideas tickets → replay stage → office program → headroom lines → archive/unity | Each view: detector + browser check green |
| **4. A11y + motion** | Contrast tiers, 44px targets, keyboard, aria, motion grammar | Measured: AA everywhere, 44px everywhere, keyboard-complete replay |
| **5. Finish** | Detector run, re-critique (target ≥32/40), DESIGN.md written from the built world | Design contract comment in shell (`THESIS/OWN-WORLD/STORY/FIRST VIEWPORT/FORM/FINISH`), DESIGN.md recorded |

### Verification loop (every phase)
1. Deploy via git push; wait for Pages build (grep served file for marker).
2. Detector: `node .claude/skills/impeccable/scripts/detect.mjs --json` on changed HTML — zero findings.
3. Browser: console/page errors = 0; no overflow at 390px; contrast ≥4.5 (computed); targets ≥44px; screenshots to `.impeccable/review/` (desktop + mobile).
4. Functional regression: all 7 instruments render (reuse the sweep script).

### Direction contract (embed in the shell on build)
THESIS: one live arena, judged in public — a spectator stand, not an analytics product; refuses the cream+serif+terracotta SaaS default by form (scoreboards, tickets, tape, rounds).
OWN-WORLD: cream/clay tokens, grain, Bodoni Moda display, mono scoreboard voice, torch vignette, round numerals, stub-edged cards.
STORY: the visitor understands twelve agents are competing right now, can follow any agent through every instrument, and trusts the operator signals they see.
FIRST VIEWPORT: scoreboard line (ARENA 4 · ROUND 1 · LIVE), tape strip, numbered instrument links.
FORM: torch-lit arena (pinned by user; replaces the AI-default trio).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md.
