"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildProjection, foldReview, formatProjectionComment, prepareReviewPriorProjection, readProjectionComment, settlement } =
	require("../engine/ledger/projection.cjs");

const A = "a".repeat(40);
const B = "b".repeat(40);
const target = (head_sha = A) => ({ repository: "Intavia-Ai/web", pr_number: 1, base_ref: "main",
	base_sha: A, merge_base_sha: A, head_sha, trusted_reviewer_ref: B,
	evidence_bundle_sha256: "c".repeat(64), evidence_schema_version: 2 });
const checkIdentity = (head_sha = A) => ({ workflow_path: ".github/workflows/code-review.yaml",
	workflow_ref: "Intavia-Ai/web/.github/workflows/code-review.yaml@refs/heads/main",
	trusted_workflow_sha: B, workflow_run_id: "10", workflow_run_attempt: 1,
	workflow_job_id: 11, check_run_id: 12, check_suite_id: 13, app_slug: "github-actions", head_sha });

function modelFinding(overrides = {}) {
	return { stable_id: "OR-1", severity: "P1", reachability: "normal_path", likelihood: "medium",
		likely_consequence: "A request fails.", worst_credible_consequence: "A request fails and needs repair.",
		recoverability: "operational_intervention", proof_strength: "deterministic_static_proof",
		attribution: "introduced", risk_rationale: "A supported caller loses data.",
		disposition: "FIX_IN_PR", autonomous_eligibility: "YES", title: "Lost request",
		failure_scenario: "A normal request is lost.", approved_invariant: "Preserve every request.",
		where: "src/request.ts:10", evidence: "The changed write omits the requested row.",
		affected_lifecycle_planes: [], ...overrides };
}

function candidate(raw = modelFinding(), head = A) {
	return foldReview({ output: { new_findings: [raw], prior_issue_evaluations: [] }, target: target(head) });
}

function published(raw = modelFinding()) {
	return buildProjection({ candidate: candidate(raw), target: target(), checkIdentity: checkIdentity(), summaryCommentId: 99 });
}

test("v4 projection hashes and round-trips through Intavia's wire format", () => {
	const projection = published();
	const body = formatProjectionComment(projection);
	assert.ok(body.startsWith("<!-- codex-review:projection:v4 -->"));
	assert.deepEqual(readProjectionComment(body), projection);
	assert.deepEqual(settlement(projection.open_findings), {
		eligible_issue_ids: ["OR-1"], conclusion: "block", watcher_action: "autonomous_batch",
	});
});

test("a disallowed P1 follow-up is retained and coerced to owner decision", () => {
	const folded = candidate(modelFinding({ disposition: "FOLLOW_UP", autonomous_eligibility: "NO" }));
	assert.equal(folded.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.match(folded.warnings[0], /owner decision/);
	assert.equal(settlement(folded.open_findings).watcher_action, "pause_for_human");
});

test("an omitted prior evaluation carries the existing finding forward", () => {
	const first = published();
	const second = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] }, target: target(B), priorProjection: first });
	assert.equal(second.open_findings.length, 1);
	assert.equal(second.prior_issue_evaluations[0].result, "still_open");
	assert.equal(second.open_findings[0].failure_scenario, first.open_findings[0].failure_scenario);
	assert.match(second.warnings[0], /missing prior evaluation/);
	assert.equal(settlement(second.open_findings).conclusion, "block");
});

test("strict model evaluations use null for fields outside their result", () => {
	const first = published();
	const nullable = { evidence: null, challenge_ref: null, decision_ref: null };
	const stillOpen = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{
		stable_id: "OR-1", result: "still_open", finding: modelFinding(), ...nullable }] },
		target: target(B), priorProjection: first });
	assert.equal(stillOpen.open_findings.length, 1);
	assert.deepEqual(stillOpen.prior_issue_evaluations, []);
	const resolved = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{
		stable_id: "OR-1", result: "resolved_on_target", finding: modelFinding(),
		...nullable, evidence: "The changed write now preserves the row." }] },
		target: target(B), priorProjection: first });
	assert.equal(resolved.closed_findings[0].closure.result, "resolved_on_target");
	assert.deepEqual(Object.keys(resolved.prior_issue_evaluations[0]).sort(),
		["stable_id", "result", "finding", "evidence"].sort());
});

