"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildProjection, foldReview, formatProjectionComment, prepareReviewPriorProjection, readProjectionComment, settlement, validateCandidate } =
	require("../engine/ledger/projection.cjs");
const { hashReviewTarget } = require("../engine/ledger/evidence.cjs");

const A = "a".repeat(40);
const B = "b".repeat(40);
const target = (head_sha = A) => ({ repository: "example-org/sample-app", pr_number: 1, base_ref: "main",
	base_sha: A, merge_base_sha: A, head_sha, trusted_reviewer_ref: B,
	evidence_bundle_sha256: "c".repeat(64), evidence_schema_version: 2 });
const checkIdentity = (head_sha = A) => ({ workflow_path: ".github/workflows/code-review.yaml",
	workflow_ref: "example-org/sample-app/.github/workflows/code-review.yaml@refs/heads/main",
	trusted_workflow_sha: B, workflow_run_id: "10", workflow_run_attempt: 1,
	workflow_job_id: 11, check_run_id: 12, check_suite_id: 13, app_slug: "github-actions", head_sha });

function modelFinding(overrides = {}) {
	return { stable_id: "OR-1", severity: "P1", reachability: "normal_path", likelihood: "medium",
		likely_consequence: "A request fails.", worst_credible_consequence: "A request fails and needs repair.",
		recoverability: "operational_intervention", proof_strength: "deterministic_static_proof",
		attribution: "introduced", risk_rationale: "A supported customer loses data.",
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

test("a still-open evaluation with filled evidence keeps the finding open", () => {
	const first = published();
	const second = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding(),
			evidence: "The new head still writes without the requested row.", decision_ref: null },
	] }, target: target(B), priorProjection: first });
	assert.deepEqual(second.open_findings.map((finding) => finding.stable_id), ["OR-1"]);
	assert.deepEqual(second.warnings, []);
	const projection = buildProjection({ candidate: second, target: target(B), checkIdentity: checkIdentity(B), summaryCommentId: 99 });
	assert.equal(projection.open_findings[0].stable_id, "OR-1");
});

test("surrounding whitespace in the review summary is trimmed, not rejected", () => {
	const folded = foldReview({ output: { review_markdown: "\n  Summary.  \n", new_findings: [], prior_issue_evaluations: [] },
		target: target() });
	assert.equal(folded.review_markdown, "Summary.");
});

test("first v4 round drops an unknown closing evaluation with a warning", () => {
	const output = require("./fixtures/first-v4-old-state-output.json");
	const folded = foldReview({ output, target: target(B), priorProjection: null });
	assert.deepEqual(folded.open_findings, []);
	assert.deepEqual(folded.prior_issue_evaluations, []);
	assert.match(folded.warnings.join("\n"), /RETRY-CONTROL-001.*unknown prior.*resolved_on_target/);
});

test("unknown still-open evaluation becomes a new finding", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
	] }, target: target(B), priorProjection: null });
	assert.deepEqual(folded.new_findings.map((finding) => finding.stable_id), ["OR-1"]);
	assert.deepEqual(folded.prior_issue_evaluations, []);
});

for (const result of ["withdrawn_as_unsupported", "superseded_by_human_decision"]) {
	test(`unknown ${result} evaluation is dropped with a warning`, () => {
		const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
			{ stable_id: "OR-1", result, finding: modelFinding() },
		] }, target: target(B), priorProjection: null });
		assert.deepEqual(folded.open_findings, []);
		assert.match(folded.warnings.join("\n"), new RegExp(`OR-1.*${result}.*dropped`));
	});
}

test("duplicate unknown still-open evaluation contributes one new finding", () => {
	const evaluation = { stable_id: "OR-1", result: "still_open", finding: modelFinding() };
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		evaluation, evaluation,
	] }, target: target(B), priorProjection: null });
	assert.equal(folded.new_findings.length, 1);
	assert.match(folded.warnings.join("\n"), /duplicate|dropped/);
});

test("equivalent evaluations deduplicate after canonical key and nullable-field normalization", () => {
	const prior = published();
	const first = { stable_id: "OR-1", result: "still_open", finding: modelFinding(),
		evidence: null, challenge_ref: null, decision_ref: null };
	const second = { finding: { ...modelFinding() }, result: "still_open", stable_id: "OR-1" };
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [first, second] },
		target: target(B), priorProjection: prior });
	assert.equal(folded.open_findings[0].disposition, prior.open_findings[0].disposition);
	assert.match(folded.warnings.join("\n"), /equivalent duplicate prior evaluation dropped/);
	assert.doesNotMatch(folded.warnings.join("\n"), /reconciliation conflict/);
});

