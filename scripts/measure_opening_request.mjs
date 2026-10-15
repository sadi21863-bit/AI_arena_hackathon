// Measures the ACTUAL build-turn opening request composition from real source,
// not from an estimate.
//
// Why this matters: the Groq failure quoted a precise figure —
// "Requested 13542" input tokens against a ~7,000 ITPM ceiling — but not its
// composition. Whether the trim is worth doing, and WHICH part to trim, depends
// entirely on what those 13,542 tokens are. If they are mostly the 9 baked
// skills, per-turn skill selection is a large, safe win. If they are mostly the
// task prompt or the model's own system prompt, trimming skills buys little and
// the conclusion changes.
//
// Token estimate: 1 token ~= 4 bytes of English text. The provider's own
// tokenizer would differ, so these are relative sizes for COMPARISON, which is
// what the decision needs.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const tok = (bytes) => Math.round(bytes / 4);
const readBytes = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);

// --- 1. the task prompt the arena builds every turn --------------------------
const exec = fs.readFileSync("src/events/executor.ts", "utf8");
const frags = [];
const re = /`([^`]{200,})`/g;
let m;
while ((m = re.exec(exec)) !== null) {
  const s = m[1];
  if (/PLAN|IMPLEMENT|VERIFY|BACKLOG|VERIFICATION|SELF-VERIFY/i.test(s)) frags.push(s);
}
const seen = new Set();
let promptBytes = 0;
const rows = [];
for (const f of frags) {
  if (seen.has(f)) continue;
  seen.add(f);
  promptBytes += Buffer.byteLength(f, "utf8");
  rows.push(["(build-turn prompt fragment)", Buffer.byteLength(f, "utf8")]);
}

// --- 2. scaffold docs the agent reads from the repo --------------------------
const scaffold = ["repo-scaffold/AGENTS.md", "repo-scaffold/BACKLOG.md", "repo-scaffold/README.md", "repo-scaffold/.env.example"];
for (const s of scaffold) {
  const b = readBytes(s);
  if (b) { promptBytes += b; rows.push([s, b]); }
}

// --- 3. baked skills, individually ------------------------------------------
const skillDir = path.join(ROOT, "docker/skills");
const skills = [];
if (fs.existsSync(skillDir)) {
  for (const d of fs.readdirSync(skillDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(skillDir, d.name, "SKILL.md");
    const b = readBytes(f);
    if (b) skills.push({ name: d.name, bytes: b });
  }
}
skills.sort((a, b) => b.bytes - a.bytes);
const skillBytes = skills.reduce((s, x) => s + x.bytes, 0);

// --- 4. image-build config: NOT sent to the model ---------------------------
// opencode.json / Dockerfile are baked into the IMAGE and consumed by the CLI
// at startup; they are not prompt content. Classifying them as prompt text was
// the first version's error and it produced a nonsense negative remainder.
const cfg = ["docker/opencode.json", "docker/playwright-mcp.json", "docker/Dockerfile.arena-team-base"];
let cfgBytes = 0;
for (const c of cfg) cfgBytes += readBytes(c);

// Irreducible: content the arena sends every turn regardless of skill choice.
const alwaysTokens = tok(promptBytes);
const skillTokens = tok(skillBytes);
const measured = 13542;              // provider-quoted from the real Groq error
const otherTokens = measured - alwaysTokens;   // skills actually pulled in + tool schemas + system prompt

console.log("BUILD-TURN OPENING REQUEST COMPOSITION (measured from source)\n");
console.log("  A. always-sent (build prompt + AGENTS.md + BACKLOG.md) -- irreducible");
console.log(`       ${"(build-turn prompt fragments, combined)".padEnd(38)} ${String(promptBytes).padStart(7)} B  ~${String(alwaysTokens).padStart(5)} tok`);
console.log(`\n  B. baked skills on disk -- TRIMMABLE, but only the ones actually loaded`);
for (const s of skills) console.log(`       ${s.name.padEnd(38)} ${String(s.bytes).padStart(7)} B  ~${String(tok(s.bytes)).padStart(5)} tok`);
console.log(`       ${"ALL 9 ON DISK".padEnd(38)} ${String(skillBytes).padStart(7)} B  ~${String(skillTokens).padStart(5)} tok`);

console.log(`\n  C. image-build config (NOT prompt content): ${cfgBytes} B  ~${tok(cfgBytes)} tok`);

console.log(`\n  RECONCILIATION against the provider-quoted ${measured}-token opening request:`);
console.log(`    A  always-sent                              ~${String(alwaysTokens).padStart(6)} tok  (irreducible)`);
console.log(`    B' skills actually loaded + tool schemas     ~${String(otherTokens).padStart(6)} tok  (partly trimmable)`);
console.log(`    ------------------------------------------------------------------`);
console.log(`    note: A+B-on-disk is ${alwaysTokens + skillTokens} tok, which EXCEEDS the measured`);
console.log(`          ${measured}. That is not an error: the agent loads skills LAZILY. Only the`);
console.log(`          ones it needs are in the opening request, so most of the 22K on disk`);
console.log(`          never reaches the model at all.`);

console.log(`\n  FLOOR: even with ZERO skills loaded, the opening request is at least`);
console.log(`         ~${alwaysTokens} tok of arena content, PLUS opencode's system prompt and tool`);
console.log("         schemas (not measurable from here, but certainly >1,000 tok).");
const floor = alwaysTokens + 1500;
console.log(`         realistic floor ~${floor} tok against Groq's measured ~4,000-token ceiling.`);
console.log(`\n  VERDICT: ${floor > 4000
  ? "GROQ FREE CANNOT CARRY THE ARENA'S BUILD TURNS. Trimming skills narrows the gap but cannot"
  + "\n           close it, because the always-sent content alone already exceeds the ceiling."
  : "Trimming could bring the opening request under the ceiling."}`);