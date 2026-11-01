#!/usr/bin/env node
/**
 * Semantic inter-rater agreement (R-3, 2026-11-01).
 *
 * Compares two independent review files produced from the same semantic sample.
 * It exists because the first sample was one reviewer, one pass: without a
 * second opinion there is no way to tell a stable judgement from a confident
 * idiosyncrasy. This computes exact agreement, within-one agreement (the
 * verdicts are ordinal: fail < weak < pass), Cohen's kappa and quadratic
 * weighted kappa.
 *
 * It is a reliability report, not a gate. Ten items are too few for a stable
 * kappa, and two models are not a human panel. The output says so.
 *
 * Usage:
 *   node scripts/semantic_agreement.mjs --a=review-a.json --b=review-b.json
 *        [--sample=sample.json] [--out=docs/SEMANTIC_INTERRATER.md] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY, cohenKappa, agreementBand } from "./lib/agreement.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const jsonOut = args.includes("--json");
const aPath = option("a", null);
const bPath = option("b", null);
const samplePath = option("sample", null);
const outPath = option("out", null);

if (args.includes("--help") || args.includes("-h") || !aPath || !bPath) {
  console.log(
    "Usage: node scripts/semantic_agreement.mjs --a=review-a.json --b=review-b.json [--sample=sample.json] [--out=path] [--json]",
  );
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}

const load = (file) => JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8"));
const a = load(aPath);
const b = load(bPath);
const sample = samplePath ? load(samplePath) : null;
const titles = new Map((sample?.ideas ?? []).map((idea) => [idea.id, idea.title]));

const verdictsA = new Map((a.verdicts ?? []).map((v) => [v.id, v]));
const verdictsB = new Map((b.verdicts ?? []).map((v) => [v.id, v]));
const ids = [...verdictsA.keys()].filter((id) => verdictsB.has(id)).sort();
const onlyA = [...verdictsA.keys()].filter((id) => !verdictsB.has(id));
const onlyB = [...verdictsB.keys()].filter((id) => !verdictsA.has(id));

if (!ids.length) {
  console.error("The two review files have no idea ids in common.");
  process.exit(1);
}
if (onlyA.length || onlyB.length) {
  console.error(`Coverage mismatch: only A=${onlyA.length}, only B=${onlyB.length}. Compare complete reviews only.`);
  process.exit(1);
}

const CRITERIA = [
  ["specific_problem", "Specific problem"],
  ["differentiated", "Differentiated solution"],
  ["build_scope", "Realistic build scope"],
  ["research_evidence", "Research evidence"],
  ["overall", "Overall"],
];
const value = (verdict, field) => {
  const index = CATEGORY.indexOf(verdict[field]);
  if (index < 0) throw new Error(`Unknown ${field} verdict: ${verdict[field]}`);
  return index;
};

const criterionRows = CRITERIA.map(([field, label]) => {
  const pairs = ids.map((id) => [value(verdictsA.get(id), field), value(verdictsB.get(id), field)]);
  const exact = pairs.filter(([x, y]) => x === y).length;
  const withinOne = pairs.filter(([x, y]) => Math.abs(x - y) <= 1).length;
  const stats = cohenKappa(pairs, false);
  return {
    field,
    label,
    exact,
    within_one: withinOne,
    kappa: stats.unweighted,
    band: agreementBand(stats.unweighted),
    n: ids.length,
  };
});

const overallPairs = ids.map((id) => [value(verdictsA.get(id), "overall"), value(verdictsB.get(id), "overall")]);
const overallStats = cohenKappa(overallPairs, false);
const weightedStats = cohenKappa(overallPairs, true);
const overallExact = overallPairs.filter(([x, y]) => x === y).length;

const disagreements = ids
  .map((id) => ({
    id,
    title: titles.get(id) ?? id,
    a: verdictsA.get(id).overall,
    b: verdictsB.get(id).overall,
    a_note: verdictsA.get(id).note ?? "",
    b_note: verdictsB.get(id).note ?? "",
  }))
  .filter((row) => row.a !== row.b);

const counts = (verdicts, field) => {
  const out = { pass: 0, weak: 0, fail: 0 };
  for (const v of verdicts) if (v[field] in out) out[v[field]] += 1;
  return out;
};

const report = {
  generated_at: new Date().toISOString(),
  event: a.event ?? b.event ?? null,
  reviewers: { a: a.reviewer ?? "A", b: b.reviewer ?? "B" },
  n: ids.length,
  overall: {
    exact: overallExact,
    agreement: overallExact / ids.length,
    kappa: overallStats.unweighted,
    kappa_band: agreementBand(overallStats.unweighted),
    quadratic_weighted_kappa: weightedStats.quadratic,
    weighted_band: agreementBand(weightedStats.quadratic),
  },
  criteria: criterionRows,
  counts: { a: counts([...verdictsA.values()], "overall"), b: counts([...verdictsB.values()], "overall") },
  disagreements,
  caveat:
    "Small deterministic sample and two AI reviewers, not a human panel. This is a reliability check for a tripwire, not a calibrated score or a gate. Kappa is unstable at this n.",
};

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const fmt = (x) => (x === null || x === undefined ? "—" : x.toFixed(3));
const lines = [];
lines.push(`# Semantic inter-rater agreement — ${report.event?.id ?? "unknown event"}`);
lines.push("");
lines.push(`Generated ${report.generated_at}. Reviewers: **${report.reviewers.a}** vs **${report.reviewers.b}**.`);
lines.push("");
lines.push(`Sample: **${ids.length}** idea(s). Overall verdicts: A=${JSON.stringify(report.counts.a)}, B=${JSON.stringify(report.counts.b)}.`);
lines.push("");
lines.push("## Agreement");
lines.push("");
lines.push("| criterion | exact | within one | Cohen's κ | band |");
lines.push("|---|---|---|---|---|");
for (const row of criterionRows) {
  lines.push(
    `| ${row.label} | ${row.exact}/${row.n} (${pct(row.exact / row.n)}) | ${row.within_one}/${row.n} (${pct(row.within_one / row.n)}) | ${fmt(row.kappa)} | ${row.band} |`,
  );
}
lines.push("");
lines.push(
  `**Overall:** ${overallExact}/${ids.length} exact (${pct(overallExact / ids.length)}), ` +
    `κ=${fmt(overallStats.unweighted)} (${agreementBand(overallStats.unweighted)}), ` +
    `quadratic weighted κ=${fmt(weightedStats.quadratic)} (${agreementBand(weightedStats.quadratic)}).`,
);
lines.push("");
lines.push("## Overall disagreements");
lines.push("");
if (!disagreements.length) {
  lines.push("None. The two reviewers agreed on every overall verdict.");
} else {
  lines.push("| idea | A | B | A note | B note |");
  lines.push("|---|---|---|---|---|");
  for (const row of disagreements) {
    const clean = (text) => String(text).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 220);
    lines.push(`| ${clean(row.title)} | ${row.a} | ${row.b} | ${clean(row.a_note)} | ${clean(row.b_note)} |`);
  }
}
lines.push("");
lines.push("## Reading this");
lines.push("");
lines.push(report.caveat);
lines.push("");
lines.push(
  "A low kappa means the sample should stay a warning-only tripwire and should not become a gate or a score. " +
    "A high kappa on ten items is encouraging but still not calibration. The next step for real confidence is a third, human reviewer on the same sheet.",
);
lines.push("");

const markdown = lines.join("\n");
if (outPath) {
  const target = path.resolve(root, outPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown, "utf8");
  console.log(`Wrote agreement report to ${target}`);
} else {
  console.log(markdown);
}