test("conflicting unknown advisory evaluations publish a blocking finding", () => {
	const advisory = modelFinding({ severity: "P2", reachability: "theoretical" });
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: advisory },
		{ stable_id: "OR-1", result: "still_open", finding: { ...advisory, likelihood: "low" } },
	] }, target: target(B) });
	assert.equal(folded.open_findings[0].stable_id, "OR-1");
	assert.equal(settlement(folded.open_findings).conclusion, "block");
	assert.match(folded.warnings.join("\n"), /reconciliation conflict on OR-1: 2 evaluations disagreed; kept prior record and blocked/);
	assert.equal(buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 102 }).conclusion, "block");
});

test("pre-existing unknown conflict remains blocking through finding normalization", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
			severity: "P2", reachability: "compound_path", likelihood: "low",
			recoverability: "routine", attribution: "pre_existing",
		}) },
	] }, target: target(B) });
	assert.equal(folded.open_findings[0].stable_id, "OR-1");
	assert.equal(folded.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(folded.open_findings[0].autonomous_eligibility, "NO");
	assert.equal(buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 102 }).conclusion, "block");
});

test("pre-existing conflict on a closed ID recurs under a blocking identity", () => {
	const prior = published();
	const closed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "resolved_on_target", evidence: "Fixed on B.", finding: modelFinding() },
	] }, target: target(B), priorProjection: prior });
	const closedProjection = buildProjection({ candidate: closed, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100 });
	const recurrence = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
			severity: "P2", reachability: "compound_path", likelihood: "low",
			recoverability: "routine", attribution: "pre_existing",
		}) },
	] }, target: target(B), priorProjection: closedProjection });
	assert.equal(recurrence.open_findings.length, 1);
	assert.notEqual(recurrence.open_findings[0].stable_id, "OR-1");
	assert.match(recurrence.open_findings[0].evidence, /Recurrence of prior finding OR-1/);
	assert.equal(recurrence.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(buildProjection({ candidate: recurrence, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 101 }).conclusion, "block");
});

test("pre-existing unknown conflict survives the 25-finding advisory cap", () => {
	const advisories = Array.from({ length: 25 }, (_, index) => modelFinding({
			stable_id: `ADV-${index}`, severity: "P2", reachability: "normal_path",
		}));
	const folded = foldReview({ output: { new_findings: advisories, prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
			severity: "P2", reachability: "compound_path", likelihood: "low",
			recoverability: "routine", attribution: "pre_existing",
		}) },
	] }, target: target(B) });
	assert.equal(folded.new_findings.length, 25);
	assert.ok(folded.open_findings.some((finding) => finding.stable_id === "OR-1" &&
		finding.disposition === "AUTHOR_DECISION"));
	assert.equal(buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 102 }).conclusion, "block");
});

test("conflicting unknown evaluations with no well-formed open member use a minimal blocker", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ likelihood: { toString: null } }) },
		{ stable_id: "OR-1", result: "resolved_on_target", finding: modelFinding({ title: null }) },
	] }, target: target(B) });
	assert.equal(folded.open_findings[0].title, "Untitled finding OR-1");
	assert.equal(folded.open_findings[0].severity, "P1");
	assert.equal(folded.open_findings[0].reachability, "normal_path");
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("a malformed duplicate risk object publishes a blocker without throwing", () => {
	const prior = published();
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ likelihood: { toString: null } }) },
	] }, target: target(B), priorProjection: prior });
	assert.equal(folded.open_findings[0].likelihood, prior.open_findings[0].likelihood);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
	assert.equal(buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 102 }).conclusion, "block");
});

test("a stale duplicate challenge reference keeps the prior finding and publishes BLOCK", () => {
	const prior = published();
	const challenge = { stable_id: "OR-1", evidence: "Reassess this finding.", challenge_head_sha: A,
		comment_id: 52, actor_login: "sample-maintainer" };
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", challenge_ref: "github-comment:51",
			finding: modelFinding({ severity: "P1" }) },
		{ stable_id: "OR-1", result: "still_open", challenge_ref: "github-comment:52",
			finding: modelFinding({ severity: "P0" }) },
	] }, target: target(B), priorProjection: prior, evidenceChallenges: [challenge] });
	assert.equal(folded.open_findings[0].severity, prior.open_findings[0].severity);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
	assert.deepEqual(folded.consumed_evidence_challenge_refs, []);
	assert.equal(buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 102 }).conclusion, "block");
});

