#!/usr/bin/env node
/**
 * arena_full_sim.js — WHOLE-ARENA lifecycle simulation.
 *
 * Models the complete arena end to end, truth known at every stage:
 *
 *   ideation (12 agents x 3 ideas)
 *     -> conduct classification + sanctions (R1-R8: bands, quota, ladder
 *        strikes, evolution credit, convergence dup priority)
 *     -> ideathon judging (7 judges, individual + parallel, persona weights,
 *        inflation/bias/noise — mirrors src/judges/scoring.ts)
 *     -> advancement (0.90 distinctness filter, runoff N-3, R8 tie-break)
 *     -> hackathon (2 teams, 4 build turns with per-turn success, team
 *        judging with hackathon weights, final = 0.3*ideathon + 0.7*hackathon)
 *     -> winner
 *
 * Scenarios answer whole-arena questions the partial sims couldn't:
 *   A1 live baseline (no conduct)            A4 EchoPlex convergence w/wo conduct
 *   A2 full conduct v3 (R1-R8)               A5 decay-riding cyclers w/wo conduct
 *   A3 conduct + shared model bias           A6 flaky build pipeline w/wo conduct
 *
 * Run: node scripts/arena_full_sim.js
 */

const JUDGES = [
  { name: "Mason", criterion: "Technical Feasibility", wI: 0.20, wH: 0.20, bias: 0.1 },
  { name: "Nora", criterion: "Market Viability", wI: 0.20, wH: 0.15, bias: -0.2 },
  { name: "Owen", criterion: "Novelty", wI: 0.20, wH: 0.10, bias: 0.3 },
  { name: "Piper", criterion: "Ethics & Impact", wI: 0.15, wH: 0.10, bias: -0.1 },
  { name: "Quinn", criterion: "Narrative Clarity", wI: 0.15, wH: 0.10, bias: 0.0 },
  { name: "Reed", criterion: "Code Quality", wI: 0.05, wH: 0.20, bias: -0.3 },
  { name: "Sage", criterion: "UX & Accessibility", wI: 0.05, wH: 0.15, bias: 0.2 },
];

const N_AGENTS = 12;
const IDEAS_PER_AGENT = 3;
const BUILD_TURNS = 4;
const N_ARENAS = 200;

const INFLATION = 1.2;               // per-judge: 8.5*q + 1.2 + bias + noise -> live 6.0-9.0 spread,
                                     // top ideas saturate 10 only rarely (measured live, not guessed)
const SCORE_SCALE = 8.5;             // live judges give 9s, not 10s, to great ideas
const NOISE_SD = 0.35;
const SHARED_BIAS_SD = 0.4;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.90;
const RUNOFF_MARGIN = 0.5;

const BAND = { fresh: 0.80, evolution: 0.90, hard: 0.95 };       // R3
const PENALTY = { violationFirst: -2.0, violationRepeat: -3.0, dup: -1.0, hard: -2.0 };
const EVOLUTION_CREDIT = 0.05;                                    // R5
const COLLAB_BONUS = 0.5;                                         // N-1 merge
const PRIVILEGE_STRIKE_LIMIT = 3;

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

const clip01 = (x) => Math.max(0.05, Math.min(0.95, x));
const clampScore = (x) => Math.min(10, x);

