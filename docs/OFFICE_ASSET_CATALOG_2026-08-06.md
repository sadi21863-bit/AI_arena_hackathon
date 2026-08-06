# Agent Office — asset catalog (chimera project + Kaggle sources)

> **STATUS 2026-08-06 — research only, no code.** Companion to
> `OFFICE_DEEP_ANALYSIS_2026-08-06.md`. Source: `C:\Users\aditya\Desktop\
> project-chimera` (Godot game project + `asset dump\`), and the Kaggle
> Kaggriculture visualizer (`docs/KAGGRICULTURE_STUDY_2026-08-06.md`).
> Note: the sprites have been validated structurally (dimensions, frames,
> transparency) but not eyeballed — no image viewing in this environment.

## 1. What chimera actually uses (curated, web-ready)

`godot\assets\characters\<id>\` — 8 characters, each with `sheet.png`
(96×128 = 3 columns × 4 rows of 32×32) and pre-sliced per-frame PNGs:
`walk_{down,left,right,up}\frame_{0..2}.png` (3 frames each) plus idle.
Animations defined in `godot\resources\sprite_frames\*.tres`:
idle_down @ 5 fps, walk_* @ 8 fps, all looping. The slice logic lives in
`godot\tools\build_sprite_frames.gd` (CHAR_IDS list, ANIM_DEFS, frame sort)
— the browser equivalent is trivial (background-position on `sheet.png`
or 12 small `<img>`s).

Characters: `detective, alex, jordan, sam, riley, morgan, casey, dean`.
`alex` and `casey` match Arena agent names; the other 6 don't (blake, drew,
ellis, finn, gale, hale, iris, jade, kai, leo have no matching sprite).

Other chimera-used assets:

| Asset | Size | Use |
|---|---|---|
| `assets\buildings\campus_backdrop.png` | 1600×1000 | room/campus backdrop |
| `assets\tiles\floor_tile.png` | 20×20 | tiled floor (needs seamless check) |
| `assets\tilesets\pipoya\*` | 1920×1920 samplemap | outdoor tileset |
| `assets\furniture\{bathroom,bedroom,living_kitchen}\*.png` | pixelinterior sets | room props (coops→furniture analogies) |

## 2. Source packs in `asset dump\free-packs\extracted\`

- **PIPOYA FREE RPG Character Sprites 32x32** — 386 PNGs: Male 69, Female
  91, Enemy 41, Japanese school uniforms 4×31, Soldier 28, Animal 12,
  teachers 10, Xmas 6, Other 4, Boss 1. Enough distinct characters for all
  12 arena agents (≈8-11 chars per folder if each uses 8 frames). The 8
  curated godot characters were cut from this pack.
- **Pipoya RPG Tileset 32x32** — outdoor/indoor tilesets.
- **pixelinterior_BA/BR/LRK** — bathroom, bedroom, living-room/kitchen
  interior props (each with `license.txt`).
- **kenney_city_suburban / kenney_roguelike_indoor(s)** — CC0 (License.txt
  present).
- **ultimate_characters / ultimate_house_interior** — larger packs
  (License.txt present).
- **free-house-pixel-art** (Readme.txt), **chrome-district** (cyberpack,
  SHEET-FORMAT.md — sheet layout documentation pattern).
- Not relevant: `godot` source code, `PROJECT_CHIMERA_3D` (no images).

## 3. Coverage vs the Office (12 agents, 6 zones)

- 8 curated sprites ≠ 12 agents → either (a) cut 4 more from the PIPOYA
  pack with the same slice recipe, or (b) reuse 4 sprites with palette swap
  (hue-shift via CSS `filter`) — the pack has plenty of unused characters,
  so (a) is cleaner.
- The office currently renders agents as CSS pixel sprites with an emoji
  face; swapping in `sheet.png` per agent gives real 3-frame walk + idle
  animation for ~0 marginal runtime cost (12 small PNGs, ~2-4 KB each).
- 32×32 matches the office's current tile scale (sprites were scaled for
  the room) and Kaggriculture's 32×32 grid tiles.

## 4. Licenses

- Kenney packs: CC0 (License.txt).
- pixelinterior / ultimate packs: per-pack license.txt (free packs,
  credit expected — read before shipping).
- PIPOYA free pack: free with attribution; page snapshot saved in
  `asset dump\free-packs\pipoya_page.html`.
- kaggle-environments (visualizer): MIT, Apache-2.0 — borrowable.

## 5. Decision hooks for the analysis

- If the Office adopts real sprites: commit the 8 curated characters
  (or 12 after slicing) as static PNGs under `public/assets/agents/`
  (~96×128 sheets), animate via CSS `steps()` on background-position.
- If a future hackathon event is Kaggriculture-themed, the farm sim view
  can reuse `floor_tile.png` + tilesets, and Kaggle's own HTML visualizer
  (`visualizer/default|playable`) is the rendering reference — possibly
  embeddable directly (MIT).
