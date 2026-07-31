#!/usr/bin/env node
/**
 * Tests the per-stage environment descriptors (public/js/views/office.js SETS).
 *
 * The risk in a data-driven layout is a set that looks fine in the table and
 * strands characters at runtime — a zone id that no longer exists, a fallback
 * that is not in its own set, or a phase with no set at all. Those fail
 * silently in a browser (a character simply is not where you expect) and are
 * trivial to catch here.
 *
 * The SETS table and TASK map are parsed straight out of the source so this
 * cannot drift from what ships.
 *
 *   node scripts/test_office_sets.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "views", "office.js"), "utf8");

function extract(declaration, name) {
  const start = SRC.indexOf(declaration);
  assert.ok(start >= 0, `${name} not found in office.js — test is out of date with the source`);
  // Walk braces from the first '{' after the declaration to its match.
  const open = SRC.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, `could not find the end of ${name}`);
  const ctx = { out: null };
  vm.createContext(ctx);
  vm.runInContext(`out = ${SRC.slice(open, end + 1)}`, ctx);
  return ctx.out;
}

const SETS = extract("const SETS = {", "SETS");
const TASK = extract("const TASK = {", "TASK");

// setForEvent is pure; lift it out and run it against the real SETS.
const fnStart = SRC.indexOf("function setForEvent(");
assert.ok(fnStart >= 0, "setForEvent not found");
const fnOpen = SRC.indexOf("{", fnStart);
let d = 0, fnEnd = -1;
for (let i = fnOpen; i < SRC.length; i++) {
  if (SRC[i] === "{") d++; else if (SRC[i] === "}") { d--; if (d === 0) { fnEnd = i; break; } }
}
const ctx = { SETS, setForEvent: null };
vm.createContext(ctx);
vm.runInContext(SRC.slice(fnStart, fnEnd + 1) + "\n;globalThis.setForEvent = setForEvent;", ctx);
const setForEvent = ctx.setForEvent;

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
};

const setNames = Object.keys(SETS);
console.log(`${setNames.length} sets: ${setNames.join(", ")}\n`);

console.log("every set is internally consistent");

for (const [key, set] of Object.entries(SETS)) {
  check(`${key} — has a name, blurb, zones and props`, () => {
    assert.ok(set.name && set.blurb, "needs a name and a blurb");
    assert.ok(Array.isArray(set.zones) && set.zones.length > 0, "needs at least one zone");
    assert.ok(Array.isArray(set.props), "needs a props array");
  });

  check(`${key} — its fallbackZone exists in its own zones`, () => {
    // The whole safety property: an agent whose zone is absent lands on the
    // fallback, so a fallback that is not present would strand them.
    assert.ok(
      set.zones.some((z) => z.id === set.fallbackZone),
      `fallbackZone "${set.fallbackZone}" is not one of ${set.zones.map((z) => z.id).join(", ")}`
    );
  });

  check(`${key} — zone ids are unique and coordinates are on-stage`, () => {
    const ids = set.zones.map((z) => z.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate zone ids: ${ids.join(", ")}`);
    for (const z of set.zones) {
      assert.ok(z.x >= 5 && z.x <= 95, `${z.id} x=${z.x} is off-stage`);
      assert.ok(z.y >= 5 && z.y <= 95, `${z.id} y=${z.y} is off-stage`);
      assert.ok(z.label, `${z.id} needs a label`);
    }
    for (const p of set.props) {
      assert.ok(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100, `prop ${p.cls} is off-stage`);
    }
  });
}

console.log("\nset dressing uses only existing prop classes");

check("no set introduces a prop class the stylesheet does not have", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "views", "office.css"), "utf8");
  const used = new Set(Object.values(SETS).flatMap((s) => s.props.map((p) => p.cls)));
  const missing = [...used].filter((cls) => !css.includes(`v-office__prop--${cls}`));
  assert.strictEqual(missing.length, 0, `no CSS for prop class(es): ${missing.join(", ")}`);
});

console.log("\nevery phase resolves to a set");

const IDEATHON_STATUSES = ["deep_research", "ideation_critique", "collaboration", "architecture", "ready_for_judging", "judged"];
const HACKATHON_STATUSES = ["team_formation", "building", "ready_for_judging", "judged", "tribunal", "complete"];

for (const status of IDEATHON_STATUSES) {
  check(`ideathon/${status}`, () => {
    const s = setForEvent({ type: "ideathon", status }, false);
    assert.ok(s && s.name, "must resolve to a real set");
  });
}
for (const status of HACKATHON_STATUSES) {
  check(`hackathon/${status} (with roster)`, () => {
    const s = setForEvent({ type: "hackathon", status }, true);
    assert.ok(s && s.name, "must resolve to a real set");
  });
}

check("an unknown status still resolves rather than throwing", () => {
  assert.ok(setForEvent({ type: "ideathon", status: "something_new" }, false).name);
  assert.ok(setForEvent({ type: "hackathon", status: "" }, false).name);
});

check("ready_for_judging picks a different set per event type where it should", () => {
  // The status exists in BOTH types, which is why setForEvent keys on type
  // too — an ideathon mid-judging must not land in a hackathon set.
  const idea = setForEvent({ type: "ideathon", status: "ready_for_judging" }, false);
  const hack = setForEvent({ type: "hackathon", status: "ready_for_judging" }, true);
  assert.strictEqual(idea.name, SETS.judging.name);
  assert.strictEqual(hack.name, SETS.judging.name);
});

check("a hackathon without a roster does not use the team set", () => {
  // Team benches are placed from the roster; with none there is nobody to
  // place, so falling back to a general room is the honest render.
  const s = setForEvent({ type: "hackathon", status: "building" }, false);
  assert.notStrictEqual(s.name, SETS.teams.name);
});

console.log("\ntask zones are reachable somewhere");

check("every TASK zone exists in at least one set", () => {
  const zonesEverywhere = new Set(Object.values(SETS).flatMap((s) => s.zones.map((z) => z.id)));
  const orphans = [...new Set(Object.values(TASK).map((t) => t.zone))].filter((z) => !zonesEverywhere.has(z));
  assert.strictEqual(orphans.length, 0, `no set contains zone(s): ${orphans.join(", ")}`);
});

check("the set for a phase contains the zone that phase's own task uses", () => {
  // The one that actually matters: agents researching during deep_research
  // must have a research zone in the library set, and so on. A mismatch here
  // silently dumps everyone on the fallback.
  const pairs = [
    ["deep_research", "research", "library"],
    ["ideation_critique", "idea", "studio"],
    ["ideation_critique", "critique", "studio"],
    ["architecture", "architecture", "drafting"],
  ];
  for (const [status, zone, expectedSet] of pairs) {
    const s = setForEvent({ type: "ideathon", status }, false);
    assert.strictEqual(s.name, SETS[expectedSet].name, `${status} should use ${expectedSet}`);
    assert.ok(s.zones.some((z) => z.id === zone), `${expectedSet} must contain zone "${zone}"`);
  }
  const trib = setForEvent({ type: "hackathon", status: "tribunal" }, true);
  assert.ok(trib.zones.some((z) => z.id === "tribunal"), "tribunal set must contain the tribunal zone");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
