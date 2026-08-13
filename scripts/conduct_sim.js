#!/usr/bin/env node
/**
 * conduct_sim.js v3 — Arena Code of Conduct, iteration 3.
 *
 * Rules under test (each was added or changed on evidence, cited inline):
 *
 *   R1  Quota: 3 ideas per agent; at most ONE may derive from prior work.
 *   R2  Base material is legal: evolution (sim 0.80-0.90) allowed, credited.
 *   R3  Detection bands (measured): fresh<0.80 | evolution 0.80-0.90 |
 *       violation >0.90 | hard >=0.95.
 *   R4  Ladder (deterministic pipeline): violation -2.0/-3.0 by strike;
 *       hard excluded +2 strikes; 3 strikes lose the privilege;
 *       decay -1 per clean arena (redemption).
 *   R5  Evolution credit +0.05 (0.25 distorted the ranking: measured in v1).
 *   R6  NEW — same-arena convergence (the EchoPlex x5 case): if a
 *       submission is >=0.90 similar to an EARLIER submission in the same
 *       arena, it's classed "dup", -1.0 cut, no strike (coordination
 *       failure, not malice — timestamp order gives priority, mimicking
 *       real-hackathon first-submission rules).
 *   R8  NEW — deterministic tie-break: exact score ties resolve by
 *       (1) lower recycle_sim (more novel), (2) fewer strikes (clean
 *       record), (3) earlier submission. Kills the coin flip.
 *
 * Open question tested as a scenario: agents who CYCLE — violate exactly
 * every other arena, riding the decay to stay at low severity. Does
 * enforcement still hold? (R4's first-strike severity -2.0 each time.)
 *
 * Run: node scripts/conduct_sim.js
 */

const N_AGENTS = 12;
const IDEAS_PER_AGENT = 3;
const N_EVENTS = 60;
const N_TRIALS = 300;
const JUDGES = 7;
const INFLATION = 1.8;
const JUDGE_OFFSET_SD = 0.35;
const NOISE_SD = 0.45;
const RUNOFF_MARGIN = 0.5;

const EVOLUTION_MIN = 0.8;
const VIOLATION_MIN = 0.9;
const HARD_MIN = 0.95;
const PENALTY_1 = 2.0;
const PENALTY_2 = 3.0;
const DUP_PENALTY = 1.0;
const EVOLUTION_CREDIT = 0.05;
const MAX_STRIKES = 3;

let P_RECYCLE = 0.5;
let GIVEN_RECYCLE = { evolution: 0.40, violation: 0.45, hard: 0.15 };
let OFFENDERS = 0;              // agents with elevated violation propensity
let OFFENDER_P_VIOLATION = 0.8;
let CYCLERS = 0;                // agents who violate every other arena (decay riders)
let CONVERGENCE = 0.4;          // P(an idea pair in-arena converges >=0.90) — EchoPlex world

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function judgeScore(r, trueQuality) {
  const s = trueQuality * 10 + INFLATION + gauss(r) * JUDGE_OFFSET_SD + gauss(r) * NOISE_SD;
  return Math.max(0, Math.min(10, Math.round(Math.max(0, s) * 2) / 2));
}

function classify(sim) {
  if (sim >= HARD_MIN) return "hard";
  if (sim >= VIOLATION_MIN) return "violation";
  if (sim >= EVOLUTION_MIN) return "evolution";
  return "fresh";
}