test("malformed unknown still-open evaluation is repaired without failing the round", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ title: "" }) },
	] }, target: target(B), priorProjection: null });
	assert.equal(folded.open_findings[0].title, "A normal request is lost.");
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("a known closure followed by still_open keeps the blocker", () => {
	const prior = published();
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "resolved_on_target", evidence: "Claimed fixed.", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
	] }, target: target(B), priorProjection: prior });
	assert.equal(folded.open_findings[0].stable_id, "OR-1");
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("unknown conflicting still_open findings retain the latest well-formed member and block", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ severity: "P2" }) },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ severity: "P1" }) },
	] }, target: target(B) });
	assert.equal(folded.open_findings[0].severity, "P1");
	assert.equal(folded.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("converted blocker displaces the lowest-risk advisory at the 25-finding cap", () => {
	const advisories = Array.from({ length: 25 }, (_, index) => modelFinding({
		stable_id: `ADV-${index}`, severity: "P2", reachability: "theoretical",
	}));
	const blocker = modelFinding({ stable_id: "BLOCK-1", severity: "P1" });
	const folded = foldReview({ output: { new_findings: advisories,
		prior_issue_evaluations: [{ stable_id: "BLOCK-1", result: "still_open", finding: blocker }] },
		target: target(B) });
	assert.equal(folded.new_findings.length, 25);
	assert.ok(folded.open_findings.some((finding) => finding.stable_id === "BLOCK-1"));
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("unknown severe finding with invalid metadata stays open as a blocker", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
			severity: "unknown", title: "", failure_scenario: "", evidence: "", where: "",
		}) },
	] }, target: target(B) });
	assert.equal(folded.open_findings[0].stable_id, "OR-1");
	assert.equal(folded.open_findings[0].title, "Untitled finding OR-1");
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("invalid known still-open reassessment cannot retain an older advisory risk", () => {
	const prior = published(modelFinding({ severity: "P2" }));
	for (const malformed of [{ severity: "P1", title: "" }, { severity: "unknown", where: "" }]) {
		const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
			{ stable_id: "OR-1", result: "still_open", finding: modelFinding(malformed) },
		] }, target: target(B), priorProjection: prior });
		assert.equal(folded.open_findings[0].stable_id, "OR-1");
		assert.equal(folded.open_findings[0].severity, "P1");
		assert.equal(settlement(folded.open_findings).conclusion, "block");
		assert.equal(buildProjection({ candidate: folded, target: target(B),
			checkIdentity: checkIdentity(B), summaryCommentId: 103 }).conclusion, "block");
	}
});

test("invalid reported ID gets a valid blocking identity", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "bad id", result: "still_open", finding: modelFinding({ stable_id: "bad id" }) },
	] }, target: target(B) });
	assert.match(folded.open_findings[0].stable_id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("oversized multibyte evidence is repaired without dropping a blocker", () => {
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ title: "", evidence: "🔒".repeat(2_000) }) },
	] }, target: target(B) });
	assert.equal(folded.open_findings[0].stable_id, "OR-1");
	assert.ok(Buffer.byteLength(folded.open_findings[0].evidence, "utf8") <= 4_000);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("a closed ID reported still_open reappears under a linked fresh ID", () => {
	const prior = published();
	const closed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "resolved_on_target", evidence: "Fixed on the later head.", finding: modelFinding() },
	] }, target: target(B), priorProjection: prior });
	const closedProjection = buildProjection({ candidate: closed, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100 });
	const recurrence = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
	] }, target: target(B), priorProjection: closedProjection });
	assert.equal(recurrence.open_findings.length, 1);
	assert.notEqual(recurrence.open_findings[0].stable_id, "OR-1");
	assert.match(recurrence.open_findings[0].evidence, /OR-1/);
	assert.equal(settlement(recurrence.open_findings).conclusion, "block");
	const recurrenceProjection = buildProjection({ candidate: recurrence, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 101 });
	const repeated = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
	] }, target: target(B), priorProjection: recurrenceProjection });
	assert.equal(settlement(repeated.open_findings).conclusion, "block");
	assert.equal(new Set(repeated.open_findings.map((finding) => finding.stable_id)).size,
		repeated.open_findings.length);
});

