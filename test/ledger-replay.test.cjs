"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { foldReview, hashCanonical, settlement } = require("../engine/ledger/projection.cjs");

const root = path.join(__dirname, "fixtures", "ledger-replay");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "corpus.json"), "utf8"));
const outcomes = new Map([
	["lifecycle-initial", ["block", "human_owned", "FIX_IN_PR", "NO"]],
	["lifecycle-follow-up", ["block", "human_owned", "FIX_IN_PR", "NO"]],
	["autonomous-batch", ["block", "autonomous_batch", "FIX_IN_PR", "YES"]],
	["author-decision", ["block", "pause_for_human", "AUTHOR_DECISION", "NO"]],
	["settlement-correction", ["block", "autonomous_batch", "FIX_IN_PR", "YES"]],
	["failed-handoff-edge", ["pass", "settled", "FOLLOW_UP", "NO"]],
	["normal-provider-failure-blocker", ["block", "autonomous_batch", "FIX_IN_PR", "YES"]],
	["irreversible-money-write-blocker", ["block", "autonomous_batch", "FIX_IN_PR", "YES"]],
]);

function modelFinding(source, fixture, prior) {
	const { first_evidence_sha, last_evaluated_target, decision_ref, follow_up, ...model } = source;
	return { ...model, stable_id: source.stable_id || prior.stable_id,
		failure_scenario: source.failure_scenario || prior.failure_scenario,
		where: source.where || `${fixture.input.changed_files[0]}:1`,
		evidence: source.evidence || fixture.input.trusted_thread_context.trim() || fixture.input.diff,
	};
}

test("synthetic replay cases retain their v4 settlement", () => {
	assert.equal(corpus.fixtures.length, outcomes.size);
	for (const entry of corpus.fixtures) {
		const fixture = JSON.parse(fs.readFileSync(path.join(root, path.basename(entry.file)), "utf8"));
		assert.equal(hashCanonical(fixture), entry.fixture_sha256, entry.id);
		assert.equal(fixture.fixture_id, entry.id);
		const target = { ...fixture.input.target, trusted_reviewer_ref: "d".repeat(40),
			evidence_bundle_sha256: "e".repeat(64), evidence_schema_version: 2 };
		let priorProjection = null;
		let output;
		if (entry.oracle.evaluation === "new_finding") {
			output = { new_findings: [modelFinding(entry.oracle.finding, fixture, null)], prior_issue_evaluations: [] };
		} else {
			const prior = fixture.input.prior_state.open_findings[0];
			const priorTarget = { ...target, head_sha: prior.first_evidence_sha };
			const baseline = foldReview({ output: { new_findings: [modelFinding(prior, fixture, null)],
				prior_issue_evaluations: [] }, target: priorTarget });
			priorProjection = { ...baseline, review_target: priorTarget };
			output = { new_findings: [], prior_issue_evaluations: [{ stable_id: prior.stable_id,
				result: "still_open", finding: modelFinding({ ...prior, ...entry.oracle.finding }, fixture, prior) }] };
		}
		const folded = foldReview({ output, target, priorProjection,
			humanDecisions: fixture.input.human_decisions || [] });
		const result = settlement(folded.open_findings);
		assert.deepEqual([result.conclusion, result.watcher_action,
			folded.open_findings[0].disposition, folded.open_findings[0].autonomous_eligibility],
			outcomes.get(entry.id), entry.id);
		assert.equal(folded.open_findings.length, 1, entry.id);
		assert.equal(folded.closed_findings.length, 0, entry.id);
		assert.deepEqual(folded.warnings, [], entry.id);
		if (priorProjection) {
			assert.equal(folded.open_findings[0].stable_id, priorProjection.open_findings[0].stable_id, entry.id);
			assert.equal(folded.open_findings[0].failure_scenario, priorProjection.open_findings[0].failure_scenario, entry.id);
		}
	}
});
