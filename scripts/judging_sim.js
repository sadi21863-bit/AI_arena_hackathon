#!/usr/bin/env node
/**
 * judging_sim.js — Monte Carlo simulation of the arena's ideathon loop,
 * calibrated to live observations (2026-08-12) to predict judging failure
 * modes. Pure local arithmetic, no network, no LLM quota.
 *
 * Live calibration inputs (measured from the live worker today):
 *   - 36 ideas / event, 12 agents, ~3 ideas per agent
 *   - 9-way exact tie at 9.00 (top of leaderboard) -> discrete-score inflation
 *   - 5 of 36 ideas same family (EchoPlex x5 in one event, 14%)
 *   - EchoPlex x9 across 4 events, PainPal x6 across 3 -> cross-event recycling
 *   - 7 judges, equal weights, judge-mean raw scores 6.0-9.0
 *   - duplicate filter at 0.90 cosine, runoff margin 0.15 (spec N-3)
 *
 * Run: node scripts/judging_sim.js
 */

const N_AGENTS = 12;
const IDEAS_PER_AGENT = 3;
const N_EVENTS = 50;
const N_TRIALS = 400;
const JUDGES = 7;
const INFLATION = 1.8;          // judge-mean score = trueQuality + INFLATION
const JUDGE_OFFSET_SD = 0.35;   // per-judge inflation spread
let NOISE_SD = 0.45;            // per-judge scoring noise (discretized to 0.5)
const RUNOFF_MARGIN = 0.15;     // applyRunoff margin (spec N-3)

let RECYCLE_PROB = 0.18;        // P(agent resubmits a personal favorite)
const FAMILY_CLUSTER = 0.14;    // P(any two ideas same family) within an event
const ARCHIVE_SIMILARITY = 0.92;// recycled idea vs its archived self (embedding)
let NOVELTY_PENALTY = 0;        // score cut for ideas matching archived ones (0 = judges blind)

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

// Discrete 0.5-step judge scores — LLM judges emit coarse scales, which is
// what produced the observed 9-way tie at 9.00.
function judgeScore(r, trueQuality) {
  const s = trueQuality * 10 + INFLATION + gauss(r) * JUDGE_OFFSET_SD + gauss(r) * NOISE_SD;
  return Math.max(0, Math.min(10, Math.round(Math.max(0, s) * 2) / 2));
}

function runTrial(seed) {
  const r = rng(seed);
  const stats = {
    tiesAtTopTotal: 0,
    biggestFamilyTotal: 0,
    duplicateTeamsNoFilter: 0,
    duplicateTeamsFilter: 0,
    runoffFires: 0,
    winnerFlipsInNoise: 0,
    recycledWins: 0,
    recycledShare: 0,
    sameFamilyBackToBack: 0,
  };
  const agentFavorites = Array.from({ length: N_AGENTS }, () => []);
  let prevWinningFamily = null;

  for (let ev = 0; ev < N_EVENTS; ev++) {
    const ideas = [];   // {recycled, family, trueQuality}
    const familyOf = [];
    for (let a = 0; a < N_AGENTS; a++) {
      for (let k = 0; k < IDEAS_PER_AGENT; k++) {
        let recycled = false;
        if (agentFavorites[a].length && r() < RECYCLE_PROB) {
          const fav = agentFavorites[a][Math.floor(r() * agentFavorites[a].length)];
          ideas.push({ recycled: true, trueQuality: fav.trueQuality });
          recycled = true;
        } else {
          const q = 0.5 + 0.4 * r();
          ideas.push({ recycled: false, trueQuality: q });
          if (agentFavorites[a].length < 2) agentFavorites[a].push({ trueQuality: q });
        }
        const idx = ideas.length - 1;
        if (r() < FAMILY_CLUSTER && idx > 0) {
          familyOf[idx] = familyOf[Math.floor(r() * idx)];
        } else {
          familyOf[idx] = idx;
        }
        if (recycled) stats.recycledShare++;
      }
    }
    ideas.forEach((idea, i) => { idea.family = familyOf[i]; });

    const famCounts = {};
    familyOf.forEach((f) => { famCounts[f] = (famCounts[f] || 0) + 1; });
    const biggestFamily = Math.max(...Object.values(famCounts));
    stats.biggestFamilyTotal += biggestFamily;

    // Judged invisibly: a recycled idea scores exactly like a fresh one —
    // unless the novelty-penalty fix is on (judges given RAG recycle context).
    const scores = ideas.map((idea) => {
      let sum = 0;
      for (let j = 0; j < JUDGES; j++) sum += judgeScore(r, idea.trueQuality);
      let total = sum / JUDGES;
      if (idea.recycled) total -= NOVELTY_PENALTY * ARCHIVE_SIMILARITY;
      return { ...idea, total, rounded: Math.round(total * 100) / 100 };
    });
    scores.sort((x, y) => y.total - x.total);

    let tiesAtTop = 1;
    while (tiesAtTop < scores.length && scores[tiesAtTop].rounded === scores[0].rounded) tiesAtTop++;
    stats.tiesAtTopTotal += tiesAtTop;

    const pickDistinct = (list) => {
      const picked = [];
      for (const c of list) {
        if (picked.length === 2) break;
        const tooSimilar = picked.some((p) => c.family === p.family);
        if (!tooSimilar) picked.push(c);
      }
      if (picked.length === 2) return picked;
      return list.slice(0, 2);
    };

    const noFilter = scores.slice(0, 2);
    const withFilter = pickDistinct(scores);
    if (new Set(noFilter.map((c) => c.family)).size === 1) stats.duplicateTeamsNoFilter++;
    if (new Set(withFilter.map((c) => c.family)).size === 1) stats.duplicateTeamsFilter++;

    const runnerUp = withFilter[1];
    const challenger = scores.find((c) => !withFilter.includes(c));
    const winner = { idea: withFilter[0], viaRunoff: false };
    if (challenger && runnerUp.rounded - challenger.rounded <= RUNOFF_MARGIN) {
      stats.runoffFires++;
      winner.viaRunoff = true;
      if (runnerUp.rounded === challenger.rounded) {
        stats.winnerFlipsInNoise++; // exact tie -> runoff is a coin flip
        winner.idea = r() < 0.5 ? runnerUp : challenger;
      } else {
        winner.idea = runnerUp; // challenger can only promote on exact tie per N-3
      }
    }
    if (winner.idea.recycled) stats.recycledWins++;

    if (prevWinningFamily !== null && winner.idea.family === prevWinningFamily) stats.sameFamilyBackToBack++;
    prevWinningFamily = winner.idea.family;
  }
  return stats;
}

