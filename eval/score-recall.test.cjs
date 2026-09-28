"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreRun, parseLocations } = require("./score-recall.cjs");

test("parseLocations reads path:line and path:start-end", () => {
  assert.deepEqual(parseLocations("a/b.ts:12"), [{ file: "a/b.ts", start: 12, end: 12 }]);
  assert.deepEqual(parseLocations("a/b.ts:10-20"), [{ file: "a/b.ts", start: 10, end: 20 }]);
  assert.deepEqual(parseLocations("no line"), []);
});

test("extensionless paths score in old location and new where outputs", () => {
  const defects = [{ id: "dockerfile", file: "apps/api/Dockerfile", line: 55 }];
  for (const output of [
    { state: { open_issues: [{ location: "apps/api/Dockerfile:55" }] } },
    { new_findings: [{ where: "apps/api/Dockerfile:55" }] },
  ]) {
    assert.deepEqual(scoreRun(defects, output).hits, [{ id: "dockerfile", hit: true }]);
  }
});

test("same file after an extensionless path resolves to the previous path", () => {
  assert.deepEqual(parseLocations("apps/api/Dockerfile:55; the same file:140"), [
    { file: "apps/api/Dockerfile", start: 55, end: 55 },
    { file: "apps/api/Dockerfile", start: 140, end: 140 },
  ]);
});

test("scoreRun accepts alternate anchors", () => {
  const defects = [{ id: "E", file: "test/e.test.ts", line: 115, anchors: [{ file: "src/e.ts", line: 8 }] }];
  const output = { state: { open_issues: [{ severity: "P2", title: "x", location: "src/e.ts:8-8" }] } };
  assert.deepEqual(scoreRun(defects, output).hits, [{ id: "E", hit: true }]);
});

test("scoreRun matches by file and line tolerance and reports unmatched issues", () => {
  const defects = [
    { id: "A", file: "src/x.ts", line: 54 },
    { id: "B", file: "src/y.ts", line: 237 },
  ];
  const output = { state: { open_issues: [
    { severity: "P2", title: "near A", location: "src/x.ts:40-45" },
    { severity: "P1", title: "elsewhere", location: "src/z.ts:1" },
  ] } };
  const score = scoreRun(defects, output);
  assert.deepEqual(score.hits, [{ id: "A", hit: true }, { id: "B", hit: false }]);
  assert.deepEqual(score.unmatched, ["P1 elsewhere @ src/z.ts:1"]);
});

test("excluded defects are not scored", () => {
  const defects = [{ id: "X", file: "a.ts", line: 1, excluded: "policy" }, { id: "Y", file: "b.ts", line: 1 }];
  const score = scoreRun(defects, { state: { open_issues: [{ severity: "P2", title: "y", location: "b.ts:1" }, { severity: "P2", title: "x", location: "a.ts:1" }] } });
  assert.deepEqual(score.hits, [{ id: "Y", hit: true }]);
  assert.deepEqual(score.unmatched, [], "a finding on an excluded defect is known, not unmatched");
});

test("current output scores new findings and still-open evaluations by where", () => {
  const defects = [{ id: "N", file: "src/new.ts", line: 20 },
    { id: "P", file: "src/prior.ts", line: 30 }];
  const output = { new_findings: [{ severity: "P1", title: "new", where: "src/new.ts:20" }],
    prior_issue_evaluations: [
      { result: "still_open", finding: { severity: "P1", title: "prior", where: "src/prior.ts:30" } },
      { result: "resolved_on_target", finding: { severity: "P1", title: "closed", where: "src/other.ts:9" } },
    ] };
  assert.deepEqual(scoreRun(defects, output), { hits: [{ id: "N", hit: true }, { id: "P", hit: true }], unmatched: [] });
});

test("prose locations score every producer and consumer span", () => {
  const defects = [{ id: "producer", file: "a.ts", line: 44 },
    { id: "consumer", file: "b.ts", line: 53 }];
  const output = { new_findings: [{ severity: "P1", title: "broken handoff",
    where: "Producer: a.ts:42-46 ... Consumer: b.ts:51-54" }] };
  assert.deepEqual(scoreRun(defects, output).hits,
    [{ id: "producer", hit: true }, { id: "consumer", hit: true }]);
});