function runTrial(seed, conductOn, tiebreak) {
  const r = rng(seed);
  const stats = {
    winnerClass: { fresh: 0, evolution: 0, violation: 0, hard: 0 },
    advancesViolation: 0,
    violationsSubmitted: 0,
    dupsSubmitted: 0,
    recidivistAgents: 0,
    evolutionLaneUsed: 0,
    privilegeLostEvents: 0,
    tiesAtTopTotal: 0,
    coinFlips: 0,                // after tie-break resolution
    top2NoveltyTotal: 0,
    winnerByAgent: Array(N_AGENTS).fill(0),
  };
  const strikes = Array(N_AGENTS).fill(0);
  const isOffender = Array.from({ length: N_AGENTS }, (_, i) => i < OFFENDERS);
  const isCycler = Array.from({ length: N_AGENTS }, (_, i) => i >= OFFENDERS && i < OFFENDERS + CYCLERS);
  const g = { ...GIVEN_RECYCLE };

  for (let ev = 0; ev < N_EVENTS; ev++) {
    const ideas = [];           // {agent, cls, sim, quality, slot, order}
    const violatedAgents = new Set();
    let laneUsed = false;
    let privilegeLost = 0;

    for (let a = 0; a < N_AGENTS; a++) {
      const privilegeGone = strikes[a] >= MAX_STRIKES;
      if (privilegeGone) privilegeLost++;
      // Cyclers: use the slot ONLY when strike-clean (violate, decay, repeat)
      const cyclerTurn = isCycler[a] && strikes[a] > 0;
      const usesSlot = !privilegeGone && !cyclerTurn && r() < P_RECYCLE;
      for (let k = 0; k < IDEAS_PER_AGENT; k++) {
        let cls = "fresh";
        let sim = 0.5 + 0.15 * r();
        if (k === 0 && usesSlot) {
          let pV = g.violation, pH = g.hard;
          if (isOffender[a]) pV = Math.max(0.05, g.violation + (OFFENDER_P_VIOLATION - g.violation));
          if (isCycler[a]) { pV = 0.9; pH = 0.02; }   // ruthless but legal-faced
          const roll = r();
          if (roll < pH) { sim = 0.955 + 0.03 * r(); }
          else if (roll < pH + pV) { sim = 0.91 + 0.03 * r(); }
          else { sim = 0.8 + 0.09 * r(); }
          cls = classify(sim);
        }
        ideas.push({ agent: a, cls, sim, quality: 0.5 + 0.4 * r(), slot: k, order: ideas.length });
      }
    }

    // R6: same-arena convergence — pairwise check AFTER all submissions
    // (models the real flow: submissions land, then the pairwise matrix
    // runs). Earlier submission keeps its class; later >=0.90 matches are
    // demoted to "dup" (soft: -1.0, no strike).
    for (let i = 0; i < ideas.length; i++) {
      if (ideas[i].cls !== "fresh") continue;
      if (r() > CONVERGENCE * 0.5) continue; // convergence is a field-level chance
      for (let j = 0; j < i; j++) {
        const simij = 0.9 + 0.06 * r();      // converged pair: near-identical
        if (simij >= VIOLATION_MIN) { ideas[i].cls = "dup"; ideas[i].sim = simij; break; }
      }
    }

    const scores = ideas.map((idea) => {
      let sum = 0;
      for (let j = 0; j < JUDGES; j++) sum += judgeScore(r, idea.quality);
      let total = sum / JUDGES;
      if (idea.cls === "evolution") laneUsed = true;
      if (idea.cls === "violation" || idea.cls === "hard") {
        stats.violationsSubmitted++;
        violatedAgents.add(idea.agent);
      }
      if (idea.cls === "dup") stats.dupsSubmitted++;
      if (conductOn) {
        if (idea.cls === "evolution") total += EVOLUTION_CREDIT;
        else if (idea.cls === "dup") total -= DUP_PENALTY;
        else if (idea.cls === "violation") {
          total -= strikes[idea.agent] === 0 ? PENALTY_1 : PENALTY_2;
          strikes[idea.agent]++;
          if (strikes[idea.agent] >= MAX_STRIKES) idea.disqualified = true;
        } else if (idea.cls === "hard") {
          idea.disqualified = true;
          strikes[idea.agent] = Math.min(MAX_STRIKES, strikes[idea.agent] + 2);
        }
      }
      return { ...idea, total: Math.max(0, total), rounded: Math.round(total * 100) / 100 };
    });

    stats.recidivistAgents += violatedAgents.size;
    if (laneUsed) stats.evolutionLaneUsed++;
    stats.privilegeLostEvents += privilegeLost;

    const eligible = scores.filter((s) => !s.disqualified);
    if (tiebreak) {
      eligible.sort((x, y) =>
        y.total - x.total ||
        x.sim - y.sim ||                       // more novel first
        strikes[x.agent] - strikes[y.agent] || // clean record first
        x.order - y.order);                    // first submission first
    } else {
      eligible.sort((x, y) => y.total - x.total);
    }

    const allSorted = scores.slice();
    if (tiebreak) {
      allSorted.sort((x, y) =>
        y.total - x.total || x.sim - y.sim || strikes[x.agent] - strikes[y.agent] || x.order - y.order);
    } else {
      allSorted.sort((x, y) => y.total - x.total);
    }
    let tiesAtTop = 1;
    while (tiesAtTop < allSorted.length && allSorted[tiesAtTop].rounded === allSorted[0].rounded) tiesAtTop++;
    stats.tiesAtTopTotal += tiesAtTop;

    const pickDistinct = (list) => {
      const picked = [];
      for (const c of list) {
        if (picked.length === 2) break;
        const tooSimilar = picked.some((p) => Math.abs(c.sim - p.sim) < 0.02);
        if (!tooSimilar) picked.push(c);
      }
      if (picked.length === 2) return picked;
      return list.slice(0, 2);
    };

    const finalists = pickDistinct(eligible);
    finalists.forEach((f) => {
      if (f.cls === "violation" || f.cls === "hard") stats.advancesViolation++;
      stats.top2NoveltyTotal += 1 - f.sim;
    });

    const winner = finalists[0];
    stats.winnerClass[winner.cls]++;
    stats.winnerByAgent[winner.agent]++;

    if (finalists.length === 2 && finalists[0].total - finalists[1].total <= RUNOFF_MARGIN) {
      if (Math.abs(finalists[0].total - finalists[1].total) < 0.01 && !tiebreak) {
        // True tie, NO tie-break in force: runoff ballot is a coin flip.
        // With R8, the deterministic order already seeded the pair, and a
        // runoff tie is "inconclusive" -> it changes nothing (spec N-3:
        // "Inconclusive verdicts change nothing") -> the seed keeps the slot.
        stats.coinFlips++;
        const w2 = r() < 0.5 ? finalists[0] : finalists[1];
        stats.winnerClass[finalists[0].cls]--;
        stats.winnerClass[w2.cls]++;
        stats.winnerByAgent[finalists[0].agent]--;
        stats.winnerByAgent[w2.agent]++;
      }
    }

    for (let a = 0; a < N_AGENTS; a++) {
      if (!violatedAgents.has(a) && strikes[a] > 0) strikes[a]--;
    }
  }
  return stats;
}

