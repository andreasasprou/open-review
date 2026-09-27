"use strict";

const { buildProjection, foldReview, formatProjectionComment } = require("./projection.cjs");

async function publishCarriedProjection({ github, owner, repo, prNumber, priorProjection, target,
	checkIdentity, humanDecisions = [], log = console.log,
	revalidateAuthority = async () => {} }) {
	if (!priorProjection || priorProjection.review_target.head_sha !== target.head_sha ||
		priorProjection.review_target.repository !== target.repository ||
		priorProjection.review_target.pr_number !== prNumber) {
		throw new Error("Same-head carry has no matching prior projection");
	}
	// A carry is valid only for the exact reviewed code target. The evidence
	// bundle may change with new comments, but code and reviewer identity may not.
	for (const field of ["base_ref", "base_sha", "merge_base_sha", "trusted_reviewer_ref"]) {
		if (priorProjection.review_target[field] !== target[field])
			throw new Error(`Same-head carry target changed: ${field}`);
	}
	const priorCheck = priorProjection.check_identity;
	const currentRun = BigInt(checkIdentity.workflow_run_id);
	const priorRun = BigInt(priorCheck.workflow_run_id);
	if (currentRun < priorRun || currentRun === priorRun &&
		checkIdentity.workflow_run_attempt <= priorCheck.workflow_run_attempt) {
		throw new Error("Same-head carry requires a newer workflow run or attempt");
	}
	await revalidateAuthority();
	const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
	if (pull.head.sha !== target.head_sha || pull.base.sha !== target.base_sha ||
		pull.base.ref !== target.base_ref) throw new Error("Review target moved before carried projection");
	const candidate = foldReview({ output: { new_findings: [], prior_issue_evaluations: [] }, target,
		priorProjection, humanDecisions });
	const projection = buildProjection({ candidate, target, checkIdentity,
		summaryCommentId: priorProjection.summary_comment_id, humanDecisions });
	formatProjectionComment(projection);
	await revalidateAuthority();
	const { data: finalPull } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
	if (finalPull.head.sha !== target.head_sha || finalPull.base.sha !== target.base_sha ||
		finalPull.base.ref !== target.base_ref) throw new Error("Review target moved before carried projection publication");
	const { data: comment } = await github.rest.issues.createComment({ owner, repo,
		issue_number: prNumber, body: formatProjectionComment(projection) });
	log(`[codex-review] Published additive projection comment ${comment.id} with projection SHA-256 ${projection.projection_sha256}.`);
	return projection;
}

module.exports = { publishCarriedProjection };
