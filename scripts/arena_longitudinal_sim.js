#!/usr/bin/env node
/**
 * arena_longitudinal_sim.js — ADAPTIVE AGENTS ACROSS ARENAS (long-run dynamics).
 *
 * Covers the gaps the single-arena sims assumed away:
 *  - agents persist across arenas (12 agents, 20 arenas/monthly cycles)
 *  - agents LEARN: violators calibrate their violation rate against being
 *    caught (reinforcement), straddlers aim just inside the evolution band,
 *    cyclers alternate, the suspended wait out the privilege penalty
 *  - detection is measured with realistic noise (sigma = 0.02)
 *  - the ladder's strike decay + redemption path operate across arenas
 *
 * Questions answered:
 *  1. Does the pool clean itself over time (violation share over 20 arenas)?
 *  2. Do opportunists learn deterrence, or settle at a stable evasion rate?
 *  3. Do straddlers dominate the evolution lane?
 *  4. Do suspended agents recover? What's the fairness picture long-run?
 *
 * Run: node scripts/arena_longitudinal_sim.js
 */

const JUDGES = [
  { name: "Mason", wI: 0.20, bias: 0.1 }, { name: "Nora", wI: 0.20, bias: -0.2 },
  { name: "Owen", wI: 0.20, bias: 0.3 }, { name: "Piper", wI: 0.15, bias: -0.1 },
  { name: "Quinn", wI: 0.15, bias: 0.0 }, { name: "Reed", wI: 0.05, bias: -0.3 },
  { name: "Sage", wI: 0.05, bias: 0.2 },
];

const N_AGENTS = 12;
const IDEAS_PER_AGENT = 3;
const N_ARENAS = 20;
const N_REPLICATES = 25;
const INFLATION = 1.2;
const SCORE_SCALE = 8.5;
const NOISE_SD = 0.35;
const SIGMA_MEAS = 0.02;
const BAND = { fresh: 0.80, evolution: 0.90, hard: 0.95 };
const PENALTY = { violationFirst: -2.0, violationRepeat: -3.0, hard: -2.0, dup: -1.0 };
const EVOLUTION_CREDIT = 0.05;
const PRIVILEGE_LIMIT = 3;
const STRIKE_DECAY_PER_CLEAN_ARENA = 1;

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

const A_LOW = 0.18, A_HIGH = 0.42, A_STEP = 0.12;