const FRESH_SIM = [0.55, 0.72];
const EVOLUTION_SIM = [0.82, 0.88];
const VIOLATION_SIM = [0.91, 0.97];
const DERIVED_QUALITY_DISCOUNT = 0.06; // derivation is a shortcut: slightly worse ideas
const uni = (r, [lo, hi]) => lo + (hi - lo) * r();

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** One full arena. `arenaIndex` lets decay-riders alternate clean/violating. */
function runArena(seed, arenaIndex, config) {
  const r = rng(seed);
  const { conduct, world, field, shared, flaky } = config;

  // ---- Phase 1: ideation -------------------------------------------------
  const agents = [];
  for (let a = 0; a < N_AGENTS; a++) {
    agents.push({ id: a, skill: clip01(0.7 + 0.15 * gauss(r)), strikes: 0, privilegeLost: false });
  }
  const roles = ["fresh", "fresh", "fresh", "fresh", "fresh", "fresh", "fresh", "honest", "honest", "honest", "violator", "violator"];
  if (field === "cyclers") roles[10] = "cycler", roles[11] = "cycler";

  const roleOf = (agent, k) => {
    const role = roles[agent.id];
    if (role === "cycler") return arenaIndex % 2 === 0 ? "violator" : "fresh";
    return role;
  };

  const ideas = [];
  for (const agent of agents) {
    for (let k = 0; k < IDEAS_PER_AGENT; k++) {
      const latent = gauss(r);
      const role = roleOf(agent, k);
      // Shortcut discount applies ONLY to violations: honest evolution is
      // deliberate refinement (same effort as fresh). In EchoPlex every idea
      // after the first is a cheap copy of the originator (order 0 = the
      // legal base-material reuse everything converges on).
      const discount = (role === "violator" || (world === "echoplex" && ideas.length > 0)) ? DERIVED_QUALITY_DISCOUNT : 0;
      // Quality model: a shared latent plus per-criterion strengths, so the
      // two best ideas are DIFFERENTLY strong (cosine ~0.6, matching live
      // embedding measurements 0.586-0.742 for distinct ideas) — not
      // near-duplicates the 0.90 distinctness filter must drop.
      const q = JUDGES.map(() => clip01(0.2 + 0.25 * latent + 0.3 * gauss(r) + 0.25 * agent.skill - discount));
      ideas.push({
        id: `i${ideas.length}`, agent, k, q,
        trueTotal: JUDGES.reduce((s, j, i) => s + j.wI * q[i], 0),
        variance: JUDGES.reduce((s, j, i) => s + (q[i] - JUDGES.reduce((t, _, m) => t + q[m], 0) / 7) ** 2, 0) / 7,
        order: ideas.length,
      });
    }
  }

  // ---- Conduct classification + sanctions (at submission, R1-R8) ---------
  const classified = new Map(ideas.map((x) => [x, {
    simToPrior: 0.55, cls: "fresh", penalty: 0, strikeGained: 0, credited: false,
    submitted: false, blocked: false, judged: 0,
  }]));

  const roleOfAgent = (agent, k) => {
    const role = roles[agent.id];
    if (role === "cycler") return arenaIndex % 2 === 0 ? "violator" : "fresh";
    return role;
  };

  for (const idea of ideas) {
    const agent = idea.agent;
    const meta = classified.get(idea);
    if (agent.privilegeLost) { meta.blocked = true; continue; }
    meta.submitted = true;

    // R6: same-arena convergence to an EARLIER submission -> dup (no strike).
    // The very first idea is the convergence originator (legal base-material
    // reuse, R2) — only later near-identical submissions are dups.
    if (world === "echoplex" && conduct) {
      if (idea.order > 0) {
        meta.simToPrior = clip01(0.90 + 0.05 * Math.abs(gauss(r)));
        meta.cls = "dup";
        meta.penalty = PENALTY.dup;
        continue;
      }
      meta.simToPrior = uni(r, FRESH_SIM);
      meta.cls = "fresh";
      continue;
    }

    const role = roleOfAgent(agent, idea.k);
    meta.simToPrior = world === "echoplex"
      ? clip01(0.90 + 0.05 * Math.abs(gauss(r)))
      : role === "violator" ? uni(r, VIOLATION_SIM)
      : role === "honest" && idea.k === 0 ? uni(r, EVOLUTION_SIM)
      : uni(r, FRESH_SIM);

    if (conduct) {
      const s = meta.simToPrior;
      if (s >= BAND.hard) {
        meta.cls = "hard"; meta.penalty = PENALTY.hard; meta.strikeGained = 2;
      } else if (s > BAND.evolution) {
        meta.cls = "violation";
        meta.penalty = agent.strikes > 0 ? PENALTY.violationRepeat : PENALTY.violationFirst;
        meta.strikeGained = 1;
      } else if (s >= BAND.fresh) {
        // R3 evolution band is 0.80-0.90: s >= 0.90 already matched the
        // violation branch above, so >= fresh means exactly the 0.80-0.90 band.
        meta.cls = "evolution";
        if (role === "honest" && idea.k === 0) { meta.credited = true; meta.penalty = EVOLUTION_CREDIT; }
      }
      if (meta.strikeGained) {
        agent.strikes += meta.strikeGained;
        if (agent.strikes >= PRIVILEGE_STRIKE_LIMIT) agent.privilegeLost = true;
      }
      // R1 quota: >1 derived idea in the batch -> excess gets a soft strike
      const derivedSoFar = ideas.filter((x) => x.agent === agent && classified.get(x).submitted && classified.get(x).cls !== "fresh" && classified.get(x).cls !== "blocked").length;
      if (derivedSoFar > 1 && meta.cls !== "fresh" && meta.cls !== "dup" && meta.strikeGained === 0) {
        meta.penalty += -1.0; meta.strikeGained = 1; agent.strikes += 1;
        if (agent.strikes >= PRIVILEGE_STRIKE_LIMIT) agent.privilegeLost = true;
      }
    }
  }

  // N-1 merge: evolution-classed ideas pair up across agents -> collaboration bonus
  const evolutions = [...ideas].filter((x) => classified.get(x).cls === "evolution");
  for (let i = 0; i + 1 < evolutions.length; i += 2) {
    if (evolutions[i].agent.id !== evolutions[i + 1].agent.id) {
      classified.get(evolutions[i]).penalty += COLLAB_BONUS;
      classified.get(evolutions[i + 1]).penalty += COLLAB_BONUS;
    }
  }

  // ---- Phase 2: ideathon judging (7 judges, individual, parallel) --------
  const sharedBias = shared ? gauss(r) * SHARED_BIAS_SD : 0;
  for (const idea of ideas) {
    const meta = classified.get(idea);
    if (!meta.submitted) continue;
    let total = 0;
    for (const j of JUDGES) {
      total += j.wI * Math.max(0, Math.min(10, SCORE_SCALE * idea.q[JUDGES.indexOf(j)] + INFLATION + j.bias + gauss(r) * NOISE_SD + sharedBias));
    }
    // Round to 2dp like the stored/displayed score — exact ties at this
    // precision are what R8 resolves deterministically.
    meta.judged = clampScore(Math.round((total + (conduct ? meta.penalty : 0)) * 100) / 100);
  }

  // ---- Phase 3: advancement (distinctness, runoff N-3, R8 tie-break) -----
  const eligible = ideas.filter((x) => {
    const m = classified.get(x);
    return m.submitted && m.cls !== "blocked" && (conduct ? m.cls !== "hard" : true);
  });
  eligible.sort((a, b) => {
    const ma = classified.get(a), mb = classified.get(b);
    if (mb.judged !== ma.judged) return mb.judged - ma.judged;
    if (conduct) {
      // R8: exact ties -> lower sim -> fewer strikes -> earlier submission
      if (ma.simToPrior !== mb.simToPrior) return ma.simToPrior - mb.simToPrior;
      if (a.agent.strikes !== b.agent.strikes) return a.agent.strikes - b.agent.strikes;
    }
    return a.order - b.order;
  });

  // Pairwise similarity = cosine of the idea vectors (the real system uses
  // embedding cosine similarity — Vectorize), independent of conduct sim.
  const pairwiseSim = (a, b) => clip01(cosineSim(a.q, b.q));

  const distinct = (candidate, picked) => picked.every((p) => pairwiseSim(candidate, p) < DUPLICATE_SIMILARITY_THRESHOLD);

  const picked = [];
  for (const c of eligible) {
    if (picked.length === 2) break;
    if (distinct(c, picked)) picked.push(c);
  }
  if (picked.length < 2) picked.push(...eligible.filter((c) => !picked.includes(c)).slice(0, 2 - picked.length));

  // Runoff N-3: challenger within margin of the 2nd slot, distinct from winner.
  // The verdict is a pairwise judge call (both orderings) — informative, not
  // a coin: the challenger wins in proportion to its true-quality edge.
  const runnerUp = picked[1];
  const challenger = eligible.find((c) => !picked.includes(c));
  if (challenger && runnerUp) {
    const gap = classified.get(runnerUp).judged - classified.get(challenger).judged;
    if (gap <= RUNOFF_MARGIN && distinct(challenger, [picked[0]])) {
      const pPromote = clip01(0.5 + (challenger.trueTotal - runnerUp.trueTotal) / 0.16);
      if (r() < pPromote) picked[1] = challenger;
    }
  }

  // ---- Phase 4: hackathon (2 teams, 4 build turns, hackathon judging) ----
  const teamResults = picked.map((idea, teamIdx) => {
    const meta = classified.get(idea);
    const collaborators = agents.filter((a) => a.id !== idea.agent.id).sort((a, b) => b.skill - a.skill).slice(0, 2);
    const teamSkill = (idea.agent.skill + collaborators.reduce((s, c) => s + c.skill, 0)) / 3;
    const complexity = clip01(0.3 + 0.5 * idea.variance);
    const pTurn = clip01(0.25 + 0.45 * teamSkill + 0.2 * idea.q[0] - 0.25 * complexity - (flaky ? 0.2 : 0));
    let successes = 0;
    for (let t = 0; t < BUILD_TURNS; t++) if (r() < pTurn) successes++;
    const buildEvidence = successes / BUILD_TURNS;

    const teamTrue = 0.65 * idea.trueTotal + 0.35 * buildEvidence;
    let hackTotal = 0;
    for (const j of JUDGES) {
      hackTotal += j.wH * Math.max(0, Math.min(10, SCORE_SCALE * teamTrue + INFLATION + j.bias + gauss(r) * NOISE_SD + sharedBias));
    }
    const teamScore = clampScore(Math.round(hackTotal * 100) / 100);
    return { idea, buildEvidence, teamScore, finalScore: 0.3 * meta.judged + 0.7 * teamScore, teamIdx };
  });

  teamResults.sort((a, b) => b.finalScore - a.finalScore);
  if (teamResults.length === 2) teamResults[0].idea.winner = true;

  // ---- Truth bookkeeping --------------------------------------------------
  const legal = (x) => !conduct || ["fresh", "evolution", "dup"].includes(classified.get(x).cls);
  const trueBest = ideas.reduce((best, x) => (x.trueTotal > best.trueTotal ? x : best), ideas[0]);
  const trueBestLegal = ideas.filter(legal).reduce((best, x) => (x.trueTotal > best.trueTotal ? x : best), ideas[0]);
  const trueTop2 = ideas.slice().sort((a, b) => b.trueTotal - a.trueTotal).slice(0, 2);
  const winner = teamResults[0];
  const advanced = teamResults.map((t) => t.idea);
  const out = {
    advContainsTrueBest: advanced.some((x) => x === trueBest),
    advContainsTrueBestLegal: advanced.some((x) => x === trueBestLegal),
    advExactTop2: advanced.length === 2 && advanced.every((x) => trueTop2.includes(x)),
    winnerIsTrueBest: winner && winner.idea === trueBest,
    winnerIsTrueBestLegal: winner && winner.idea === trueBestLegal,
    winnerAgentId: winner ? winner.idea.agent.id : -1,
    derivativeReach: advanced.some((x) => classified.get(x).simToPrior >= BAND.evolution),
    violationReach: advanced.some((x) => classified.get(x).cls === "violation"),
    dupReach: advanced.some((x) => classified.get(x).cls === "dup"),
    hardReach: advanced.some((x) => classified.get(x).cls === "hard"),
    evolutionReach: advanced.some((x) => classified.get(x).cls === "evolution"),
    originatorReach: advanced.some((x) => x.order === 0),
    avgBuildEvidence: advanced.reduce((s, x) => s + (picked.includes(x) ? teamResults.find((t) => t.idea === x).buildEvidence : 0), 0) / Math.max(1, advanced.length),
    tiesAtTop: picked.filter((x) => Math.abs(classified.get(x).judged - classified.get(picked[0]).judged) < 0.01).length,
  };
  return out;
}