test("generated reconciliation mixtures never pass or lose the open conflict finding", () => {
	const prior = published();
	const deferredBaseline = modelFinding({ reachability: "compound_path" });
	const deferDecision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track this bug.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "the sample owner",
		decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
	const deferred = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: deferredBaseline },
	] }, target: target(B), priorProjection: published(deferredBaseline), humanDecisions: [deferDecision] });
	const deferredProjection = buildProjection({ candidate: deferred, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 200, humanDecisions: [deferDecision] });
	const driftVariants = [
		{ severity: "P0" }, { reachability: "normal_path" }, { likelihood: "high" },
		{ recoverability: "irreversible" }, { attribution: "relied_upon" },
		{ proof_strength: "speculative" }, { likely_consequence: "Permanent request loss." },
		{ worst_credible_consequence: "All request data is lost." },
		{ affected_lifecycle_planes: ["external"] },
		{ risk_rationale: "Different risk reasoning." }, { title: "Changed title" },
		{ failure_scenario: "Different failure." }, { approved_invariant: "Different invariant." },
		{ where: "src/other.ts:20" }, { evidence: "Different evidence." },
		{ likelihood: { toString: null } }, { recoverability: { toString: null } },
		{ attribution: { toString: null } },
	];
	for (let seed = 0; seed < 64; seed += 1) {
		const id = `RISK-${seed}`;
		const severity = seed % 3 === 0 ? "P0" : "P1";
		const reachability = seed % 2 === 0 ? "normal_path" : "compound_path";
		const blocker = modelFinding({ stable_id: id, severity, reachability,
			...(seed % 5 === 0 ? { title: "" } : {}),
		});
		const advisoryCount = seed % 4 === 0 ? 25 : seed % 7;
		const newFindings = Array.from({ length: advisoryCount }, (_, index) => modelFinding({
			stable_id: `ADV-${seed}-${index}`, severity: "P2", reachability: "theoretical",
		}));
		const evaluations = [
			...(seed % 2 === 0 ? [{ stable_id: id, result: "resolved_on_target", finding: blocker }] : []),
			...(seed % 3 === 0 ? [{ stable_id: id, result: "still_open",
				finding: modelFinding({ stable_id: id, severity: "P2", reachability: "theoretical" }) }] : []),
			{ stable_id: id, result: "still_open", finding: blocker },
		];
		const folded = foldReview({ output: { new_findings: newFindings,
			prior_issue_evaluations: evaluations }, target: target(B) });
		assert.equal(settlement(folded.open_findings).conclusion, "block", `seed ${seed}`);
		assert.ok(folded.open_findings.some((finding) => finding.stable_id === id &&
			settlement([finding]).conclusion === "block"), `seed ${seed}`);
		assert.equal(buildProjection({ candidate: folded, target: target(B),
			checkIdentity: checkIdentity(B), summaryCommentId: seed + 1 }).conclusion, "block", `seed ${seed}`);
		const knownPrior = published(modelFinding({ stable_id: id, severity: "P2", reachability: "theoretical" }));
		const known = foldReview({ output: { new_findings: newFindings,
			prior_issue_evaluations: evaluations }, target: target(B), priorProjection: knownPrior });
		assert.ok(known.open_findings.some((finding) => finding.stable_id === id &&
			settlement([finding]).conclusion === "block"), `known seed ${seed}`);
		assert.equal(settlement(known.open_findings).conclusion, "block", `known seed ${seed}`);
		const reassessment = modelFinding({ reachability: "theoretical",
			...driftVariants[seed % driftVariants.length] });
		const baselineEvaluation = { stable_id: "OR-1", result: "still_open", finding: deferredBaseline };
		const expandedEvaluation = { stable_id: "OR-1", result: "still_open", finding: reassessment,
			...(seed % 19 === 17 ? { challenge_ref: "github-comment:999" } : {}),
			...(seed % 19 === 18 ? { decision_ref: "github-comment:999" } : {}) };
		const deferredEvaluations = seed % 2 ? [expandedEvaluation, baselineEvaluation]
			: [baselineEvaluation, expandedEvaluation];
		const drifted = foldReview({ output: { new_findings: newFindings,
			prior_issue_evaluations: deferredEvaluations }, target: target(A),
			priorProjection: deferredProjection, humanDecisions: [deferDecision] });
		assert.equal(drifted.open_findings.find((finding) => finding.stable_id === "OR-1").disposition,
			"AUTHOR_DECISION", `deferred seed ${seed}`);
		assert.equal(drifted.open_findings[0].decision_ref, "github-comment:50", `deferred ref seed ${seed}`);
		assert.equal(buildProjection({ candidate: drifted, target: target(A),
			checkIdentity: checkIdentity(A), summaryCommentId: seed + 201,
			humanDecisions: [deferDecision] }).conclusion, "block", `deferred seed ${seed}`);
		const conflictAdvisories = seed % 3 !== 0 ? Array.from({ length: 25 }, (_, index) =>
			modelFinding({ stable_id: `CAP-${seed}-${index}`, severity: "P2", reachability: "normal_path" })) : [];
		let conflictPrior = null;
		if (seed % 3 === 2) {
			const beforeClosure = published(modelFinding({ stable_id: id }));
			const closed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
				{ stable_id: id, result: "resolved_on_target", evidence: "Fixed on B.",
					finding: modelFinding({ stable_id: id }) },
			] }, target: target(B), priorProjection: beforeClosure });
			conflictPrior = buildProjection({ candidate: closed, target: target(B),
				checkIdentity: checkIdentity(B), summaryCommentId: seed + 300 });
		}
		const conflictCandidate = foldReview({ output: { new_findings: conflictAdvisories,
			prior_issue_evaluations: [
				{ stable_id: id, result: "still_open", finding: modelFinding({ stable_id: id }) },
				{ stable_id: id, result: "still_open", finding: modelFinding({ stable_id: id,
					severity: "P2", reachability: "compound_path", likelihood: "low",
					recoverability: "routine", attribution: "pre_existing",
					proof_strength: seed % 2 ? "inferred" : "speculative",
					affected_lifecycle_planes: seed % 2 ? ["provider_action"] : [],
				}) },
			] }, target: target(B), priorProjection: conflictPrior });
		const retained = conflictCandidate.open_findings.find((finding) =>
			finding.stable_id === id || finding.stable_id.startsWith(`${id}:recur:`));
		assert.ok(retained, `retained conflict seed ${seed}`);
		assert.equal(retained.disposition, "AUTHOR_DECISION", `conflict disposition seed ${seed}`);
		assert.equal(retained.autonomous_eligibility, "NO", `conflict autonomy seed ${seed}`);
		assert.ok(conflictCandidate.new_findings.some((finding) => finding.stable_id === retained.stable_id),
			`conflict survives cap seed ${seed}`);
		assert.equal(buildProjection({ candidate: conflictCandidate, target: target(B),
			checkIdentity: checkIdentity(B), summaryCommentId: seed + 500 }).conclusion,
			"block", `conflict projection seed ${seed}`);
	}
	const knownInvalid = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ title: "" }) },
	] }, target: target(B), priorProjection: prior });
	assert.equal(knownInvalid.open_findings[0].stable_id, "OR-1");
	assert.equal(settlement(knownInvalid.open_findings).conclusion, "block");
});

