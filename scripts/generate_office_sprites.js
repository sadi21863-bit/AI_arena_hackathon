// One-off asset generator for the Observatory's Agent Office page.
//
// Run by hand (`npm run office:generate-sprites`), NOT wired into any build
// or deploy step -- the committed output under public/observatory/assets/
// is what ships. Same precedent as the other scripts in this directory.
//
// SOURCE_ROOT is a machine-local path to a sibling Godot project whose
// characters were already rendered out to individual PNG frames. It won't
// exist on another machine or in CI, and doesn't need to: this script only
// re-runs when the source art or the character list changes.
//
// Frames are pre-rendered low-poly 3D, not retro pixel art, so smooth
// resampling on downscale is correct (and office.html must NOT set
// image-rendering: pixelated).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const SOURCE_ROOT = "C:/Users/aditya/Desktop/project-chimera/godot/assets";
const OUT_DIR = path.join(__dirname, "..", "public", "observatory", "assets", "office");
const SPRITE_OUT = path.join(OUT_DIR, "sprites");

const CHARACTERS = ["alex", "casey", "dean", "detective", "jordan", "morgan", "riley", "sam"];

// Row order is load-bearing: office.html indexes rows by this exact order to
// pick an animation, so changing it means changing the ROW constants there.
const ANIMATIONS = [
  { name: "idle_down", frames: 1 },
  { name: "walk_down", frames: 6 },
  { name: "walk_left", frames: 6 },
  { name: "walk_right", frames: 6 },
  { name: "walk_up", frames: 6 },
];

const CELL = 128;
const COLS = 6; // widest animation (6-frame walk cycles)
const ROWS = ANIMATIONS.length;

async function buildSheet(character) {
  const composites = [];

  for (let row = 0; row < ANIMATIONS.length; row++) {
    const anim = ANIMATIONS[row];
    for (let col = 0; col < anim.frames; col++) {
      const src = path.join(SOURCE_ROOT, "characters", character, anim.name, `frame_${col}.png`);
      if (!fs.existsSync(src)) throw new Error(`missing source frame: ${src}`);
      const buf = await sharp(src)
        .resize(CELL, CELL, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      composites.push({ input: buf, left: col * CELL, top: row * CELL });
    }
  }

  const outPath = path.join(SPRITE_OUT, `${character}.webp`);
  await sharp({
    create: { width: COLS * CELL, height: ROWS * CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .webp({ quality: 88, alphaQuality: 90 })
    .toFile(outPath);

  return { character, bytes: fs.statSync(outPath).size };
}

async function main() {
  fs.mkdirSync(SPRITE_OUT, { recursive: true });

  let total = 0;
  for (const character of CHARACTERS) {
    const { bytes } = await buildSheet(character);
    total += bytes;
    console.log(`${character}.webp  ${(bytes / 1024).toFixed(1)} KB`);
  }

  fs.copyFileSync(path.join(SOURCE_ROOT, "tiles", "floor_tile.png"), path.join(OUT_DIR, "floor_tile.png"));
  console.log("floor_tile.png copied");
  console.log(`\n${CHARACTERS.length} sheets, ${(total / 1024).toFixed(1)} KB total`);
  console.log(`Sheet grid: ${COLS} cols x ${ROWS} rows of ${CELL}px cells`);
  console.log(`Row order: ${ANIMATIONS.map((a) => a.name).join(", ")}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
