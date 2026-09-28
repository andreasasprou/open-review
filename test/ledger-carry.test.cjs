"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildProjection, foldReview, readProjectionComment } = require("../engine/ledger/projection.cjs");
const { publishCarriedProjection } = require("../engine/ledger/carry.cjs");

const A = "a".repeat(40);
const B = "b".repeat(40);
const target = { repository: "example-org/sample-app", pr_number: 123, base_ref: "main", base_sha: B,
	merge_base_sha: B, head_sha: A, trusted_reviewer_ref: B, evidence_bundle_sha256: "c".repeat(64),
	evidence_schema_version: 2 };
const identity = { workflow_path: ".github/workflows/review.yml",
	workflow_ref: "example-org/sample-app/.github/workflows/review.yml@refs/heads/main",
	trusted_workflow_sha: B, workflow_run_id: "1234", workflow_run_attempt: 1, workflow_job_id: 88,
	check_run_id: 99, check_suite_id: 77, app_slug: "github-actions", head_sha: A };
const finding = { stable_id: "OR-1", severity: "P1", reachability: "normal_path", likelihood: "medium",
	likely_consequence: "A request fails.", worst_credible_consequence: "A request is lost.",
	recoverability: "operational_intervention", proof_strength: "deterministic_static_proof", attribution: "introduced",
	risk_rationale: "The write drops a row.", disposition: "FIX_IN_PR", autonomous_eligibility: "YES",
	title: "Lost request", failure_scenario: "The request is lost.", approved_invariant: "Keep requests.",
	where: "src/request.ts:10", evidence: "Write omits row.", affected_lifecycle_planes: [] };

test("same-head carry publishes a new blocked projection bound to attempt 2", async () => {
	const first = foldReview({ output: { new_findings: [finding], prior_issue_evaluations: [] }, target });
	const priorProjection = buildProjection({ candidate: first, target, checkIdentity: identity, summaryCommentId: 50 });
	let body;
	const github = { rest: { pulls: { get: async () => ({ data: {
		head: { sha: A }, base: { sha: B, ref: "main" } } }) },
		issues: { createComment: async (args) => { body = args.body; return { data: { id: 51 } }; } } } };
	const nextIdentity = { ...identity, workflow_run_attempt: 2, check_run_id: 100, workflow_job_id: 89 };
	const lines = [];
	const carried = await publishCarriedProjection({ github, owner: "example-org", repo: "sample-app",
		prNumber: 123, priorProjection, target, checkIdentity: nextIdentity, log: (line) => lines.push(line) });
	assert.equal(readProjectionComment(body).check_identity.workflow_run_attempt, 2);
	assert.equal(carried.conclusion, "block");
	assert.equal(carried.summary_comment_id, 50);
	assert.match(lines[0], /Published additive projection comment 51 with projection SHA-256/);
	assert.match(lines[0], /^\[codex-review\] Published additive projection comment/);
});

test("same-head carry refuses a changed base or merge base", async () => {
	const first = foldReview({ output: { new_findings: [finding], prior_issue_evaluations: [] }, target });
	const priorProjection = buildProjection({ candidate: first, target, checkIdentity: identity, summaryCommentId: 50 });
	const github = { rest: { pulls: { get: async () => { throw new Error("Must reject before publication"); } } } };
	for (const changed of [{ base_sha: B.replace(/^b/, "c") }, { merge_base_sha: B.replace(/^b/, "c") }]) {
		await assert.rejects(publishCarriedProjection({ github, owner: "example-org", repo: "sample-app", prNumber: 123,
			priorProjection, target: { ...target, ...changed },
			checkIdentity: { ...identity, workflow_run_attempt: 2 } }), /target changed/);
	}
});

test("same-head carry requires a newer attempt and fresh authority", async () => {
	const first = foldReview({ output: { new_findings: [finding], prior_issue_evaluations: [] }, target });
	const priorProjection = buildProjection({ candidate: first, target, checkIdentity: identity, summaryCommentId: 50 });
	const github = { rest: { pulls: { get: async () => ({ data: {
		head: { sha: A }, base: { sha: B, ref: "main" } } }) },
		issues: { createComment: async () => { throw new Error("Must not publish"); } } } };
	await assert.rejects(publishCarriedProjection({ github, owner: "example-org", repo: "sample-app", prNumber: 123,
		priorProjection, target, checkIdentity: identity }), /newer workflow run or attempt/);
	await assert.rejects(publishCarriedProjection({ github, owner: "example-org", repo: "sample-app", prNumber: 123,
		priorProjection, target, checkIdentity: { ...identity, workflow_run_attempt: 2 },
		revalidateAuthority: async () => { throw new Error("Authority changed"); } }), /Authority changed/);
});

test("same-head scope reviews a pending source-ledger event instead of carrying", () => {
	const action = fs.readFileSync(path.join(__dirname, "..", "action.yml"), "utf8");
	const expression = [...action.matchAll(/if jq -e '([^']+)'/gs)][1]?.[1];
	assert.ok(expression);
	const snapshot = { priorProjection: { human_decisions: [], consumed_evidence_challenge_refs: [] },
		humanDecisions: [], evidenceChallenges: [] };
	for (const [modelReviewRequired, expected] of [[true, "true"], [false, "false"]]) {
		const result = spawnSync("jq", ["-e", expression], { input: JSON.stringify({ ...snapshot, modelReviewRequired }),
			encoding: "utf8" });
		assert.equal(result.stdout.trim(), expected, result.stderr);
	}
});