test("duplicate conflicts across finding fields and references always retain and block", () => {
	const prior = published(modelFinding({ severity: "P2", reachability: "theoretical" }));
	const baseline = { ...prior.open_findings[0], last_evaluated_target: hashReviewTarget(target(B)) };
	const variants = [
		["stable_id", "OTHER"], ["severity", "P1"], ["reachability", "normal_path"],
		["likelihood", "high"], ["likely_consequence", "Larger loss."],
		["worst_credible_consequence", "Permanent loss."], ["recoverability", "irreversible"],
		["proof_strength", "speculative"], ["attribution", "relied_upon"],
		["risk_rationale", "Changed risk."], ["disposition", "AUTHOR_DECISION"],
		["autonomous_eligibility", "NO"], ["title", "Changed title"],
		["failure_scenario", "Changed scenario."], ["approved_invariant", "Changed invariant."],
		["where", "src/other.ts:1"], ["evidence", "Changed evidence."],
		["first_evidence_sha", B], ["last_evaluated_target", "bad hash"],
		["affected_lifecycle_planes", ["external"]],
		["decision_ref", "github-comment:999"],
		["follow_up", { tracker: "ENG-1", owner_or_triage: "the sample owner" }],
		["likelihood", { toString: null }], ["recoverability", { toString: null }],
		["attribution", { toString: null }],
	];
	const original = { stable_id: "OR-1", result: "still_open", finding: baseline };
	const cases = variants.map(([field, value]) => [field, {
		...original, finding: { ...baseline, [field]: value },
	}]);
	cases.push(["challenge_ref", { ...original, challenge_ref: "github-comment:999" }]);
	cases.push(["decision_ref", { ...original, decision_ref: "github-comment:999" }]);
	for (const [field, changed] of cases) {
		for (const evaluations of [[original, changed], [changed, original]]) {
			const folded = validateCandidate({ rawOutput: { review_markdown: "", inline_comments: [],
				new_findings: [], prior_issue_evaluations: evaluations }, target: target(B),
				priorProjection: prior, evidence: {} });
			const retained = folded.open_findings[0];
			assert.equal(retained.stable_id, "OR-1", field);
			assert.equal(retained.severity, "P2", field);
			assert.equal(retained.reachability, "theoretical", field);
			assert.equal(retained.disposition, "AUTHOR_DECISION", field);
			assert.equal(settlement(folded.open_findings).conclusion, "block", field);
			assert.equal(folded.warnings.filter((warning) => warning.startsWith("reconciliation conflict on OR-1:")).length, 1, field);
			assert.equal(buildProjection({ candidate: folded, target: target(B),
				checkIdentity: checkIdentity(B), summaryCommentId: 104 }).conclusion, "block", field);
		}
	}
});