test("correction 3: an omitted repair evaluation does not make a later same-head resolution fail", () => {
	const first = published();
	const carried = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] },
		target: target(B), priorProjection: first });
	assert.equal(carried.open_findings.length, 1);
	assert.equal(carried.prior_issue_evaluations[0].result, "still_open");
	const carriedProjection = buildProjection({ candidate: carried, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100 });
	const resolved = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{
		stable_id: "OR-1", result: "resolved_on_target", evidence: "The changed write now preserves the row.",
		finding: modelFinding() }] }, target: target(B), priorProjection: carriedProjection,
		priorProjections: [{ comment_id: 99, projection: first }, { comment_id: 100, projection: carriedProjection }] });
	assert.equal(resolved.open_findings.length, 0);
	assert.equal(resolved.closed_findings[0].closure.result, "resolved_on_target");
});

test("correction 5: omitted same-head evaluation cannot erase the last substantive head", () => {
	const first = published();
	const reaffirmed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{
		stable_id: "OR-1", result: "still_open", finding: modelFinding() }] },
		target: target(B), priorProjection: first });
	const reaffirmedProjection = buildProjection({ candidate: reaffirmed, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100 });
	const carried = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] },
		target: target(B), priorProjection: reaffirmedProjection });
	const carriedProjection = buildProjection({ candidate: carried, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 101 });
	const resolve = (priorProjections = []) => foldReview({ output: { new_findings: [],
		prior_issue_evaluations: [{ stable_id: "OR-1", result: "resolved_on_target",
			evidence: "The write is claimed fixed.", finding: modelFinding() }] },
		target: target(B), priorProjection: carriedProjection, priorProjections });
	assert.throws(() => resolve(), (error) => error.code === "same_head_resolution_requires_challenge");
	assert.throws(() => resolve([{ comment_id: 99, projection: first },
		{ comment_id: 100, projection: reaffirmedProjection },
		{ comment_id: 101, projection: carriedProjection }]),
		(error) => error.code === "same_head_resolution_requires_challenge");
});

test("pre-existing P2 is advisory follow-up; pre-existing P1 requires an owner", () => {
	const p2 = candidate(modelFinding({ attribution: "pre_existing", severity: "P2", reachability: "compound_path",
		likelihood: "low", recoverability: "routine" }));
	assert.equal(p2.open_findings[0].disposition, "FOLLOW_UP");
	assert.equal(settlement(p2.open_findings).conclusion, "pass");
	const p1 = candidate(modelFinding({ attribution: "pre_existing" }));
	assert.equal(p1.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(settlement(p1.open_findings).conclusion, "block");
});

test("authenticated DEFER_FOLLOW_UP decision settles a reachable P1", () => {
	const first = published();
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track this bug.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123",
		owner_or_triage: "Andreas", decision_head_sha: A, comment_id: 50, actor_login: "andreasasprou" };
	const second = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: modelFinding() }] }, target: target(B), priorProjection: first,
		humanDecisions: [decision] });
	assert.equal(second.open_findings[0].disposition, "FOLLOW_UP");
	assert.equal(second.open_findings[0].decision_ref, "github-comment:50");
	assert.equal(settlement(second.open_findings).conclusion, "pass");
	const projection = buildProjection({ candidate: second, target: target(B), checkIdentity: checkIdentity(B),
		summaryCommentId: 100, humanDecisions: [decision] });
	assert.equal(projection.conclusion, "pass");
});

test("missing evaluation does not silently apply a new deferral", () => {
	const first = published();
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track request loss.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "Andreas",
		decision_head_sha: A, comment_id: 50, actor_login: "andreasasprou" };
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] },
		target: target(B), priorProjection: first, humanDecisions: [decision] });
	assert.equal(folded.open_findings[0].disposition, "FIX_IN_PR");
	assert.equal(folded.open_findings[0].decision_ref, null);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("challenge-backed withdrawal closes once and retains a closed snapshot", () => {
	const first = published();
	const challenge = { stable_id: "OR-1", evidence: "Baseline disproves this", challenge_head_sha: A,
		comment_id: 51, actor_login: "andreasasprou" };
	const second = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "withdrawn_as_unsupported", challenge_ref: "github-comment:51", evidence: "Baseline has the row.",
		finding: modelFinding() }] }, target: target(B), priorProjection: first, evidenceChallenges: [challenge] });
	assert.equal(second.open_findings.length, 0);
	assert.equal(second.closed_findings.length, 1);
	assert.deepEqual(second.consumed_evidence_challenge_refs, ["github-comment:51"]);
});