// ---- Scenario runner ------------------------------------------------------
function runScenario(label, config) {
  const agg = {
    arenas: 0, advContains: 0, advContainsLegal: 0, advExact: 0, winnerHit: 0, winnerHitLegal: 0,
    derivativeReach: 0, violationReach: 0, dupReach: 0, hardReach: 0, evolutionReach: 0, originatorReach: 0,
    buildEvidence: 0, tiesAtTop: 0, winnerShareTop: 0,
  };
  const winsByAgent = new Array(N_AGENTS).fill(0);
  let seed = config.seed;
  for (let a = 0; a < N_ARENAS; a++) {
    const out = runArena(seed + a * 104729, a, config);
    agg.arenas++;
    if (out.advContainsTrueBest) agg.advContains++;
    if (out.advContainsTrueBestLegal) agg.advContainsLegal++;
    if (out.advExactTop2) agg.advExact++;
    if (out.winnerIsTrueBest) agg.winnerHit++;
    if (out.winnerIsTrueBestLegal) agg.winnerHitLegal++;
    if (out.derivativeReach) agg.derivativeReach++;
    if (out.violationReach) agg.violationReach++;
    if (out.dupReach) agg.dupReach++;
    if (out.hardReach) agg.hardReach++;
    if (out.evolutionReach) agg.evolutionReach++;
    if (out.originatorReach) agg.originatorReach++;
    agg.buildEvidence += out.avgBuildEvidence;
    agg.tiesAtTop += out.tiesAtTop;
    if (out.winnerAgentId >= 0) winsByAgent[out.winnerAgentId]++;
  }
  agg.tiesAtTop /= N_ARENAS;
  agg.buildEvidence /= N_ARENAS;
  agg.winnerShareTop = Math.max(...winsByAgent) / N_ARENAS;
  const p = (n) => ((n / N_ARENAS) * 100).toFixed(1);
  console.log(`\n${label}`);
  console.log(`  advance-hit ${p(agg.advContains)}% (best-legal ${p(agg.advContainsLegal)}%) | advance exact top-2 ${p(agg.advExact)}% | winner-hit ${p(agg.winnerHit)}% (best-legal ${p(agg.winnerHitLegal)}%)`);
  console.log(`  derivative->hackathon ${p(agg.derivativeReach)}% | violation->hackathon ${p(agg.violationReach)}% | hard->hackathon ${p(agg.hardReach)}% | dup->hackathon ${p(agg.dupReach)}%`);
  console.log(`  evolution lane → hackathon ${p(agg.evolutionReach)}% | originator->hackathon ${p(agg.originatorReach)}% | ties-at-top ${agg.tiesAtTop.toFixed(2)} | avg build evidence ${agg.buildEvidence.toFixed(2)} | top winner share ${(agg.winnerShareTop * 100).toFixed(1)}%`);
}

console.log("WHOLE-ARENA simulation (200 arenas each; ideathon -> judging -> advancement -> hackathon -> winner)");
console.log("==================================================================================================");

const BASE = { conduct: false, world: "standard", field: "standard", shared: false, flaky: false, seed: 5000 };
const CONDUCT = { conduct: true, world: "standard", field: "standard", shared: false, flaky: false, seed: 5000 };

runScenario("A1 live baseline — no conduct (current arena)", BASE);
runScenario("A2 conduct v3 (R1-R8)", CONDUCT);
runScenario("A3 conduct + shared model bias (all judges same model)", { ...CONDUCT, shared: true });
runScenario("A4 EchoPlex convergence — NO conduct", { ...BASE, world: "echoplex" });
runScenario("A4+ EchoPlex convergence — WITH conduct (R6)", { ...CONDUCT, world: "echoplex" });
runScenario("A5 decay-riding cyclers — NO conduct", { ...BASE, field: "cyclers" });
runScenario("A5+ decay-riding cyclers — WITH conduct", { ...CONDUCT, field: "cyclers" });
runScenario("A6 flaky build pipeline — no conduct", { ...BASE, flaky: true });
runScenario("A6+ flaky build pipeline — WITH conduct", { ...CONDUCT, flaky: true });