test("more than 25 reachable blockers remain open and cannot produce PASS", () => {
	const newFindings = Array.from({ length: 25 }, (_, index) => modelFinding({ stable_id: `P1-${index}` }));
	const folded = foldReview({ output: { new_findings: newFindings,
		prior_issue_evaluations: [{ stable_id: "P1-25", result: "still_open",
			finding: modelFinding({ stable_id: "P1-25" }) }] }, target: target(B) });
	assert.equal(folded.open_findings.length, 26);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
	assert.match(folded.warnings.join("\n"), /exceed.*cap/);
	const projection = buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 102 });
	assert.match(formatProjectionComment(projection), /codex-review:projection:v4/);
});

test("local overflow settlement states the cap exception in its summary", () => {
	const { buildLocalSettlement } = require("../engine/local-settlement.cjs");
	const newFindings = Array.from({ length: 25 }, (_, index) => modelFinding({ stable_id: `P1-${index}` }));
	const result = buildLocalSettlement({ output: { review_markdown: "## Verdict: BLOCK",
		state: { last_reviewed_head_sha: B }, inline_comments: [], new_findings: newFindings,
		prior_issue_evaluations: [{ stable_id: "P1-25", result: "still_open",
			finding: modelFinding({ stable_id: "P1-25" }) }] }, patch: "" });
	assert.equal(result.mergeGate.status, "BLOCK");
	assert.match(result.mergeGateSummary, /26 reachable blockers exceed the 25-finding cap/);
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

test("conflicting resolutions preserve the substantive head for a same-head retry", () => {
	const first = published();
	const conflict = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "resolved_on_target", evidence: "First resolution claim.",
			finding: modelFinding() },
		{ stable_id: "OR-1", result: "resolved_on_target", evidence: "Different resolution claim.",
			finding: modelFinding() },
	] }, target: target(B), priorProjection: first });
	assert.equal(conflict.open_findings[0].stable_id, "OR-1");
	assert.equal(settlement(conflict.open_findings).conclusion, "block");
	const conflictProjection = buildProjection({ candidate: conflict, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100 });
	const resolved = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "resolved_on_target", evidence: "The write is fixed on B.",
			finding: modelFinding() },
	] }, target: target(B), priorProjection: conflictProjection,
		priorProjections: [{ comment_id: 99, projection: first },
			{ comment_id: 100, projection: conflictProjection }] });
	assert.equal(resolved.open_findings.length, 0);
	assert.equal(resolved.closed_findings[0].closure.result, "resolved_on_target");
	assert.equal(buildProjection({ candidate: resolved, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 101 }).conclusion, "pass");
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
		owner_or_triage: "the sample owner", decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
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
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "the sample owner",
		decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] },
		target: target(B), priorProjection: first, humanDecisions: [decision] });
	assert.equal(folded.open_findings[0].disposition, "FIX_IN_PR");
	assert.equal(folded.open_findings[0].decision_ref, null);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("challenge-backed withdrawal closes once and retains a closed snapshot", () => {
	const first = published();
	const challenge = { stable_id: "OR-1", evidence: "Baseline disproves this", challenge_head_sha: A,
		comment_id: 51, actor_login: "sample-maintainer" };
	const second = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "withdrawn_as_unsupported", challenge_ref: "github-comment:51", evidence: "Baseline has the row.",
		finding: modelFinding() }] }, target: target(B), priorProjection: first, evidenceChallenges: [challenge] });
	assert.equal(second.open_findings.length, 0);
	assert.equal(second.closed_findings.length, 1);
	assert.deepEqual(second.consumed_evidence_challenge_refs, ["github-comment:51"]);
});

test("conflicting challenge references leave the authenticated challenge unconsumed", () => {
	const prior = published();
	const challenge = { stable_id: "OR-1", evidence: "The report needs a second look.",
		challenge_head_sha: A, comment_id: 51, actor_login: "sample-maintainer" };
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", challenge_ref: "github-comment:51",
			finding: modelFinding({ severity: "P0" }) },
	] }, target: target(B), priorProjection: prior, evidenceChallenges: [challenge] });
	assert.equal(folded.open_findings[0].severity, prior.open_findings[0].severity);
	assert.equal(folded.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.deepEqual(folded.consumed_evidence_challenge_refs, []);
	assert.equal(settlement(folded.open_findings).conclusion, "block");
});