function runReplicate(seed, conduct, variant) {
  const r = rng(seed);
  const strikeFloor = variant === "v31" ? 0.92 : 0.90;
  const marginalPenalty = variant === "v31" ? -0.5 : PENALTY.violationFirst;
  const agents = [];
  for (let a = 0; a < N_AGENTS; a++) {
    agents.push({
      id: a,
      skill: clip01(0.7 + 0.15 * gauss(r)),
      strikes: 0,
      suspended: false,
      archetype: a < 4 ? "honest" : a < 7 ? "opportunist" : a < 9 ? "straddler" : a < 11 ? "cycler" : "second-chancer",
      lambda: 0.3, // opportunist's violation rate
      lastVerdict: null,
      wins: 0,
    });
  }

  const perArena = {
    violationShare: [], evolutionShare: [], bestLegalAdvance: [], winnerShare: [],
    lambdaTrajectory: [], suspendedCount: [], fpFn: [],
  };

  for (let arena = 0; arena < N_ARENAS; arena++) {
    // ---- ideation with adaptive behavior --------------------------------
    const ideas = [];
    for (const agent of agents) {
      for (let k = 0; k < IDEAS_PER_AGENT; k++) {
        const latent = gauss(r);
        // Behavior decision: does THIS idea violate? (per-idea draw)
        const behave = (() => {
          if (agent.suspended) return "blocked";
          switch (agent.archetype) {
            case "honest": return "fresh";
            case "opportunist": return r() < agent.lambda ? "violator" : "fresh";
            case "straddler": return "straddle";
            case "cycler": return arena % 2 === 0 ? "violator" : "fresh";
            case "second-chancer": return r() < agent.lambda * 0.5 ? "violator" : "fresh";
          }
        })();
        agent.lastVerdict = null;
        const discount = behave === "violator" ? 0.06 : 0;
        const q = JUDGES.map(() => clip01(0.2 + 0.25 * latent + 0.3 * gauss(r) + 0.25 * agent.skill - discount));
        const trueSim = behave === "violator" ? uni(r, [0.92, 0.97])
          : behave === "straddle" ? uni(r, [0.875, 0.895])
          : uni(r, [0.55, 0.72]);
        ideas.push({ id: `i${ideas.length}`, agent, k, q, behave, trueSim,
          trueTotal: JUDGES.reduce((s, j, i) => s + j.wI * q[i], 0), order: ideas.length });
      }
    }

    // ---- conduct: classification + strikes (measured with noise) --------
    const meta = new Map(ideas.map((x) => [x, { measured: x.trueSim + gauss(r) * SIGMA_MEAS, cls: "fresh", penalty: 0, submitted: false, judged: 0 }]));
    const strikesGained = new Map(agents.map((a) => [a, 0]));
    for (const idea of ideas) {
      const m = meta.get(idea);
      if (!conduct || idea.behave === "blocked" || idea.agent.suspended) {
        if (!idea.agent.suspended) m.submitted = true;
        continue;
      }
      m.submitted = true;
      const s = m.measured;
      if (s >= BAND.hard) {
        m.cls = "hard"; m.penalty = PENALTY.hard; idea.agent.strikes += 2; strikesGained.set(idea.agent, strikesGained.get(idea.agent) + 2);
      } else if (s > BAND.evolution && (variant !== "v31" || s >= strikeFloor)) {
        m.cls = "violation";
        m.penalty = idea.agent.strikes > 0 ? PENALTY.violationRepeat : PENALTY.violationFirst;
        idea.agent.strikes += 1; strikesGained.set(idea.agent, strikesGained.get(idea.agent) + 1);
      } else if (s > BAND.evolution) {
        // v3.1: inside the measurement-noise zone (0.90-0.92) — soft penalty,
        // NO strike. Noise-flipped legal ideas pay little; careers untouched.
        m.cls = "marginal";
        m.penalty = marginalPenalty;
      } else if (s >= BAND.fresh) {
        m.cls = "evolution";
        if (idea.behave === "straddle") { m.credited = true; m.penalty = EVOLUTION_CREDIT; }
      }
    }
    for (const a of agents) if (a.strikes >= PRIVILEGE_LIMIT) a.suspended = true;

    // ---- judging ---------------------------------------------------------
    for (const idea of ideas) {
      const m = meta.get(idea);
      if (!m.submitted) continue;
      let total = 0;
      for (const j of JUDGES) {
        total += j.wI * Math.max(0, Math.min(10, SCORE_SCALE * idea.q[JUDGES.indexOf(j)] + INFLATION + j.bias + gauss(r) * NOISE_SD));
      }
      m.judged = Math.min(10, Math.round((total + m.penalty) * 100) / 100);
    }

    // ---- advancement (distinctness + cheap runoff, R8 order) ------------
    const eligible = ideas.filter((x) => { const m = meta.get(x); return m.submitted && (conduct ? m.cls !== "hard" : true); });
    eligible.sort((a, b) => {
      if (meta.get(b).judged !== meta.get(a).judged) return meta.get(b).judged - meta.get(a).judged;
      if (conduct) return meta.get(a).measured - meta.get(b).measured;
      return a.order - b.order;
    });
    const picked = [];
    for (const c of eligible) {
      if (picked.length === 2) break;
      if (picked.every((p) => cosineSim(c.q, p.q) < 0.90)) picked.push(c);
    }
    if (picked.length < 2) picked.push(...eligible.filter((c) => !picked.includes(c)).slice(0, 2 - picked.length));

    // ---- winner (simplified hackathon: trueTotal + build noise) ---------
    const scored = picked.map((idea) => {
      const build = clip01(0.5 + 0.3 * idea.agent.skill - (A_HIGH + (A_LOW - A_HIGH) * idea.trueTotal) / 2 + (r() - 0.5) * 0.2);
      return { idea, final: 0.3 * meta.get(idea).judged + 0.7 * (10 * (0.65 * idea.trueTotal + 0.35 * build) + INFLATION + gauss(r) * NOISE_SD * 0.6) };
    });
    scored.sort((a, b) => b.final - a.final);
    if (scored.length === 2) { scored[0].idea.agent.wins++; }
    const winnerAgent = scored[0].idea.agent;

    // ---- post-arena dynamics: learning + strike decay -------------------
    let fnCount = 0, nViol = 0, straddlerFP = 0, nStraddler = 0;
    for (const idea of ideas) {
      if (idea.behave === "violator") {
        nViol++;
        const m = meta.get(idea);
        if (m.cls === "fresh" || m.cls === "evolution") fnCount++;
      }
      if (idea.behave === "straddle") {
        nStraddler++;
        if (meta.get(idea).cls === "violation" || meta.get(idea).cls === "hard") straddlerFP++;
      }
    }
    perArena.straddlerFP = nStraddler > 0 ? straddlerFP / nStraddler : 0;
    // Opportunist reinforcement: violated & got away -> greedier; caught -> deterred
    for (const a of agents) {
      if (a.archetype === "opportunist") {
        const verdict = strikesGained.get(a) > 0 ? "caught" : "clean";
        if (verdict === "caught") a.lambda = clip01(a.lambda - 0.25);
        else a.lambda = Math.min(0.67, a.lambda + 0.08);
        a.lastVerdict = verdict;
      }
      // Decay: a clean arena erases one strike (redemption path)
      if (conduct && strikesGained.get(a) === 0 && a.strikes > 0) {
        a.strikes -= STRIKE_DECAY_PER_CLEAN_ARENA;
        if (a.strikes < PRIVILEGE_LIMIT) a.suspended = false;
      }
    }

    // ---- per-arena metrics ----------------------------------------------
    const subs = ideas.filter((x) => meta.get(x).submitted);
    const violators = subs.filter((x) => x.behave === "violator").length;
    perArena.violationShare.push(violators / Math.max(1, subs.length));
    perArena.evolutionShare.push(subs.filter((x) => meta.get(x).cls === "evolution").length / Math.max(1, subs.length));
    const bestLegal = ideas.filter((x) => x.behave !== "violator").reduce((b, x) => (x.trueTotal > b.trueTotal ? x : b), ideas[0]);
    perArena.bestLegalAdvance.push(picked.some((x) => x === bestLegal) ? 1 : 0);
    perArena.winnerShare.push(winnerAgent.id);
    perArena.lambdaTrajectory.push(agents.reduce((s, a) => s + (a.archetype === "opportunist" ? a.lambda : 0), 0) / 3);
    perArena.suspendedCount.push(agents.filter((a) => a.suspended).length);
    perArena.fpFn.push({ fn: nViol > 0 ? fnCount / nViol : 0, straddlerFP: perArena.straddlerFP });
  }
  return { agents, perArena };
}

