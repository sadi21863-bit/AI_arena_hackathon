#!/usr/bin/env node
/**
 * conduct_robustness_sim.js — DETECTION ERROR + PARAMETER SWEEPS.
 *
 * Covers the gaps the scenario sims assumed away:
 *  1. Embedding similarity is a MEASUREMENT with error (bge-base embeddings
 *     ~±0.02 live). measure = truth + N(0, sigma_meas). Question: at the
 *     band edges (0.80/0.90/0.95), how often do we falsely accuse a fresh
 *     idea (FP) or let a violator through (FN) — and what does that cost the
 *     best-legal winner?
 *  2. Parameter sweeps to find FLAT (robust) regions vs knife-edges:
 *     evolution band top (0.88/0.90/0.92), violation penalty (1/2/3),
 *     duplicate threshold (0.85/0.90/0.95), runoff margin (0.2/0.5/1.0).
 *
 * Uses the ideathon + conduct + advancement stages of the arena (the stages
 * the parameters govern); hackathon noise is constant across the sweep so
 * relative comparisons hold.
 *
 * Run: node scripts/conduct_robustness_sim.js
 */

const JUDGES = [
  { name: "Mason", wI: 0.20, bias: 0.1 }, { name: "Nora", wI: 0.20, bias: -0.2 },
  { name: "Owen", wI: 0.20, bias: 0.3 }, { name: "Piper", wI: 0.15, bias: -0.1 },
  { name: "Quinn", wI: 0.15, bias: 0.0 }, { name: "Reed", wI: 0.05, bias: -0.3 },
  { name: "Sage", wI: 0.05, bias: 0.2 },
];

const N_AGENTS = 12;
const IDEAS_PER_AGENT = 3;
const N_ARENAS = 200;
const INFLATION = 1.2;
const SCORE_SCALE = 8.5;
const NOISE_SD = 0.35;
const EVOLUTION_CREDIT = 0.05;
const PRIVILEGE_STRIKE_LIMIT = 3;

const FRESH_SIM = [0.55, 0.72];
const EVOLUTION_SIM = [0.82, 0.86];
const VIOLATION_SIM = [0.92, 0.97];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clip01 = (x) => Math.max(0.05, Math.min(0.95, x));
const uni = (r, [lo, hi]) => lo + (hi - lo) * r();
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function runArena(seed, params) {
  const { sigmaMeas, bandEvolutionTop, bandHard, penalty, dupThreshold, runoffMargin } = params;
  const r = rng(seed);
  const agents = [];
  for (let a = 0; a < N_AGENTS; a++) agents.push({ id: a, skill: clip01(0.7 + 0.15 * gauss(r)), strikes: 0, privilegeLost: false });
  const roles = ["fresh", "fresh", "fresh", "fresh", "fresh", "fresh", "fresh", "honest", "honest", "honest", "violator", "violator"];

  const ideas = [];
  for (const agent of agents) {
    for (let k = 0; k < IDEAS_PER_AGENT; k++) {
      const latent = gauss(r);
      const role = roles[agent.id];
      const discount = role === "violator" ? 0.06 : 0;
      const q = JUDGES.map(() => clip01(0.2 + 0.25 * latent + 0.3 * gauss(r) + 0.25 * agent.skill - discount));
      ideas.push({
        id: `i${ideas.length}`, agent, k, q,
        trueTotal: JUDGES.reduce((s, j, i) => s + j.wI * q[i], 0),
        order: ideas.length,
        // TRUE sim (the identity of the behavior), drawn before measurement
        trueSim: role === "violator" ? uni(r, VIOLATION_SIM)
          : role === "honest" && k === 0 ? uni(r, EVOLUTION_SIM)
          : uni(r, FRESH_SIM),
      });
    }
  }

  const meta = new Map();
  for (const idea of ideas) {
    meta.set(idea, { judged: 0, cls: "fresh", penalty: 0, measured: idea.trueSim + gauss(r) * sigmaMeas });
  }

  // Conduct classification on the MEASURED sim (what production would see)
  for (const idea of ideas) {
    const agent = idea.agent;
    const m = meta.get(idea);
    if (agent.privilegeLost) { m.blocked = true; continue; }
    m.submitted = true;
    const s = m.measured;
    if (s >= bandHard) {
      m.cls = "hard"; m.penalty = -2.0; agent.strikes += 2;
    } else if (s > bandEvolutionTop) {
      m.cls = "violation"; m.penalty = agent.strikes > 0 ? -penalty - 1 : -penalty; agent.strikes += 1;
    } else if (s >= 0.80) {
      m.cls = "evolution";
      if (roles[agent.id] === "honest" && idea.k === 0) { m.credited = true; m.penalty = EVOLUTION_CREDIT; }
    }
    if (agent.strikes >= PRIVILEGE_STRIKE_LIMIT) agent.privilegeLost = true;
  }

  // Judging
  for (const idea of ideas) {
    const m = meta.get(idea);
    if (!m.submitted) continue;
    let total = 0;
    for (const j of JUDGES) {
      total += j.wI * Math.max(0, Math.min(10, SCORE_SCALE * idea.q[JUDGES.indexOf(j)] + INFLATION + j.bias + gauss(r) * NOISE_SD));
    }
    m.judged = Math.min(10, Math.round((total + m.penalty) * 100) / 100);
  }

  // Advancement
  const eligible = ideas.filter((x) => { const m = meta.get(x); return m.submitted && m.cls !== "hard"; });
  eligible.sort((a, b) => meta.get(b).judged - meta.get(a).judged);
  const picked = [];
  for (const c of eligible) {
    if (picked.length === 2) break;
    if (picked.every((p) => cosineSim(c.q, p.q) < dupThreshold)) picked.push(c);
  }
  if (picked.length < 2) picked.push(...eligible.filter((c) => !picked.includes(c)).slice(0, 2 - picked.length));

  const runnerUp = picked[1];
  const challenger = eligible.find((c) => !picked.includes(c));
  if (challenger && runnerUp) {
    const gap = meta.get(runnerUp).judged - meta.get(challenger).judged;
    if (gap <= runoffMargin && picked[0] && challenger !== picked[0]) {
      const pPromote = clip01(0.5 + (challenger.trueTotal - runnerUp.trueTotal) / 0.16);
      if (r() < pPromote) picked[1] = challenger;
    }
  }

  // Truth: classification under PERFECT measurement (what the agent actually did)
  let fp = 0, fn = 0, nFresh = 0, nViolators = 0;
  for (const idea of ideas) {
    const m = meta.get(idea);
    if (!m.submitted) continue; // never evaluated — not an error of the detector
    const trueCls = idea.trueSim >= bandHard ? "hard" : idea.trueSim > bandEvolutionTop ? "violation" : idea.trueSim >= 0.80 ? "evolution" : "fresh";
    if (trueCls === "fresh") { nFresh++; if (m.cls === "violation" || m.cls === "hard") fp++; }
    if (trueCls === "violation" || trueCls === "hard") {
      nViolators++;
      if (m.cls === "fresh" || m.cls === "evolution") fn++;
    }
  }
  const bestLegal = ideas.filter((x) => {
    const trueCls = x.trueSim >= bandHard ? "hard" : x.trueSim > bandEvolutionTop ? "violation" : x.trueSim >= 0.80 ? "evolution" : "fresh";
    return trueCls !== "violation" && trueCls !== "hard";
  }).reduce((best, x) => (x.trueTotal > best.trueTotal ? x : best), ideas[0]);
  const violationLive = picked.some((x) => meta.get(x).cls === "violation");

  return {
    fp, fn, nFresh, nViolators,
    advLegal: picked.some((x) => x === bestLegal),
    violationReach: picked.some((x) => meta.get(x).cls === "violation"),
    evolutionReach: picked.some((x) => meta.get(x).cls === "evolution"),
  };
}