function run(label, seed, conductOn, tiebreak) {
  const agg = { winnerClass: { fresh: 0, evolution: 0, violation: 0, hard: 0 } };
  const winnerByAgent = Array(N_AGENTS).fill(0);
  for (let t = 0; t < N_TRIALS; t++) {
    const s = runTrial(seed + t * 7919, conductOn, tiebreak);
    for (const k of Object.keys(s)) {
      if (k === "winnerClass") {
        for (const c of Object.keys(s.winnerClass)) agg.winnerClass[c] += s.winnerClass[c];
      } else if (k === "winnerByAgent") {
        for (let a = 0; a < N_AGENTS; a++) winnerByAgent[a] += s.winnerByAgent[a];
      } else {
        agg[k] = (agg[k] || 0) + s[k];
      }
    }
  }
  const totalWins = N_TRIALS * N_EVENTS;
  const p100 = (v) => (v / N_TRIALS / N_EVENTS) * 100;
  const topShare = Math.max(...winnerByAgent) / totalWins * 100;
  const distinctWinners = winnerByAgent.filter((v) => v > 0).length;
  console.log(`\n=== ${label} (${N_TRIALS} trials x ${N_EVENTS} arenas) ===`);
  console.log(`winners: fresh ${(agg.winnerClass.fresh / totalWins * 100).toFixed(1)}% | evolution ${(agg.winnerClass.evolution / totalWins * 100).toFixed(1)}% | violation ${(agg.winnerClass.violation / totalWins * 100).toFixed(1)}% | hard ${(agg.winnerClass.hard / totalWins * 100).toFixed(1)}%`);
  console.log(`violating idea reaches hackathon:  ${p100(agg.advancesViolation).toFixed(1)} / 100 arenas`);
  console.log(`violations submitted: ${p100(agg.violationsSubmitted).toFixed(1)} | dups (R6): ${p100(agg.dupsSubmitted).toFixed(1)} | recidivist agents: ${(agg.recidivistAgents / N_TRIALS / N_EVENTS).toFixed(2)}/arena`);
  console.log(`evolution lane used: ${p100(agg.evolutionLaneUsed).toFixed(1)}% | privilege lost: ${(agg.privilegeLostEvents / N_TRIALS / N_EVENTS).toFixed(2)}/arena`);
  console.log(`avg top-2 novelty: ${(agg.top2NoveltyTotal / N_TRIALS / N_EVENTS / 2).toFixed(3)} | ties at top: ${(agg.tiesAtTopTotal / N_TRIALS / N_EVENTS).toFixed(2)} | runoff coin flips: ${p100(agg.coinFlips).toFixed(1)} / 100`);
  console.log(`FAIRNESS: top winner share ${topShare.toFixed(1)}% | distinct winners ${distinctWinners}/${N_AGENTS} agents`);
}

console.log("v3 Code of Conduct — R1 quota, R2-5 detection/ladder/credit, R6 convergence, R8 tie-break");
console.log("==============================================================================================");
run("S1 blind baseline (today's arena)", 1101, false, false);
run("S2 v3 full conduct + tie-break", 2202, true, true);
run("S3 v3 without tie-break (R8 isolated)", 3303, true, false);
OFFENDERS = 4;
console.log("\n--- stress: 4 repeat offenders ---");
run("S4 offenders", 4404, true, true);
OFFENDERS = 0;
CYCLERS = 4;
console.log("\n--- stress: 4 decay-riding cyclers (violate every other arena) ---");
run("S5 cyclers", 5505, true, true);
CYCLERS = 0;
CONVERGENCE = 1.0;
console.log("\n--- stress: maximum convergence (EchoPlex world, every pair can converge) ---");
run("S6 convergence world", 6606, true, true);
CONVERGENCE = 0.4;
P_RECYCLE = 0.9;
console.log("\n--- stress: recycle-heavy field (p=0.9) ---");
run("S7 recycle-heavy", 7707, true, true);
P_RECYCLE = 0.5;