test("duplicate evaluations and renamed prior findings cannot erase a ledger record", () => {
	const first = published();
	const evaluation = { stable_id: "OR-1", result: "still_open", finding: modelFinding() };
	assert.throws(() => foldReview({ output: { new_findings: [], prior_issue_evaluations: [evaluation, evaluation] },
		target: target(B), priorProjection: first }), /evaluated more than once/);
	assert.throws(() => foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ ...evaluation, finding: modelFinding({ stable_id: "OTHER" }) }] },
		target: target(B), priorProjection: first }), /cannot be renamed/);
});

test("a later design decision reopens a closed finding with its frozen scenario", () => {
	const first = published();
	const closed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "resolved_on_target", evidence: "The repaired write persists the row.", finding: modelFinding() }] },
		target: target(B), priorProjection: first });
	const secondProjection = buildProjection({ candidate: closed, target: target(B), checkIdentity: checkIdentity(B),
		summaryCommentId: 100 });
	const decision = { stable_id: "OR-1", kind: "NARROW_BEHAVIOR", invariant: "Preserve request writes.",
		scope: "This PR", evidence: null, tracker: null, owner_or_triage: null,
		decision_head_sha: B, comment_id: 101, actor_login: "andreasasprou" };
	const reopened = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] }, target: target(B),
		priorProjection: secondProjection, humanDecisions: [decision] });
	assert.equal(reopened.open_findings[0].stable_id, "OR-1");
	assert.equal(reopened.open_findings[0].failure_scenario, first.open_findings[0].failure_scenario);
	assert.equal(reopened.open_findings[0].disposition, "FIX_IN_PR");
	assert.equal(reopened.closed_findings.length, 0);
});

test("deferred risk expansion restores an owner decision without losing the finding", () => {
	const first = published(modelFinding({ severity: "P2", reachability: "compound_path", likelihood: "low",
		recoverability: "routine", disposition: "FOLLOW_UP", autonomous_eligibility: "NO" }));
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track this bug.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "Andreas",
		decision_head_sha: A, comment_id: 50, actor_login: "andreasasprou" };
	const next = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: modelFinding({ severity: "P1" }) }] },
		target: target(B), priorProjection: first, humanDecisions: [decision] });
	assert.equal(next.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(next.open_findings[0].decision_ref, "github-comment:50");
	assert.equal(settlement(next.open_findings).conclusion, "block");
});

test("v4 reader rejects tampered closure and decision references after rehashing", () => {
	const first = published();
	const second = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "resolved_on_target", evidence: "Fixed on target.", finding: modelFinding() }] },
		target: target(B), priorProjection: first });
	const projection = buildProjection({ candidate: second, target: target(B), checkIdentity: checkIdentity(B),
		summaryCommentId: 100 });
	const { hashCanonical } = require("../engine/ledger/projection.cjs");
	const mutate = (edit) => {
		const copy = structuredClone(projection);
		edit(copy);
		const { projection_sha256, ...body } = copy;
		copy.projection_sha256 = hashCanonical(body);
		return copy;
	};
	const { validateProjection } = require("../engine/ledger/projection.cjs");
	assert.throws(() => validateProjection(mutate((copy) => { copy.closed_findings[0].closure.evidence = "Other"; })),
		/Closing evaluation/);
	assert.throws(() => validateProjection(mutate((copy) => { copy.closed_findings[0].finding.decision_ref = "github-comment:404"; })),
		/canonical closed finding record/);
});

test("local settlement keeps prior findings when the model emits no new findings", () => {
	const { buildLocalSettlement } = require("../engine/local-settlement.cjs");
	const priorProjection = published();
	const result = buildLocalSettlement({ output: { review_markdown: "## Verdict: OK\nNo new findings.",
		state: { last_reviewed_head_sha: B }, new_findings: [], prior_issue_evaluations: [], inline_comments: [] },
		patch: "", priorProjection });
	assert.equal(result.mergeGate.status, "BLOCK");
	assert.equal(result.ledger.open_findings[0].stable_id, "OR-1");
});

test("a later design decision revokes a deferred P1 even without an evaluation", () => {
	const first = published();
	const defer = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track it", scope: "This PR",
		evidence: "Issue exists", tracker: "ENG-1", owner_or_triage: "Andreas", decision_head_sha: A,
		comment_id: 50, actor_login: "andreasasprou" };
	const second = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: modelFinding() }] }, target: target(B), priorProjection: first, humanDecisions: [defer] });
	const deferred = buildProjection({ candidate: second, target: target(B), checkIdentity: checkIdentity(B),
		summaryCommentId: 100, humanDecisions: [defer] });
	const redesign = { ...defer, kind: "REDESIGN_IN_PR", comment_id: 51, evidence: null, tracker: null,
		owner_or_triage: null };
	const carried = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] }, target: target(B),
		priorProjection: deferred, humanDecisions: [defer, redesign] });
	assert.equal(carried.open_findings[0].disposition, "FIX_IN_PR");
	assert.equal(carried.open_findings[0].decision_ref, "github-comment:51");
	assert.equal(settlement(carried.open_findings).conclusion, "block");
});