test("duplicate evaluations warn and renamed prior findings cannot erase a ledger record", () => {
	const first = published();
	const evaluation = { stable_id: "OR-1", result: "still_open", finding: modelFinding() };
	const duplicate = foldReview({ output: { new_findings: [], prior_issue_evaluations: [evaluation, evaluation] },
		target: target(B), priorProjection: first });
	assert.equal(duplicate.open_findings.length, 1);
	assert.match(duplicate.warnings.join("\n"), /duplicate prior evaluation dropped/);
	const renamed = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ ...evaluation, finding: modelFinding({ stable_id: "OTHER" }) }] },
		target: target(B), priorProjection: first });
	assert.equal(renamed.open_findings[0].stable_id, "OR-1");
	assert.equal(settlement(renamed.open_findings).conclusion, "block");
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
		decision_head_sha: B, comment_id: 101, actor_login: "sample-maintainer" };
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
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "the sample owner",
		decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
	const next = foldReview({ output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
		result: "still_open", finding: modelFinding({ severity: "P1" }) }] },
		target: target(B), priorProjection: first, humanDecisions: [decision] });
	assert.equal(next.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(next.open_findings[0].decision_ref, "github-comment:50");
	assert.equal(settlement(next.open_findings).conclusion, "block");
});

test("duplicate deferred reassessments invalidate approval for likelihood and recoverability conflicts", () => {
	const first = published();
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track this bug.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "the sample owner",
		decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
	const deferred = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
	] }, target: target(B), priorProjection: first, humanDecisions: [decision] });
	const priorProjection = buildProjection({ candidate: deferred, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100, humanDecisions: [decision] });
	for (const [riskField, worstValue] of [["likelihood", "high"], ["recoverability", "irreversible"]]) {
		const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
			{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
				reachability: "compound_path", [riskField]: worstValue, evidence: `Expanded ${riskField}.`,
			}) },
			{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ evidence: "Normal path remains." }) },
		] }, target: target(A), priorProjection, humanDecisions: [decision] });
		assert.equal(folded.open_findings[0][riskField], priorProjection.open_findings[0][riskField]);
		assert.equal(folded.open_findings[0].disposition, "AUTHOR_DECISION");
		assert.equal(folded.open_findings[0].decision_ref, "github-comment:50");
		assert.match(folded.warnings.join("\n"), /reconciliation conflict on OR-1: 2 evaluations disagreed; kept prior record and blocked/);
		assert.equal(buildProjection({ candidate: folded, target: target(A),
			checkIdentity: checkIdentity(A), summaryCommentId: 101, humanDecisions: [decision] }).conclusion,
			"block");
	}
});

test("conflicting consequence evaluations invalidate an approved deferral", () => {
	const baseline = modelFinding({ severity: "P0", reachability: "normal_path",
		likely_consequence: "A normal request is lost.",
		worst_credible_consequence: "A normal request is lost." });
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track this bug.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "the sample owner",
		decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
	const deferred = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: baseline },
	] }, target: target(B), priorProjection: published(baseline), humanDecisions: [decision] });
	const priorProjection = buildProjection({ candidate: deferred, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100, humanDecisions: [decision] });
	for (const field of ["likely_consequence", "worst_credible_consequence"]) {
		const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
			{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ severity: "P1", [field]: null }) },
			{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ severity: "P0",
				reachability: "theoretical", [field]: baseline[field] }) },
			{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ severity: "P0",
				[field]: "Permanent request data loss." }) },
		] }, target: target(A), priorProjection, humanDecisions: [decision] });
		assert.equal(folded.open_findings[0][field], baseline[field]);
		assert.equal(folded.open_findings[0].disposition, "AUTHOR_DECISION");
		assert.equal(folded.open_findings[0].decision_ref, "github-comment:50");
		assert.equal(buildProjection({ candidate: folded, target: target(A),
			checkIdentity: checkIdentity(A), summaryCommentId: 101,
			humanDecisions: [decision] }).conclusion, "block");
		assert.match(folded.warnings.join("\n"), /reconciliation conflict on OR-1: 3 evaluations disagreed; kept prior record and blocked/);
	}
});