function run(label, seed) {
  const agg = {};
  for (let t = 0; t < N_TRIALS; t++) {
    const s = runTrial(seed + t * 7919);
    for (const k of Object.keys(s)) agg[k] = (agg[k] || 0) + s[k];
  }
  const perEvent = (v) => (v / N_TRIALS / N_EVENTS) * 100;
  console.log(`\n=== ${label}: ${N_TRIALS} trials x ${N_EVENTS} events ===`);
  console.log(`params: recycle_p=${RECYCLE_PROB} inflation=${INFLATION} noise_sd=${NOISE_SD} judge_offset_sd=${JUDGE_OFFSET_SD} runoff_margin=${RUNOFF_MARGIN}`);
  console.log("--- predicted failure modes (per event) ---");
  console.log(`avg exact-tie size at top:         ${(agg.tiesAtTopTotal / N_TRIALS / N_EVENTS).toFixed(2)} ideas`);
  console.log(`avg biggest title-family:          ${(agg.biggestFamilyTotal / N_TRIALS / N_EVENTS).toFixed(2)} ideas`);
  console.log(`P(both teams same family): no filter ${perEvent(agg.duplicateTeamsNoFilter).toFixed(1)}%   with 0.90 filter ${perEvent(agg.duplicateTeamsFilter).toFixed(1)}%`);
  console.log(`runoff fires:                      ${perEvent(agg.runoffFires).toFixed(1)}%  (of which exact-tie coin flips ${perEvent(agg.winnerFlipsInNoise).toFixed(1)}%)`);
  console.log(`recycled idea wins (invisible to judges): ${perEvent(agg.recycledWins).toFixed(1)}%  (recycled share of submissions ${((agg.recycledShare / N_TRIALS / N_EVENTS / (N_AGENTS * IDEAS_PER_AGENT)) * 100).toFixed(1)}%)`);
  console.log(`same family wins back-to-back events:    ${perEvent(agg.sameFamilyBackToBack).toFixed(1)}%`);
}

console.log("baseline (current system):");
run("baseline", 12345);
RECYCLE_PROB = 0.4;
console.log("\nscenario A: heavier recycling (agents learn favorites, p=0.4):");
run("heavy recycling", 98765);
RECYCLE_PROB = 0.18;
NOISE_SD = 0.2;
console.log("\nscenario B: sharper judges (noise sd 0.45 -> 0.2):");
run("low noise", 55555);
NOISE_SD = 0.45;
NOVELTY_PENALTY = 0.5;
console.log("\nscenario C: with novelty penalty (recycled ideas get -0.5 x archive similarity):");
// The novel-judging fix: judges receive RAG recycle context and penalize.
run("novelty penalty", 33333);
