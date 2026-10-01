const test = require("node:test");
const assert = require("node:assert/strict");

const {
	isMergeBlocker,
	deriveMergeGate,
	verdictImpliedGate,
	formatMergeGateSummary,
	updateCheckRun,
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

test("ledger findings close the gate exactly when the ledger settlement blocks", () => {
	const { settlement } = require("../engine/ledger/projection.cjs");
	const ownerDecision = issue({ stable_id: "OWNER", severity: "P2", disposition: "AUTHOR_DECISION" });
	const advisory = issue({ stable_id: "ADVISORY", severity: "P2", disposition: "FIX_IN_PR" });
	const blocked = deriveMergeGate({ open_findings: [ownerDecision, advisory] });
	assert.equal(blocked.status, "BLOCK");
	assert.deepEqual(blocked.blockingIssueIds, ["OWNER"]);
	assert.equal(settlement([ownerDecision, advisory]).conclusion, "block");
	assert.match(formatMergeGateSummary(blocked, "OK"), /1 of 2 open findings require a fix or owner decision/);
	assert.equal(deriveMergeGate({ open_findings: [advisory] }).status, "PASS");
	assert.equal(settlement([advisory]).conclusion, "pass");
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

test("a transient failure completing the check is retried; a client error is not", async () => {
	const update = (failures) => {
		const calls = [];
		return { calls, github: { rest: { checks: { update: async (request) => {
			calls.push(request.conclusion);
			const failure = failures.shift();
			if (failure) throw failure;
		} } } } };
	};
	const sleeps = [];
	const args = { owner: "o", repo: "r", checkId: 7, conclusion: "success", title: "PASS", summary: "ok",
		sleep: async (ms) => { sleeps.push(ms); } };
	const network = Object.assign(new Error("fetch failed"), { status: 500 });
	const flaky = update([network, Object.assign(new Error("rate"), { status: 429 })]);
	await updateCheckRun({ ...args, github: flaky.github });
	assert.equal(flaky.calls.length, 3);
	assert.deepEqual(sleeps, [1000, 3000]);
	const down = update([network, network, network]);
	await assert.rejects(updateCheckRun({ ...args, github: down.github }), /fetch failed/);
	assert.equal(down.calls.length, 3);
	const invalid = update([Object.assign(new Error("invalid"), { status: 422 })]);
	await assert.rejects(updateCheckRun({ ...args, github: invalid.github }), /invalid/);
	assert.equal(invalid.calls.length, 1);
});
