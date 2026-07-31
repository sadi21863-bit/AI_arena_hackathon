# Agent Office — room size, per-stage environments, team split

Design proposal. Nothing built. Follows `docs/OFFICE_INVESTIGATION_2026-07-31.md`
(P1–P3 shipped) and covers three asks: the room is too small for twelve agents,
each Arena stage should have its own environment, and agents should split up
with their team once teams form.

---

## 1. The room is too small — measured, not felt

Current geometry: room is `width:100%; aspect-ratio:16/9; min-height:440px`,
characters are fixed `64×64px`, and a zone lays its occupants out in rows of up
to 4 with an **11% horizontal pitch**.

Measured live at a 573px-wide room:

| | value |
|---|---|
| Row pitch (11% of 573px) | **63px** |
| Character width | **64px** |
| Result | adjacent characters **overlap** |
| Name label width (`nowrap` + padding) | ~90px → overlaps badly |
| A 4-wide row | ~253px |
| Gap between Research (17%) and Idea (50%) zone centres | **189px** |
| Result | **neighbouring zones' rows collide** |

The layout constants assume a much wider room than it usually gets. For the
current 11% pitch to clear the name labels you need roughly **820px of room
width** — a desktop-only assumption. Note also that at 573px the `min-height:
440px` beats the `16/9` ratio, so the room silently stops being 16:9 exactly
when it's most cramped.

**Why "just expand the room" doesn't fix it.** The room is already
`width: 100%` — it's as wide as its column allows. Widening means breaking out
of the page container, which buys maybe 200px and still fails on a laptop. The
real defect is that a **fixed pixel** character is placed on a **percentage**
grid, so density changes with viewport instead of staying constant. That's the
same class of bug as the sprite wall-clamp and the P3 bubble clamp: pixels
measured against percentages.

So the fix is three things, in order: **scale characters with the room**, **give
each phase a layout sized for the agents actually active in it**, and **split
into rooms when the cast splits**. The last two are your ideas, and they're the
right ones — they reduce simultaneous occupancy, which is the only thing that
genuinely buys space.

---

## 2. Research