function run(label, params) {
  const agg = { fp: 0, fn: 0, nFresh: 0, nViolators: 0, advLegal: 0, violationReach: 0, evolutionReach: 0 };
  for (let a = 0; a < N_ARENAS; a++) {
    const o = runArena(1000 + a * 104729, params);
    for (const k of Object.keys(agg)) agg[k] += o[k];
  }
  const fpRate = (agg.fp / Math.max(1, agg.nFresh)) * 100;
  const fnRate = (agg.fn / Math.max(1, agg.nViolators)) * 100;
  console.log(
    `${label} | FP(fresh accused) ${fpRate.toFixed(1)}% | FN(violator slips) ${fnRate.toFixed(1)}% | best-legal advance ${((agg.advLegal / N_ARENAS) * 100).toFixed(1)}% | violation reach ${((agg.violationReach / N_ARENAS) * 100).toFixed(1)}% | evolution reach ${((agg.evolutionReach / N_ARENAS) * 100).toFixed(1)}%`
  );
}

const BASE = { sigmaMeas: 0.02, bandEvolutionTop: 0.90, bandHard: 0.95, penalty: 2.0, dupThreshold: 0.90, runoffMargin: 0.5 };

console.log("Detection error + parameter sweep sim (200 arenas each; measured vs true classification)");
console.log("==========================================================================================");

console.log("\n--- 1. Embedding measurement error (sigma_meas = 0.005 / 0.015 / 0.03 / 0.05) ---");
for (const sigma of [0.005, 0.015, 0.03, 0.05]) run(`sigma_meas=${sigma}`, { ...BASE, sigmaMeas: sigma });

console.log("\n--- 2. Evolution band top (where 'evolution' ends, 'violation' begins) ---");
for (const top of [0.875, 0.90, 0.92]) run(`band_top=${top}`, { ...BASE, bandEvolutionTop: top });

console.log("\n--- 3. Violation penalty magnitude (1.0 / 2.0 / 3.0 first-offense) ---");
for (const p of [1.0, 2.0, 3.0]) run(`penalty=${p}`, { ...BASE, penalty: p });

console.log("\n--- 4. Duplicate/team-distinctness threshold (0.85 / 0.90 / 0.95) ---");
for (const t of [0.85, 0.90, 0.95]) run(`dup_threshold=${t}`, { ...BASE, dupThreshold: t });

console.log("\n--- 5. Runoff margin (0.2 / 0.5 / 1.0) ---");
for (const m of [0.2, 0.5, 1.0]) run(`runoff_margin=${m}`, { ...BASE, runoffMargin: m });