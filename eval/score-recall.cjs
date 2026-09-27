#!/usr/bin/env node
"use strict";
// Score review outputs against the recall manifest.
// usage: score-recall.cjs <manifest.json> <results.jsonl>
// results.jsonl rows: {"arm":"v2","pr":2352,"head":"...","outputPath":".../codex-review-output.json"}
const fs = require("node:fs");

const LINE_TOLERANCE = 15;

function parseLocations(location) {
  // V4 `where` is prose naming several file:line spans; take every one.
  // Accept en/em-dash ranges, comma lists, and "the same file:N".
  const text = String(location ?? "");
  const spans = [];
  let lastFile = null;
  const range = "\\d+(?:\\s*[-\\u2013\\u2014]\\s*\\d+)?";
  const re = new RegExp("(?:([A-Za-z0-9_.\\-\\/\\[\\]@+()]+\\.[A-Za-z0-9]+)|(same file)):(" + range + "(?:\\s*,\\s*" + range + ")*)", "g");
  for (const match of text.matchAll(re)) {
    const file = match[1] ?? lastFile;
    if (!file) continue;
    lastFile = file;
    for (const part of match[3].split(",")) {
      const [start, end] = part.split(/[-\u2013\u2014]/).map((value) => Number(value.trim()));
      spans.push({ file, start, end: Number.isFinite(end) ? end : start });
    }
  }
  return spans;
}

function sameFile(anchorFile, locationFile) {
  return anchorFile === locationFile ||
    (!locationFile.includes("/") && anchorFile.endsWith("/" + locationFile));
}

// A defect may be anchored at more than one place (a bot's original anchor and
// the line the fix touched); any anchor within tolerance counts.
function defectAnchors(defect) {
  return [{ file: defect.file, line: defect.line }, ...(defect.anchors ?? [])];
}

function issueHits(issue, defect) {
  const locations = parseLocations(issue.where ?? issue.location);
  return locations.some((location) => defectAnchors(defect).some(
    (anchor) => sameFile(anchor.file, location.file) &&
      anchor.line >= location.start - LINE_TOLERANCE && anchor.line <= location.end + LINE_TOLERANCE,
  ));
}

function scoreRun(allDefects, output) {
  const issues = [
    ...(output?.new_findings ?? []),
    ...(output?.prior_issue_evaluations ?? []).filter((entry) => entry.result === "still_open")
      .map((entry) => entry.finding),
    ...(output?.state?.open_issues ?? []),
  ];
  // Excluded defects (owner policy) are not scored, but a finding on one is a
  // known finding, not an unmatched one.
  const defects = allDefects.filter((defect) => !defect.excluded);
  const hits = defects.map((defect) => ({
    id: defect.id,
    hit: issues.some((issue) => issueHits(issue, defect)),
  }));
  const unmatched = issues.filter((issue) => !allDefects.some((defect) => issueHits(issue, defect)));
  return { hits, unmatched: unmatched.map((issue) => `${issue.severity} ${issue.title} @ ${issue.where ?? issue.location}`) };
}

function main() {
  const [manifestPath, resultsPath] = process.argv.slice(2);
  if (!manifestPath || !resultsPath) {
    console.error("usage: score-recall.cjs <manifest.json> <results.jsonl>");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rows = fs.readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const arms = [...new Set(rows.map((row) => row.arm))];
  const table = [];
  const totals = Object.fromEntries(arms.map((arm) => [arm, { hit: 0, total: 0, unmatched: [] }]));
  for (const testCase of manifest.cases) {
    const scoresByArm = {};
    for (const arm of arms) {
      const sampleRows = rows.filter((candidate) => candidate.arm === arm && candidate.pr === testCase.pr && candidate.head === testCase.head);
      scoresByArm[arm] = sampleRows.map((row) => scoreRun(testCase.defects, JSON.parse(fs.readFileSync(row.outputPath, "utf8"))));
    }
    for (const defect of testCase.defects) {
      if (defect.excluded) continue;
      const cells = {};
      for (const arm of arms) {
        const scores = scoresByArm[arm];
        if (scores.length === 0) { cells[arm] = "–"; continue; }
        const hits = scores.filter((score) => score.hits.find((entry) => entry.id === defect.id)?.hit).length;
        cells[arm] = scores.length === 1 ? (hits ? "✓" : "✗") : `${hits}/${scores.length}`;
        totals[arm].total += scores.length;
        totals[arm].hit += hits;
      }
      table.push({ case: `#${testCase.pr} @ ${testCase.head.slice(0, 8)}`, defect: `${defect.id} ${defect.summary}`, ...cells });
    }
    for (const arm of arms) {
      for (const score of scoresByArm[arm]) {
        totals[arm].unmatched.push(...score.unmatched.map((entry) => `#${testCase.pr}: ${entry}`));
      }
    }
  }
  console.log(`| case | defect | ${arms.join(" | ")} |`);
  console.log(`| --- | --- | ${arms.map(() => "---").join(" | ")} |`);
  for (const row of table) console.log(`| ${row.case} | ${row.defect} | ${arms.map((arm) => row[arm]).join(" | ")} |`);
  console.log("");
  for (const arm of arms) {
    const t = totals[arm];
    console.log(`${arm}: ${t.hit}/${t.total} defect-samples found (${t.total ? Math.round((100 * t.hit) / t.total) : 0}%); ${t.unmatched.length} finding(s) outside the known set (inspect: real defect or false positive)`);
    for (const entry of t.unmatched) console.log(`  - ${entry}`);
  }
}

module.exports = { parseLocations, sameFile, issueHits, scoreRun };
if (require.main === module) main();
