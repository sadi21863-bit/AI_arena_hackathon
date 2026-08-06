# Kaggriculture — study (competition, environment, agent patterns)

> **STATUS 2026-08-06 — research only, no code.** Written on the
> `office-deep-analysis` branch as part of the Office deep analysis. Sources:
> official competition page (kaggle.com/competitions/kaggriculture), the
> authoritative environment spec in
> `github.com/Kaggle/kaggle-environments/.../envs/kaggriculture/README.md`,
> and public community agent repositories.

## 1. What it is

Kaggriculture is Kaggle's **Featured Simulation Competition** (hosted by
Kaggle — Bovard Doerschuk-Tiberi, Domino Weir, María Cruz), live Jul 30 →
Sep 30 2026, $50,000 prize pool, ~2,500 participants / ~4,400 submissions
within the first week. It grew out of the Google × Kaggle "5-Day AI Agents
Intensive: Vibe Coding" capstone.

The deliverable is an **autonomous agent** (`main.py` with an `agent`
function), not a trained model: a two-player, turn-based farming simulation.
30 in-game days × 24 turns/day = **720 turns**; whoever has the most coins
banked at the end of the season wins. Both players farm in parallel on their
own 10×10 farms and sell into a **shared dynamic market**.

## 2. The environment

### 2.1 Objects

| Object | Type | Seed cost | Base price | Time to first yield | Time to max yield | Subsequent yields | Max yield | Action cost | Yield/tile/day |
|---|---|---|---|---|---|---|---|---|---|
| Wheat | one-time | 10 | 25 | 2d | 4d | none | 6 (4 unfert.) | 1 | 0.80 |
| Carrot | one-time | 20 | 35 | 2d | 3d | none | 4 (3 unfert.) | 1 | 0.75 |
| Tomato | ongoing | 50 | 60 | 8d | 11d | every day ×4 | 4 | 1 | 0.33 |
| Strawberry | ongoing | 100 | 120 | 10d | 16d | every other day ×4 | 4 | 1 | 0.24 |
| Melon | one-time | 80 | 250 | 10d | 10d | none | 6 | 1 | 0.55 |
| Goose/Egg | ongoing | 300 | 50 | 4d | — | daily, indefinite | 4 held | 1+1 (coop) | 1.00 |
| Cow/Milk | ongoing | 400 | 160 | 8d | — | every 2d | 6 held | 1+1 (pasture) | 0.50 |
| Sheep/Wool | ongoing | 500 | 200 | 6d | — | every 3d | 6 held | 1+1 (pasture) | 0.33 |
| Fertilizer | — | 100 | 100 | — | — | 1/day per animal | — | — | — |

- Crops must be watered daily; **two unwatered days → weed**. A fresh seed
  starts at `consecutive_unwatered = 1` (planting day counts as missed) —
  no grace period.
- Animals must be fed wheat daily; **two unfed days → escape** (unrecoverable).
  `CARE` banks a bonus applied on the animal's next scheduled production
  (basic needs first: no feed → no bonus banked).
- Fertilizer doubles the per-day yield bonus for 3 days (crops); each
  surviving animal produces 1 fertilizer at end of day (does not accumulate).
- Ongoing crops are capped at 4 scheduled productions, then decay to weed.
- Shed at board center (capacity 100, seeds excluded; overflow discarded).
  Farmer + hands spawn at shed daily and drop inventory at end of day.
- Land: 10×10 board, four 5×5 quadrants; NW free, others cost $1k/$2k/$4k.
  Locked tiles are passable but not buildable.
- Hands: `HIRE` is a market order, cost `fib(n)` per hire per day
  (1,1,2,3,5,8,13,…), reset daily.
- Weeds spawn at 0.5%/empty-tile/day.

### 2.2 Market & price function

- Seeds/animals: unlimited supply at fixed prices. `BUY_PRODUCT` only buys
  WHEAT and FERTILIZER; `SELL` anything. Orders (max 10/turn) process
  **concurrently one unit at a time** across both players; buy price quoted
  post-buy, sell price pre-sell (immediate buy→sell nets zero).