function run(label, conduct, variant = "v3") {
  const agg = {
    violationShare: new Array(N_ARENAS).fill(0), evolutionShare: new Array(N_ARENAS).fill(0),
    bestLegalAdvance: 0, lambda: new Array(N_ARENAS).fill(0), suspended: new Array(N_ARENAS).fill(0),
    fn: new Array(N_ARENAS).fill(0), straddlerFP: new Array(N_ARENAS).fill(0),
    winsByAgent: new Array(N_AGENTS).fill(0), straddlerWins: 0,
  };
  for (let rep = 0; rep < N_REPLICATES; rep++) {
    const { agents, perArena } = runReplicate(4000 + rep * 7919, conduct, variant);
    for (let a = 0; a < N_ARENAS; a++) {
      agg.violationShare[a] += perArena.violationShare[a];
      agg.evolutionShare[a] += perArena.evolutionShare[a];
      agg.lambda[a] += perArena.lambdaTrajectory[a];
      agg.suspended[a] += perArena.suspendedCount[a];
      agg.fn[a] += perArena.fpFn[a].fn;
      agg.straddlerFP[a] += perArena.fpFn[a].straddlerFP;
      if (perArena.bestLegalAdvance[a]) agg.bestLegalAdvance++;
    }
    for (const agent of agents) {
      agg.winsByAgent[agent.id] += agent.wins;
      if (agent.archetype === "straddler") agg.straddlerWins += agent.wins;
    }
  }
  const T = N_ARENAS * N_REPLICATES;
  const share = (arr) => arr.map((v) => ((v / N_REPLICATES) * 100).toFixed(0) + "%").join(" ");
  console.log(`\n${label}`);
  console.log(`  violation share by arena (1,5,10,15,20):  ${share(agg.violationShare.filter((_, i) => [0, 4, 9, 14, 19].includes(i)))}`);
  console.log(`  evolution share by arena (1,5,10,15,20):  ${share(agg.evolutionShare.filter((_, i) => [0, 4, 9, 14, 19].includes(i)))}`);
  console.log(`  best-legal advance: ${((agg.bestLegalAdvance / T) * 100).toFixed(1)}% | opp. learned lambda (1,10,20): ${(agg.lambda[0] / N_REPLICATES).toFixed(2)} -> ${(agg.lambda[9] / N_REPLICATES).toFixed(2)} -> ${(agg.lambda[19] / N_REPLICATES).toFixed(2)}`);
  console.log(`  suspended agents avg (1,10,20): ${(agg.suspended[0] / N_REPLICATES).toFixed(1)} / ${(agg.suspended[9] / N_REPLICATES).toFixed(1)} / ${(agg.suspended[19] / N_REPLICATES).toFixed(1)} | violator slip (20): ${((agg.fn[19] / N_REPLICATES) * 100).toFixed(1)}% | straddler false-accused (20): ${((agg.straddlerFP[19] / N_REPLICATES) * 100).toFixed(1)}%`);
  console.log(`  long-run winner concentration: top share ${((Math.max(...agg.winsByAgent) / T) * 100).toFixed(1)}% | straddler wins ${((agg.straddlerWins / T) * 100).toFixed(1)}% | total wins ${agg.winsByAgent.reduce((a, b) => a + b, 0)}`);
}

console.log("LONGITUDINAL arena sim: 12 persistent adaptive agents x 20 arenas x 25 replicates (sigma_meas=0.02)");
console.log("===================================================================================================");
run("conduct OFF — agents free to violate", false);
run("conduct ON — R1-R8 + strike decay + redemption", true);
run("conduct v3.1 — strikes only >=0.92, soft -0.5 in noise zone", true, "v31");