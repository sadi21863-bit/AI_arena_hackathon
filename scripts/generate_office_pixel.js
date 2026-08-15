// Asset generator for the pixel-art Office redesign.
//
// Run by hand (`npm run office:generate-pixel`), NOT wired into any build or
// deploy step -- the committed output under public/observatory/assets/ is what
// ships. Same precedent as the other scripts in this directory.
//
// Source art comes from two freely-licensed packs on this machine:
//
//  - pipoya character chips (32px cells) for the twelve agents and the pet.
//    Free for commercial/personal use; edit freely; do not redistribute the
//    pack. No attribution required, credited anyway.
//  - the stcrbcn "Office Furniture" pack for the room's props. CC BY 4.0,
//    attribution required -- see pixel/ATTRIBUTION.md next to the output.
//
// Pipoya sheets are 96x128 = 3 walk frames x 4 directions (row order down,
// left, right, up -- verified by luminance probe). The office renderer
// expects a 6x5 grid with ROW = { idle, walk_down, walk_left, walk_right,
// walk_up }, so each 3-frame walk is duplicated to 6 and the idle row reuses
// the down-facing frame 0. Cell size stays native 32px -- office.css sets
// image-rendering: pixelated and the browser upscales from there, which is
// the crisp way to display pixel art (integer 2x at the 64px desktop size).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const PIPPY_SRC = "C:/Users/aditya/Desktop/project-chimera/godot/assets/2d/pipoya_characters";
const STCRBCN_SRC = "C:/Users/aditya/AppData/Local/Temp/opencode/stcrbcn-office/extracted/Office-Furniture-Pixel-Art/Office-Furniture-Pixel-Art";

const OUT_DIR = path.join(__dirname, "..", "public", "observatory", "assets", "office", "pixel");
const SPRITE_OUT = path.join(OUT_DIR, "sprites");
const FURN_OUT = path.join(OUT_DIR, "furniture");

/* agent_id -> pipoya sheet. Twelve distinct characters, no hue-rotates. */
const CAST = {
  agent_alex:  { sheet: "Male/Male 01-1.png", sprite: "alex" },
  agent_casey: { sheet: "Female/Female 01-1.png", sprite: "casey" },
  agent_blake: { sheet: "Male/Male 02-1.png", sprite: "blake" },
  agent_drew:  { sheet: "Male/Male 03-1.png", sprite: "drew" },
  agent_ellis: { sheet: "Female/Female 02-1.png", sprite: "ellis" },
  agent_finn:  { sheet: "Male/Male 04-1.png", sprite: "finn" },
  agent_gale:  { sheet: "Female/Female 03-1.png", sprite: "gale" },
  agent_hale:  { sheet: "Male/Male 05-1.png", sprite: "hale" },
  agent_iris:  { sheet: "Female/Female 04-1.png", sprite: "iris" },
  agent_jade:  { sheet: "Female/Female 05-1.png", sprite: "jade" },
  agent_kai:   { sheet: "Male/Male 06-1.png", sprite: "kai" },
  agent_leo:   { sheet: "Male/Male 07-1.png", sprite: "leo" },
};

/* Furniture pieces the office sets dress the room with. Names map 1:1 to the
   CSS prop classes (see office.css .v-office__prop--*). */
const FURNITURE = {
  desk:      "Desk.png",
  deskb:     "Desk-2.png",
  chair:     "Chair.png",
  table:     "Big-Round-Table.png",
  board:     "Board.png",
  shelf:     "Tall-Bookshelf.png",
  bookshelf: "Bookshelf.png",
  couch:     "Big-Sofa.png",
  plant:     "Big-Plant.png",
  cooler:    "Water-Dispenser.png",
  coffee:    "Coffee-Machine.png",
  filing:    "Wide-Filing-Cabinet.png",
  printer:   "Big-Office-Printer.png",
};

/* Pipoya row order, confirmed against the sheets: down, left, right, up. */
const PIPOYA_ROWS = ["down", "left", "right", "up"];
const CELL = 32;
const COLS = 6, ROWS = 5;
/* walk rows = pipoya 3 frames repeated to 6; idle row = down frame 0. */
const WALK_COLS = [0, 1, 2, 0, 1, 2];