- Price: `price(inv) = base + sign · amp · f(|inv − I0|)`, `I0 = 10,000`,
  `T` = one 5×5 field's 24-day production (animals −30% for feed overhead);
  per-resource shape functions and targets make the sides asymmetric:
  wheat panics on scarcity but absorbs gluts; carrot the opposite; melon/wool
  barely react to scarcity but crash hard on overproduction. Premium goods
  (base > $100) have `above_target > 1` → gluts drive them straight to the
  $1 floor: bundling and sale timing matter more than for staples.
  Per-resource overrides injectable via `marketParams` in config.

| Resource | Base | I0 | T | Below f/t | Above f/t | P(I0−T) | P(I0+T) | P(I0+2T) |
|---|---|---|---|---|---|---|---|---|
| Wheat | 25 | 10k | 400 | sqrt/0.80 | log/0.20 | $45 | $20 | $19 |
| Carrot | 35 | 10k | 450 | log/0.20 | sqrt/0.70 | $42 | $10 | $1 |
| Tomato | 60 | 10k | 200 | linear/0.40 | sqrt/0.60 | $84 | $24 | $9 |
| Strawberry | 120 | 10k | 100 | sqrt/0.70 | linear/1.60 | $204 | $1 | $1 |
| Melon | 250 | 10k | 300 | log/0.20 | sq/3.60 | $300 | $1 | $1 |
| Egg | 50 | 10k | 332 | linear/0.40 | log/0.20 | $70 | $40 | $39 |
| Milk | 160 | 10k | 122 | sqrt/0.60 | linear/1.60 | $256 | $1 | $1 |
| Wool | 200 | 10k | 105 | log/0.20 | sq/3.20 | $240 | $1 | $1 |
| Fertilizer | 100 | 10k | 200 | linear/0.40 | linear/0.40 | $140 | $60 | $20 |

### 2.3 Town demand

Shops unlock every 3 days (random order, then permanent): Bakery
(eggs+wheat), Pizza Shop (milk+tomatoes+wheat), Brunch Spot (eggs+wheat+
strawberries), Yarn Store (wool ×2), Ice Cream Shop (strawberries+milk+
wheat), Pet Cafe (carrots ×2), Smoothie Shop (strawberries+milk), Farmers
Market (wheat+carrots+tomatoes+strawberries). Each consumes its demands every
4 turns; town center consumes 1 of everything (2× after day 10, 4× after
day 20) every 12 turns. Demand only ever grows.

### 2.4 Turn order

1. Action validation → 2. player actions (simultaneous) → 3. market queue →
4. town consumption → 5. observation update (day refresh, market refresh,
income update, farm update).

### 2.5 Observation / action API

```
obs: player, day, hour,
     farms[2]   — public: money, tiles[y][x] (None|"LOCKED"|plant|weed|coop/pasture),
                  farmer pos, hands, unlocked_quadrants, hires_today
     market     — shared: inventory, prices
     town       — shared: unlocked_shops
     private    — shed, seeds, inventories[farmer, hands…]
action: {"farmer": [MOVE|PLANT|WATER|FERTILIZE|HARVEST|FEED|CARE|COLLECT_FERTILIZER|
                    BUILD_COOP|BUILD_PASTURE|DIG|PICKUP|DROP|PLACE|PASS, …],
         "hands": [same…], "market": [["BUY_SEED","WHEAT",1], ["SELL","WHEAT",5],
                    ["HIRE"], ["BUY_LAND","SE"], ["BUY_PRODUCT",…], …]}
```

One action per unit per turn; up to 10 market orders; PASS is the default.

## 3. Tooling (the observability model)

- `pip install -U kaggle-environments`; `make("kaggriculture",
  configuration={"episodeSteps": 720})`; built-in opponents `pass`,
  `random`, `starter`; run locally or head-to-head via
  `env.run(["main.py", "random"])`.
- **Every episode is fully reproducible and replayable**: `env.toJSON()`
  dumps the complete replay; `env.render(mode="ipython")` or the bundled
  HTML **visualizer** (`envs/kaggriculture/visualizer/{default,playable}/` —
  a replay renderer and a playable browser game) replay it. The competition
  CLI exposes the same artifacts at scale: `kaggle competitions replay
  <episode_id>` (replay JSON) and `kaggle competitions logs <episode_id> <i>`
  (per-agent logs). Deterministic episodes via a `seed` config knob.
