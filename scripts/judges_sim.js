#!/usr/bin/env node
/**
 * judges_sim.js — judge METHOD simulation (spec §13 mechanics).
 *
 * Ground truth from src/judges/personas.ts:
 *   Mason  Technical Feasibility  0.20/0.20
 *   Nora   Market Viability       0.20/0.15
 *   Owen   Novelty                0.20/0.10
 *   Piper  Ethics & Impact        0.15/0.10
 *   Quinn  Narrative Clarity      0.15/0.10
 *   Reed   Code Quality           0.05/0.20
 *   Sage   UX & Accessibility     0.05/0.15
 *
 * Current mechanics (src/judges/scoring.ts): each judge scores ONE
 * criterion, independently, in parallel, blind to the other judges; the
 * total is the weight-sum. No deliberation exists anywhere.
 *
 * The question this sim answers: does individual judging (current) beat
 * collective judging — and when? Methods:
 *   M1  independent (current)
 *   M1e independent, equal weights (persona weights removed)
 *   M1d independent + de-inflation (per-judge systematic offset removed,
 *       as calibration could do — spec §13 calibration extension)
 *   M2  Delphi 2-round (judges revise toward the group mean, alpha=0.3)
 *   M3  groupthink deliberation (alpha=0.8)
 *   M4  panel consensus (ONE call per idea, collective score)
 *
 * Worlds: W1 = independent judge noises (textbook). W2 = shared model bias
 * (reality: all 7 judges are the SAME model on the SAME provider — their
 * errors correlate, e.g. fluency/polish preference).
 *
 * Truth is known here, so we can measure what the real arena cannot:
 * winner hit rate, top-2 hit rate, fidelity (corr), and LLM call cost.
 *
 * Run: node scripts/judges_sim.js
 */

const N_AGENTS = 12;
const IDEAS_PER_AGENT = 3;
const N_EVENTS = 40;
const N_TRIALS = 300;
const JUDGES = [
  { name: "Mason", w: 0.20, bias: 0.1 },   // personality: lenient on feasibility
  { name: "Nora", w: 0.20, bias: -0.2 },   // harsh on market
  { name: "Owen", w: 0.20, bias: 0.3 },    // generous on novelty
  { name: "Piper", w: 0.15, bias: -0.1 },
  { name: "Quinn", w: 0.15, bias: 0.0 },
  { name: "Reed", w: 0.05, bias: -0.3 },   // code quality nitpicker
  { name: "Sage", w: 0.05, bias: 0.2 },
];
const NOISE_SD = 0.35;          // per-judge noise (scaled to 0-10 scores)
const INFLATION = 1.8;          // score = 10*q + inflation + bias + noise
const SHARED_BIAS_SD = 0.4;     // W2: model-level shared bias (correlated errors)
const QUALITY_CORRELATION = 0.55; // ideas good on one criterion tend to be good on others

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

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