async function sliceCell(src, cellCol, cellRow) {
  return sharp(src)
    .extract({ left: cellCol * CELL, top: cellRow * CELL, width: CELL, height: CELL })
    .toBuffer();
}

async function buildAgentSheet(entry) {
  const src = path.join(PIPPY_SRC, entry.sheet);
  if (!fs.existsSync(src)) throw new Error(`missing pipoya sheet: ${src}`);

  // frame[row][col] in pipoya terms; row 0 = down (idle source too).
  const frame = {};
  for (let r = 0; r < PIPOYA_ROWS.length; r++) {
    frame[PIPOYA_ROWS[r]] = [];
    for (let c = 0; c < 3; c++) frame[PIPOYA_ROWS[r]].push(await sliceCell(src, c, r));
  }

  // Sheet rows: idle, walk_down, walk_left, walk_right, walk_up.
  const idle = frame.down[0];
  const rows = [
    [idle, idle, idle, idle, idle, idle],
    WALK_COLS.map((c) => frame.down[c]),
    WALK_COLS.map((c) => frame.left[c]),
    WALK_COLS.map((c) => frame.right[c]),
    WALK_COLS.map((c) => frame.up[c]),
  ];

  const composites = [];
  rows.forEach((row, r) => row.forEach((buf, c) => composites.push({ input: buf, left: c * CELL, top: r * CELL })));

  const outPath = path.join(SPRITE_OUT, `${entry.sprite}.webp`);
  await sharp({
    create: { width: COLS * CELL, height: ROWS * CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .webp({ lossless: true })
    .toFile(outPath);

  return { name: `${entry.sprite}.webp`, bytes: fs.statSync(outPath).size };
}

async function buildPet() {
  const src = path.join(PIPPY_SRC, "Other", "pien.png");
  if (!fs.existsSync(src)) throw new Error(`missing pipoya sheet: ${src}`);
  const buf = await sharp(src).extract({ left: 0, top: 0, width: CELL, height: CELL }).toBuffer();
  const outPath = path.join(OUT_DIR, "pet.webp");
  await sharp(buf).webp({ lossless: true }).toFile(outPath);
  return { name: "pet.webp", bytes: fs.statSync(outPath).size };
}

async function buildFurniture() {
  const out = [];
  for (const [cls, file] of Object.entries(FURNITURE)) {
    const src = path.join(STCRBCN_SRC, file);
    if (!fs.existsSync(src)) throw new Error(`missing furniture sprite: ${src}`);
    const outPath = path.join(FURN_OUT, `${cls}.webp`);
    // Straight lossless conversion of the full cell -- the transparent padding
    // is part of the art and keeps centring on the sprite's true middle.
    await sharp(src).webp({ lossless: true }).toFile(outPath);
    out.push({ name: `${cls}.webp`, bytes: fs.statSync(outPath).size });
  }
  return out;
}

async function main() {
  fs.mkdirSync(SPRITE_OUT, { recursive: true });
  fs.mkdirSync(FURN_OUT, { recursive: true });

  let total = 0;
  const report = [];
  for (const entry of Object.values(CAST)) {
    const { name, bytes } = await buildAgentSheet(entry);
    total += bytes;
    report.push(`${name}  ${(bytes / 1024).toFixed(1)} KB`);
  }
  const pet = await buildPet();
  total += pet.bytes;
  report.push(`${pet.name} (pet)  ${(pet.bytes / 1024).toFixed(1)} KB`);

  for (const f of await buildFurniture()) {
    total += f.bytes;
    report.push(`${f.name} (prop)  ${(f.bytes / 1024).toFixed(1)} KB`);
  }

  console.log(report.join("\n"));
  console.log(`\n${Object.keys(CAST).length} agents, 1 pet, ${Object.keys(FURNITURE).length} props, ${(total / 1024).toFixed(1)} KB total`);
  console.log(`Agent grid: ${COLS} cols x ${ROWS} rows of ${CELL}px cells (idle, walk_down, walk_left, walk_right, walk_up)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