- Submission contract: `main.py` with an `agent` function, single file or
  tar.gz; the platform then runs episodes continuously (agent vs agent on
  the live leaderboard) — the same head-to-head runtime that built-in
  agents use locally.

## 4. Community agent patterns (studied: aral3000, Seyamalam,
   COK-ZhangZiliang, jcdumlao14, deepeshumrao)

- **Economy layer**: invert the documented price functions per resource,
  compute per-tile-per-day ROI with remaining-season horizon (melons late,
  ongoing crops early), schedule sales around town unlock days and glut
  collapse of premium goods.
- **Planner layer**: explicit multi-agent scheduling — main farmer for
  high-cost actions, hired hands for water/feed/care loops; inventory
  capacity (shed 100) and HIRE fib-cost planning per day.
- **Pathfinding layer**: BFS on the 10×10, treat movement as the scarce
  resource (24 turns/day); hands spawned on locked tiles still passable.
- **Local tournament loop**: `simulator.py` vs built-ins, `run_local_
  tournament.py`, `run_evolutionary_loop.py` (parameter evolution over
  local matches), replay/log analysis scripts, then submit and watch
  episodes — i.e., the same verify-locally-then-live cycle the Arena's
  build-turns gate enforces for its teams.
- The strongest community repos all commit episode replays and agent logs
  as artifacts for debugging — replay-as-debugging is the norm here.

## 5. Relevance to the Arena and the Agent Office

- **Replay-first observability is the G7 reference model.** Every
  Kaggriculture episode yields (a) a full per-step state snapshot
  (observations for both players — the farm, market, town), (b) per-agent
  action logs, (c) a deterministic seed. The Office's G7 (journal-backed
  replay) and Replay view would be the Arena analogue: the arena's closest
  existing rows are `event_queue` (actions) + `archive_interactions`
  (timeline) + `event_chronicle` (narratives, currently **empty in prod**)
  — but nothing snapshots event state per tick. Kaggriculture's model
  suggests an append-only journal of `(event_id, tick, action, resulting
  state-delta)` is the right shape, with replay being a pure projection.
- **The visualizer pattern applies directly.** `visualizer/default` +
  `visualizer/playable` (replay renderer + playable game) is exactly the
  split the observatory's Replay view wants: render a stored episode, and
  optionally let a human "drive" a position. A Kaggriculture-style episode
  view (10×10 tile farm, crops/animals, market prices, town unlocks) is a
  concrete, spec-documented candidate for what a rich replay renderer looks
  like.
- **Arena hackathon theme candidate.** The arena runs agent hackathons via
  GitHub Actions build turns. Kaggriculture is a live, spec-complete,
  head-to-head agent competition with a $50k prize and 2 months to run —
  a natural real-world theme for a future arena hackathon event ("build an
  agent for Kaggriculture"), where the office would then show farm episodes,
  match results, and leaderboard movement instead of (or alongside) the
  build-turn room.
- **Asset angle (with project-chimera).** If the office or a future
  farm-sim view renders Kaggriculture episodes, the chimera pixel assets
  (8 characters with 4-direction walk + idle animations, floor tiles,
  interior sets, campus backdrop — see OFFICE_ASSET_CATALOG) fit the
  32×32 tile size the sim uses; Kaggle's own visualizer is HTML/JS and
  could be borrowed from directly under its MIT-licensed repo.
- **Not a data/ML competition.** No dataset to download or model to train;
  the "data" is the environment itself (`kaggle competitions download
  kaggriculture` ships the starter kit + rules). Budget/GPU concerns do not
  apply; the arena's existing inference budget rules would.

## Sources
- https://www.kaggle.com/competitions/kaggriculture (overview, getting-started, rules)
- https://github.com/Kaggle/kaggle-environments/tree/master/kaggle_environments/envs/kaggriculture (README spec, kaggriculture.py, visualizer/)
- Community: github.com/aral3000/kaggriculture-ai-agent, Seyamalam/Kaggriculture,
  COK-ZhangZiliang/Kaggriculture, jcdumlao14/Kaggriculture-AI-Agent,
  deepeshumrao/kaggriculture-agent