**Crowding** ([Player Research](https://www.playerresearch.com/learn/perceiving-without-looking-designing-huds-for-peripheral-vision/)):
objects close together become unrecognisable in peripheral vision, and the
effect worsens the closer the spacing. Twelve overlapping characters with
overlapping labels is a textbook case — you can't identify anyone without
looking directly at them, which defeats an at-a-glance view.

**Zoning** ([RimWorld colony design](https://rimworldwiki.com/wiki/Colony_Building_Guide)):
frequently-used rooms belong central, occasional rooms at the edges, and
adjacency should follow the actual workflow. The current room does the
opposite in one place — Break Area sits centre-bottom, giving the *least*
interesting state the most visual weight.

**Prior art** (from the earlier investigation): [AI Town](https://github.com/a16z-infra/ai-town)
keeps a journal of every event as its backing store; [rafapetter/agent-town](https://github.com/rafapetter/agent-town)
uses themed environments per activity; [geezerrrr/agent-town](https://github.com/geezerrrr/agent-town)
has idle workers roam and return to their seat before real work.

**Project Chimera** (`~/Desktop/project-chimera`) is the strongest reference
because it's yours and it already solved the harder version:

- `autoload/location_manager.gd` — a `LOCATIONS` dictionary mapping id →
  scene, with travel between them. **This is exactly the per-stage environment
  pattern**, already designed and working.
- `tools/build_room_walls.gd` — rooms are 1280×720 with a 40px wall inset, and
  the layouts are built *procedurally by tool scripts*, not hand-placed.
- NPCs pathfind to room markers on schedule changes over a
  `NavigationRegion2D` floor plan — movement is navigation, not interpolation
  between two percentages.

---

## 3. The asset finding that changes the plan

I initially wrote off the 3D packs in `asset dump/` as unusable in a DOM room,
and the 2D `kenney_roguelike-indoors` tilesheet (16×16, CC0) as the usable one.
**That was backwards**, and the reason matters:

`office.css` says the characters are *"pre-rendered low-poly 3D, not retro pixel
art"*. Dropping 16×16 pixel-art furniture next to them would clash badly. The 3D
packs are the stylistically correct source — and there is already a pipeline:

`project-chimera/godot/tools/render_character.py` is a **headless Blender
renderer** that takes a Kenney mini-character GLB and outputs top-down frames —
6 walk frames, idle plus 4 directions, 256px, 30° camera elevation. That is
*exactly* the 6×5 sheet `office.js` indexes (`SHEET_COLS=6, SHEET_ROWS=5`), and
`scripts/generate_office_sprites.js` already reads from
`project-chimera/godot/assets` with a hardcoded 8-name `CHARACTERS` array.

Two consequences:

1. **The 4 hue-rotated twins can be retired.** `kenney_mini-characters.zip`
   ships 29 GLBs. Render 4 more through the existing pipeline, add the names to
   `CHARACTERS`, re-run `npm run office:generate-sprites`. Twelve genuinely
   distinct agents — this is asset work, not engineering.
2. **Props can match the characters exactly**, by rendering
   `kenney_furniture-kit` / `Ultimate House Interior Pack` GLBs through the same
   script at the same camera angle. Today's props are CSS boxes; rendered props
   would sit in the same visual world as the cast.

---

## 4. Per-stage environments

Your idea, developed. The key insight is that **each phase has a different
number of active agents**, so one generic layout is wrong for all of them:

| Phase | Active | Environment | Why it's less crowded |
|---|---|---|---|
| `deep_research` | 12 | **Research Library** — 12 individual carrels | Twelve separate spots, zero clustering. The most spread-out arrangement available. |
| `ideation_critique` | 12 | **Studio Floor** — own desk + critique corner | Agents alternate between their desk and someone else's idea; never all in one zone. |
| `collaboration` | 2–10 | **Merge Tables** — pairs facing each other | Only proposed pairs are staged; the rest sit at the periphery. |
| `architecture` | 6 | **Drafting Room** | Only the top 6 ideas get built out. Half the cast is genuinely idle — show them watching, not crammed. |
| `ready_for_judging` | 7 judges + 6 ideas | **Judging Hall** — judges' bench | Currently the judges don't exist on screen at all, during the phase that decides outcomes. |
| `building` | 6 + 6 | **Two team rooms** | Halves occupancy per room. See §5. |
| `tribunal` | 12 | **Tribunal Circle** | A ring is the most space-efficient way to place 12 and read all of them. |
| `complete` | — | **Hall of Records** — winner podium, Elo standings | Gives N-5's ratings somewhere to live. |

**My main amendment: do not build eight hand-authored rooms.** That's eight
times the art and maintenance, and the current room is drawn entirely from CSS
gradients and positioned divs. Instead follow Chimera's own approach —
`location_manager.gd` is a *data table*, and the rooms are built by tool scripts
rather than hand-placed.

So: **one renderer, a per-phase set-dressing descriptor.** A phase declares its
zones, its props, its floor/wall palette and its seat layout; the existing draw
loop consumes it. Eight environments for roughly the cost of one and a half,
and a new phase is a data entry rather than a new view.

---

## 5. Team split during the hackathon

Also right, and it's the only change that genuinely halves density. P2 already
placed agents at two team benches from the roster. The full version gives each
team its own space rather than two clusters in a shared room.

**One caution, from the same maths as §1.** Two side-by-side rooms in a 573px
stage are ~286px each — *worse* than the single room, and 6 characters at 64px
need ~400px minimum. Side-by-side only works above roughly 900px.

**So make it focus-based, not split-screen:** both team rooms visible as
panels, and clicking one expands it to fill the stage while the other collapses
to a summary strip (name, current turn, CI state). Progressive disclosure
instead of cramming — and it degrades correctly on mobile, where side-by-side
can never work.

**Extend membership beyond the hackathon**, since it isn't only a hackathon
concept: seat accepted merge partners together during `collaboration`, and seat
cross-examination pairs facing each other during `tribunal`. The social
structure already exists in the data; the room just doesn't use it.

---

## 6. Additions of my own

**a. Scale characters with the room.** The root cause. `clamp()` the character
size against room width so the pitch-to-character ratio is constant at every
viewport. Fixes mobile as a side effect and stops the layout constants being a
desktop-only assumption.

**b. Fix the zoning.** Per RimWorld: move Break Area off centre and put the
active work zones there. The least interesting state currently occupies the
most valuable space.

**c. Thin the labels.** Per the crowding research, show names on hover once a
zone holds more than ~3 occupants, or stagger them vertically. Twelve permanent
labels is most of the overlap.

**d. Idle behaviour.** Chimera's NPCs roam between markers; geezerrrr's return
to their seat before real work. Idle agents drifting between couch and cooler
makes a quiet room read as *calm* rather than *broken* — worth having, since a
real cycle is mostly quiet.

**e. Don't adopt navigation/pathfinding.** Chimera has it and it's lovely, but
it needs a nav mesh and a game loop. Twelve characters interpolating between
zone coordinates is sufficient for a view that updates every 5 minutes, and the
existing walk choreography is already tuned.

---

## 7. Recommended order

1. **Character scaling** (a) — smallest change, fixes the actual defect, and
   every later layout depends on having sane density.
2. **Per-phase descriptors** (§4) — the data-driven shell, starting with two
   phases (Research Library, Studio Floor) to prove the abstraction before
   converting the rest.
3. **Team rooms with focus** (§5).
4. **Judging Hall** — the biggest gap in coverage; the phase that picks winners
   is currently invisible.
5. **Render 4 more characters** (§3) — retires the hue-rotated twins. Parallel
   to all of the above; it's asset work.
6. Zoning, labels, idle roaming (b, c, d) — polish.

Deferred for the same reasons as before: pathfinding, a canvas rewrite, and
journal-backed replay.