test("a conflict invalidates an advisory deferral and stays blocked until a newer decision", () => {
	const baseline = modelFinding({ severity: "P2", reachability: "compound_path",
		likelihood: "low", recoverability: "routine", attribution: "introduced" });
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track this bug.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "the sample owner",
		decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
	const deferred = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: baseline },
	] }, target: target(B), priorProjection: published(baseline), humanDecisions: [decision] });
	const priorProjection = buildProjection({ candidate: deferred, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100, humanDecisions: [decision] });
	assert.equal(priorProjection.conclusion, "pass");
	const conflict = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: baseline },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({ ...baseline,
			risk_rationale: "The same risk with different reasoning." }) },
	] }, target: target(A), priorProjection, humanDecisions: [decision] });
	assert.equal(conflict.open_findings[0].severity, "P2");
	assert.equal(conflict.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(conflict.open_findings[0].decision_ref, "github-comment:50");
	const blockedProjection = buildProjection({ candidate: conflict, target: target(A),
		checkIdentity: checkIdentity(A), summaryCommentId: 101, humanDecisions: [decision] });
	assert.equal(blockedProjection.conclusion, "block");
	const later = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: baseline },
	] }, target: target(A), priorProjection: blockedProjection, humanDecisions: [decision] });
	assert.equal(settlement(later.open_findings).conclusion, "block");
});

test("malformed duplicate deferred risk cannot reapply an old deferral", () => {
	const baseline = modelFinding({ likelihood: "unknown", recoverability: "unknown", proof_strength: "speculative" });
	const decision = { stable_id: "OR-1", kind: "DEFER_FOLLOW_UP", invariant: "Track this bug.",
		scope: "This PR", evidence: "Independent issue", tracker: "ENG-123", owner_or_triage: "the sample owner",
		decision_head_sha: A, comment_id: 50, actor_login: "sample-maintainer" };
	const deferred = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: baseline },
	] }, target: target(B), priorProjection: published(baseline), humanDecisions: [decision] });
	const priorProjection = buildProjection({ candidate: deferred, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100, humanDecisions: [decision] });
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: baseline },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
			likelihood: "unknown", recoverability: "irreversible", proof_strength: "speculative",
			affected_lifecycle_planes: [""],
		}) },
	] }, target: target(A), priorProjection, humanDecisions: [decision] });
	assert.equal(folded.open_findings[0].disposition, "AUTHOR_DECISION");
	assert.equal(folded.open_findings[0].recoverability, priorProjection.open_findings[0].recoverability);
	assert.equal(buildProjection({ candidate: folded, target: target(A),
		checkIdentity: checkIdentity(A), summaryCommentId: 101, humanDecisions: [decision] }).conclusion, "block");
});

test("a malformed conflicting P0 reassessment retains the prior blocker", () => {
	const prior = published();
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
			severity: "P0", disposition: "AUTHOR_DECISION", autonomous_eligibility: "YES",
		}) },
	] }, target: target(B), priorProjection: prior });
	assert.equal(folded.open_findings[0].severity, prior.open_findings[0].severity);
	assert.equal(folded.open_findings[0].autonomous_eligibility, "NO");
	assert.equal(buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100 }).conclusion, "block");
});

test("a conflicting reassessment with an inconsistent nested ID retains the prior blocker", () => {
	const prior = published();
	const folded = foldReview({ output: { new_findings: [], prior_issue_evaluations: [
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding() },
		{ stable_id: "OR-1", result: "still_open", finding: modelFinding({
			stable_id: "OTHER", severity: "P0",
		}) },
	] }, target: target(B), priorProjection: prior });
	assert.equal(folded.open_findings[0].stable_id, "OR-1");
	assert.equal(folded.open_findings[0].severity, prior.open_findings[0].severity);
	assert.equal(buildProjection({ candidate: folded, target: target(B),
		checkIdentity: checkIdentity(B), summaryCommentId: 100 }).conclusion, "block");
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
		evidence: "Issue exists", tracker: "ENG-1", owner_or_triage: "the sample owner", decision_head_sha: A,
		comment_id: 50, actor_login: "sample-maintainer" };
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
		evidence: "Issue exists", tracker: "ENG-1", owner_or_triage: "the sample owner", decision_head_sha: A,
		comment_id: 50, actor_login: "sample-maintainer" };
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
		comment_id: 101, actor_login: "sample-maintainer" };
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
		scope: "This PR", evidence: "Issue exists", tracker: "ENG-1", owner_or_triage: "the sample owner",
		decision_head_sha: B, comment_id: 101, actor_login: "sample-maintainer" };
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
			decision_head_sha: A, comment_id: 105, actor_login: "sample-maintainer" };
		assert.throws(() => foldReview({
			output: { new_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1",
				result: "resolved_on_target", evidence: "The proposed design solves this.", finding: modelFinding() }] },
			target: target(), priorProjection: prior, humanDecisions: [decision],
		}), (error) => error.code === "same_head_resolution_requires_challenge");
	}
});