function runTrial(seed, method, world) {
  const r = rng(seed);
  const stats = { winnerHit: 0, top2Hit: 0, fidelity: 0, tiesAtTop: 0, callsPerIdea: 0 };

  for (let ev = 0; ev < N_EVENTS; ev++) {
    const ideas = [];
    for (let a = 0; a < N_AGENTS; a++) {
      for (let k = 0; k < IDEAS_PER_AGENT; k++) {
        const latent = gauss(r);                    // shared idea-factor
        const q = JUDGES.map(() => 0.5 + 0.4 * (QUALITY_CORRELATION * latent + (1 - QUALITY_CORRELATION) * gauss(r)));
        ideas.push({ q, trueTotal: JUDGES.reduce((s, j, i) => s + j.w * q[i], 0) });
      }
    }
    const trueRank = ideas.slice().sort((x, y) => y.trueTotal - x.trueTotal);

    const shared = world === "shared" ? gauss(r) * SHARED_BIAS_SD : 0;
    const judgeObserved = ideas.map((idea) => {
      const obs = JUDGES.map((j, i) => {
        const own = 10 * idea.q[i] + INFLATION + j.bias + gauss(r) * NOISE_SD;
        const model = shared + gauss(r) * NOISE_SD * (world === "shared" ? 1 : 0.2);
        return Math.max(0, Math.min(10, own + model));
      });
      return obs;
    });

    let totals;
    let calls = JUDGES.length;
    if (method === "independent") {
      totals = judgeObserved.map((obs) => JUDGES.reduce((s, j, i) => s + j.w * obs[i], 0));
    } else if (method === "equal") {
      totals = judgeObserved.map((obs) => obs.reduce((a, b) => a + b, 0) / JUDGES.length);
    } else if (method === "deflate") {
      totals = judgeObserved.map((obs) => JUDGES.reduce((s, j, i) => s + j.w * (obs[i] - j.bias), 0));
    } else if (method === "delphi03" || method === "delphi08") {
      const alpha = method === "delphi03" ? 0.3 : 0.8;
      calls = JUDGES.length * 2;
      totals = judgeObserved.map((obs) => {
        const r1 = JUDGES.reduce((s, j, i) => s + j.w * obs[i], 0);
        const revised = JUDGES.map((j, i) => obs[i] + alpha * (r1 - obs[i]));
        return JUDGES.reduce((s, j, i) => s + j.w * revised[i], 0);
      });
    } else if (method === "panel") {
      calls = 1;
      const panelNoise = gauss(r) * NOISE_SD;
      const panelBias = world === "shared" ? shared + 0.15 : 0.1;
      totals = ideas.map((idea, idx) => {
        const consensus = 10 * idea.trueTotal + INFLATION + panelBias + panelNoise + gauss(r) * NOISE_SD * 0.3;
        return Math.max(0, Math.min(10, consensus));
      });
    }

    const judged = ideas.map((idea, i) => ({ idea, total: totals[i], rounded: Math.round(totals[i] * 100) / 100 }));
    judged.sort((x, y) => y.total - x.total);

    const trueTop2 = new Set([trueRank[0], trueRank[1]]);
    const judgedTop2 = [judged[0].idea, judged[1].idea];
    if (judgedTop2[0] === trueRank[0]) stats.winnerHit++;
    const hits = judgedTop2.filter((x) => trueTop2.has(x)).length;
    if (hits === 2) stats.top2Hit++;

    let tiesAtTop = 1;
    while (tiesAtTop < judged.length && judged[tiesAtTop].rounded === judged[0].rounded) tiesAtTop++;
    stats.tiesAtTop += tiesAtTop;

    const totalByIdea = new Map(judged.map((j) => [j.idea, j.total]));
    stats.fidelity += pearson(ideas.map((x) => x.trueTotal), ideas.map((x) => totalByIdea.get(x)));
    stats.callsPerIdea += calls;
  }
  stats.callsPerIdea /= N_EVENTS;
  return stats;
}

function run(label, seed, method, world) {
  const agg = { winnerHit: 0, top2Hit: 0, fidelity: 0, tiesAtTop: 0, callsPerIdea: 0 };
  for (let t = 0; t < N_TRIALS; t++) {
    const s = runTrial(seed + t * 7919, method, world);
    for (const k of Object.keys(s)) agg[k] += s[k];
  }
  const per = (v) => (v / N_TRIALS / N_EVENTS) * 100;
  const calls = agg.callsPerIdea / N_TRIALS;
  console.log(`  winner-hit ${per(agg.winnerHit).toFixed(1)}% | top2-hit ${per(agg.top2Hit).toFixed(1)}% | fidelity ${(agg.fidelity / N_TRIALS / N_EVENTS).toFixed(3)} | ties-at-top ${(agg.tiesAtTop / N_TRIALS / N_EVENTS).toFixed(2)} | LLM calls/idea ${calls.toFixed(1)}`);
}

console.log("Judge-method simulation (truth known) — individual vs collective judging");
console.log("==========================================================================");
for (const [wlabel, world] of [["W1 independent-noise field", "indep"], ["W2 shared model bias (all judges same model)", "shared"]]) {
  console.log(`\n--- ${wlabel} ---`);
  console.log("M1  independent (current):");
  run("M1", 101, "independent", world);
  console.log("M1e independent, equal weights (personas removed):");
  run("M1e", 102, "equal", world);
  console.log("M1d independent + de-inflation (per-judge offsets removed):");
  run("M1d", 103, "deflate", world);
  console.log("M2  Delphi 2-round (revise toward group mean, alpha=0.3):");
  run("M2", 104, "delphi03", world);
  console.log("M3  groupthink deliberation (alpha=0.8):");
  run("M3", 105, "delphi08", world);
  console.log("M4  panel consensus (one call per idea):");
  run("M4", 106, "panel", world);
}