test("known anchor paths survive connective prose and retain complete filenames", () => {
  const output = { new_findings: [{ severity: "P1", title: "handoff",
    where: "src/a.ts:10 and src/b.ts:80" }] };
  assert.deepEqual(scoreRun([{ id: "b", file: "src/b.ts", line: 80 }], output).hits,
    [{ id: "b", hit: true }]);
  const spaced = { new_findings: [{ severity: "P1", title: "other file",
    where: "src/my file.ts:30" }] };
  assert.deepEqual(scoreRun([{ id: "different", file: "file.ts", line: 30 }], spaced).hits,
    [{ id: "different", hit: false }]);
  for (const where of ["Producer: src/a.ts:80-85", "`src/a.ts:80-85`",
    "src/a.ts:10; the same file:80-85"]) {
    assert.deepEqual(scoreRun([{ id: "a", file: "src/a.ts", line: 80 }],
      { new_findings: [{ severity: "P1", title: "same file", where }] }).hits,
    [{ id: "a", hit: true }], where);
  }
});

test("repeated same-file references keep every anchored span", () => {
  const output = { new_findings: [{ severity: "P1", title: "three sites",
    where: "src/a.ts:10; the same file:80; the same file:150" }] };
  assert.deepEqual(scoreRun([{ id: "last", file: "src/a.ts", line: 150 }], output).hits,
    [{ id: "last", hit: true }]);
});

test("a same-file reference after a different file does not return to the earlier path", () => {
  const output = { new_findings: [{ severity: "P1", title: "two files",
    where: "src/a.ts:10; other/src/a.ts:80; the same file:150" }] };
  assert.deepEqual(scoreRun([{ id: "earlier", file: "src/a.ts", line: 150 }], output).hits,
    [{ id: "earlier", hit: false }]);
  assert.deepEqual(scoreRun([{ id: "same", file: "src/a.ts", line: 10 }], output).hits,
    [{ id: "same", hit: true }]);
});

test("en and em dash ranges score the lines inside them", () => {
  for (const dash of ["–", "—"]) {
    const output = { new_findings: [{ severity: "P1", title: "route",
      where: `order-router.ts:860${dash}882` }] };
    assert.deepEqual(scoreRun([{ id: "route", file: "order-router.ts", line: 870 }], output).hits,
      [{ id: "route", hit: true }]);
  }
});

test("same-file prose and comma lists score each referenced span", () => {
  const output = { new_findings: [{ severity: "P1", title: "capture",
    where: "Producer: order-capture.ts:31-32,68-87; Consumer: the same file:140-150" }] };
  assert.deepEqual(scoreRun([
    { id: "first", file: "order-capture.ts", line: 31 },
    { id: "second", file: "order-capture.ts", line: 75 },
    { id: "same", file: "order-capture.ts", line: 145 },
  ], output).hits, [
    { id: "first", hit: true }, { id: "second", hit: true }, { id: "same", hit: true },
  ]);
});

test("bare file names match a manifest path by final segment", () => {
  const output = { new_findings: [{ severity: "P1", title: "sync",
    where: "task-sync.ts:609–631" }] };
  assert.deepEqual(scoreRun([{ id: "sync", file: "apps/api/task-sync.ts", line: 620 }], output).hits,
    [{ id: "sync", hit: true }]);
});

test("old single-location output scores exactly as before", () => {
  const defects = [{ id: "A", file: "src/x.ts", line: 54 },
    { id: "B", file: "src/y.ts", line: 237 }];
  const oldOutput = { state: { open_issues: [
    { severity: "P2", title: "near A", location: "src/x.ts:40-45" },
    { severity: "P1", title: "elsewhere", location: "src/z.ts:1" },
  ] } };
  assert.deepEqual(scoreRun(defects, oldOutput), {
    hits: [{ id: "A", hit: true }, { id: "B", hit: false }],
    unmatched: ["P1 elsewhere @ src/z.ts:1"],
  });
  assert.deepEqual(parseLocations("src/x.ts:40-45"),
    [{ file: "src/x.ts", start: 40, end: 45 }]);
});

test("focused workers score separately from parent output", (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { scoreWorkers } = require('./score-recall.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-review-worker-score-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, 'codex-review-output.json');
  fs.writeFileSync(outputPath, JSON.stringify({ new_findings: [] }));
  const defects = [{ id: 'hit', file: 'src/a.ts', line: 20 }];
  fs.writeFileSync(path.join(root, 'focused-workers.json'), JSON.stringify([
    { status: 'ok', candidates: [{ file: 'src/a.ts', line: 20, severity: 'P2', title: 'found' }] },
    { status: 'error', candidates: [{ file: 'src/b.ts', line: 2, severity: 'P1', title: 'ignored' }] },
  ]));
  assert.deepEqual(scoreRun(defects, JSON.parse(fs.readFileSync(outputPath))).hits, [{ id: 'hit', hit: false }]);
  assert.deepEqual(scoreWorkers(defects, outputPath).hits, [{ id: 'hit', hit: true }]);
});
