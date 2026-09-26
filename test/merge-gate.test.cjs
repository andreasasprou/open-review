const test = require("node:test");
const assert = require("node:assert/strict");

const {
	isMergeBlocker,
	deriveMergeGate,
	verdictImpliedGate,
	formatMergeGateSummary,
} = require("../engine/index.cjs");

function issue(overrides) {
	return {
		id: "ISSUE-1",
		severity: "P1",
		reachability: "normal_path",
		likelihood: "high",
		worst_credible_consequence: "A user sees a wrong session transcript.",
		recoverability: "routine",
		area: "Code",
		category: "correctness",
		title: "Wrong transcript",
		location: "src/core/x.ts:10-12",
		status: "open",
		notes: "",
		first_seen_head_sha: "a".repeat(40),
		last_seen_head_sha: "a".repeat(40),
		...overrides,
	};
}

test("P1 on the normal path blocks", () => {
	assert.equal(isMergeBlocker(issue()), true);
});

test("P0 on a compound path blocks", () => {
	assert.equal(
		isMergeBlocker(issue({ severity: "P0", reachability: "compound_path" })),
		true,
	);
});

test("reachability theoretical never blocks, whatever the severity", () => {
	assert.equal(
		isMergeBlocker(issue({ severity: "P0", reachability: "theoretical" })),
		false,
	);
	assert.equal(
		isMergeBlocker(issue({ severity: "P1", reachability: "theoretical" })),
		false,
	);
});

test("P2 never blocks, whatever the reachability", () => {
	for (const reachability of ["normal_path", "compound_path", "theoretical"]) {
		assert.equal(
			isMergeBlocker(issue({ severity: "P2", reachability })),
			false,
		);
	}
});

test("a P2 theoretical finding leaves the gate open", () => {
	const gate = deriveMergeGate({
		open_issues: [issue({ severity: "P2", reachability: "theoretical" })],
	});
	assert.deepEqual(gate, {
		status: "PASS",
		conclusion: "success",
		openCount: 1,
		blockingCount: 0,
		blockingIssueIds: [],
	});
});

test("a P1 normal-path finding closes the gate", () => {
	const gate = deriveMergeGate({
		open_issues: [
			issue({ id: "NOISE", severity: "P2", reachability: "theoretical" }),
			issue({ id: "REAL", severity: "P1", reachability: "normal_path" }),
		],
	});
	assert.deepEqual(gate, {
		status: "BLOCK",
		conclusion: "failure",
		openCount: 2,
		blockingCount: 1,
		blockingIssueIds: ["REAL"],
	});
});

test("no findings passes", () => {
	assert.equal(deriveMergeGate({ open_issues: [] }).status, "PASS");
});

test("a blocking finding with a blank id still closes the gate", () => {
	const gate = deriveMergeGate({
		open_issues: [
			issue({ id: "", severity: "P1", reachability: "normal_path" }),
		],
	});
	assert.equal(gate.status, "BLOCK");
	assert.equal(gate.conclusion, "failure");
	assert.equal(gate.blockingCount, 1);
	assert.deepEqual(gate.blockingIssueIds, []);
	const summary = formatMergeGateSummary(gate, "BLOCK");
	assert.match(summary, /1 of 1 open findings/);
	assert.doesNotMatch(summary, /^Blocking:\s*$/m);
});

test("missing structured state is neutral, not a silent pass", () => {
	for (const state of [null, undefined, {}, { open_issues: "nope" }]) {
		const gate = deriveMergeGate(state);
		assert.equal(gate.status, "UNKNOWN");
		assert.equal(gate.conclusion, "neutral");
	}
});

test("verdict word maps onto the gate it implies", () => {
	assert.equal(verdictImpliedGate("BLOCK"), "BLOCK");
	assert.equal(verdictImpliedGate("OK"), "PASS");
	assert.equal(verdictImpliedGate("ATTENTION"), "PASS");
	assert.equal(verdictImpliedGate("UNKNOWN"), "UNKNOWN");
	assert.equal(verdictImpliedGate("ERROR"), "UNKNOWN");
});

test("summary states the derived gate and marks the verdict display-only", () => {
	const blocked = formatMergeGateSummary(
		deriveMergeGate({ open_issues: [issue({ id: "REAL" })] }),
		"OK",
	);
	assert.match(blocked, /Merge gate: \*\*BLOCK\*\*/);
	assert.match(blocked, /Blocking: REAL/);
	assert.match(blocked, /display only.*`OK`/);

	const passed = formatMergeGateSummary(
		deriveMergeGate({
			open_issues: [issue({ severity: "P2", reachability: "theoretical" })],
		}),
		"BLOCK",
	);
	assert.match(passed, /Merge gate: \*\*PASS\*\*/);
	assert.match(passed, /display only.*`BLOCK`/);
});