test("expanded deferred risk remains blocking on two later rounds", () => {
	const first = published();
	const defer = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track it", scope: "This PR",
		evidence: "Issue exists", tracker: "ENG-1", owner_or_triage: "Andreas", decision_head_sha: A,
		comment_id: 50, actor_login: "andreasasprou" };
	const settled = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: modelFinding() }] }, target: target(B), priorProjection: first, humanDecisions: [defer] });
	const projection = buildProjection({ candidate: settled, target: target(B), checkIdentity: checkIdentity(B),
		summaryCommentId: 100, humanDecisions: [defer] });
	const expanded = modelFinding({ severity: "P0", likely_consequence: "Permanent data loss." });
	const next = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: expanded }] }, target: target(A), priorProjection: projection, humanDecisions: [defer] });
	const nextProjection = buildProjection({ candidate: next, target: target(A), checkIdentity: checkIdentity(A),
		summaryCommentId: 101, humanDecisions: [defer] });
	const again = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: expanded }] }, target: target(A), priorProjection: nextProjection, humanDecisions: [defer] });
	assert.equal(next.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(again.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(settlement(again.open_findings).conclusion, "block");
});

test("an owner-reopened finding accepts its explicit evaluation", () => {
	const first = published();
	const closed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "resolved_on_target", evidence: "Fixed", finding: modelFinding() }] }, target: target(B), priorProjection: first });
	const projection = buildProjection({ candidate: closed, target: target(B), checkIdentity: checkIdentity(B), summaryCommentId: 100 });
	const decision = { stable_id: "OR-1", kind: "REDESIGN_IN_PR", invariant: "Preserve requests",
		scope: "This PR", evidence: null, tracker: null, owner_or_triage: null, decision_head_sha: B,
		comment_id: 101, actor_login: "andreasasprou" };
	const contextFinding = prepareReviewPriorProjection(projection, [decision]).open_findings[0];
	assert.equal(contextFinding.stable_id, "OR-1");
	assert.equal(contextFinding.disposition, "FIX_IN_PR");
	assert.equal(contextFinding.decision_ref, "github-comment:101");
	const result = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: modelFinding() }] }, target: target(B), priorProjection: projection,
		humanDecisions: [decision] });
	assert.equal(result.open_findings[0].decision_ref, "github-comment:101");
});

test("a deferral reopening a closed finding needs an evaluation before it can pass", () => {
	const first = published();
	const closed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "resolved_on_target", evidence: "Fixed", finding: modelFinding() }] }, target: target(B), priorProjection: first });
	const projection = buildProjection({ candidate: closed, target: target(B), checkIdentity: checkIdentity(B), summaryCommentId: 100 });
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track it",
		scope: "This PR", evidence: "Issue exists", tracker: "ENG-1", owner_or_triage: "Andreas",
		decision_head_sha: B, comment_id: 101, actor_login: "andreasasprou" };
	const prepared = prepareReviewPriorProjection(projection, [decision]);
	// The moved source prepares the canonical proposal; only an evaluation may settle it.
	assert.equal(prepared.open_findings[0].disposition, "FOLLOW_UP");
	const result = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] }, target: target(B),
		priorProjection: projection, humanDecisions: [decision] });
	assert.equal(result.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(settlement(result.open_findings).conclusion, "block");
});

test("same-head design decisions cannot close a P1 through resolved_on_target", () => {
	const prior = published();
	for (const kind of ["REDESIGN_IN_PR", "NARROW_BEHAVIOR", "EVOLVE_FRAMEWORK"]) {
		const decision = { stable_id: "OR-1", kind, invariant: "Preserve every request.",
			scope: "Current request path", evidence: null, tracker: null, owner_or_triage: null,
			decision_head_sha: A, comment_id: 105, actor_login: "andreasasprou" };
		assert.throws(() => foldReview({
			output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
				result: "resolved_on_target", evidence: "The proposed design solves this.", finding: modelFinding() }] },
			target: target(), priorProjection: prior, humanDecisions: [decision],
		}), (error) => error.code === "same_head_resolution_requires_challenge");
	}
});
