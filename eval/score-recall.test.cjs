"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreRun, parseLocation } = require("./score-recall.cjs");

test("parseLocation reads path:line and path:start-end", () => {
  assert.deepEqual(parseLocation("a/b.ts:12"), { file: "a/b.ts", start: 12, end: 12 });
  assert.deepEqual(parseLocation("a/b.ts:10-20"), { file: "a/b.ts", start: 10, end: 20 });
  assert.equal(parseLocation("no line"), null);
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
