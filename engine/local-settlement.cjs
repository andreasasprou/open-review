#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { runReviewCli } = require("./diagnostics-runtime.cjs");
const { foldReview } = require("./ledger/projection.cjs");

const {
	buildIssueSeverityMap,
	deriveMergeGate,
	extractVerdict,
	formatInlineBody,
	formatMergeGateSummary,
	parseDiffHunks,
	validateInlineComments,
} = require("./index.cjs");

const STATUS_DESCRIPTION_LIMIT = 140;

function plainMergeGateLine(markdownLine) {
	return String(markdownLine || "").replaceAll("**", "");
}

function truncateStatusDescription(value, limit = STATUS_DESCRIPTION_LIMIT) {
	const characters = Array.from(String(value || "").trim());
	if (characters.length <= limit) return characters.join("");
	return `${characters.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}

function buildInlineApiComments({ inlineComments, reviewState, patch }) {
	const warnings = [];
	const candidates = Array.isArray(inlineComments) ? inlineComments : [];
	const hunkAllowlist = parseDiffHunks({ patch });
	const diffValidatedComments = validateInlineComments({
		inlineComments: candidates,
		hunkAllowlist,
		log: (message) => warnings.push(message),
	});
	const validatedComments = diffValidatedComments.filter((comment) => {
		if (
			comment.start_line != null &&
			(!Number.isInteger(comment.start_line) || comment.start_line >= comment.line)
		) {
			warnings.push(
				`Skipping inline comment ${comment.issue_id}: start_line must be an integer before line`,
			);
			return false;
		}
		return true;
	});
	const severityByIssueId = buildIssueSeverityMap(reviewState);

	return {
		candidateCount: candidates.length,
		validatedCount: validatedComments.length,
		warnings,
		comments: validatedComments.map((comment) => ({
			path: comment.file,
			line: comment.line,
			...(comment.start_line != null
				? { start_line: comment.start_line, start_side: "RIGHT" }
				: {}),
			side: "RIGHT",
			body: formatInlineBody(
				comment,
				severityByIssueId.get(comment.issue_id),
			),
		})),
	};
}

// After a block, an incremental review gates only on the files it reviewed: a
// new finding whose location names none of `changedFiles` is published as
// advisory and left out of the ledger (decision converge-after-block).
function outsideChangedFiles(ledger, changedFiles) {
	const outside = ledger.new_findings.filter((finding) => !changedFiles.some((file) => finding.where.includes(file)));
	const kept = (finding) => !outside.includes(finding);
	return { outside, ledger: { ...ledger, new_findings: ledger.new_findings.filter(kept), open_findings: ledger.open_findings.filter(kept) } };
}

function buildLocalSettlement({ output, patch, priorProjection = null, changedFiles = null }) {
	const reviewMarkdown = String(output?.review_markdown || "").trim();
	if (!reviewMarkdown) {
		throw new Error("review output has no review_markdown");
	}

	const verdict = extractVerdict(reviewMarkdown);
	const headSha = output?.state?.last_reviewed_head_sha;
	// Local settlement has no hosted evidence bundle. Retain the prior target's
	// identity when present and use a deterministic local identity for cold runs.
	const target = { repository: "local/open-review", pr_number: 1,
		base_ref: "local", base_sha: headSha, merge_base_sha: headSha,
		trusted_reviewer_ref: headSha, evidence_bundle_sha256: "0".repeat(64),
		evidence_schema_version: 2, ...priorProjection?.review_target, head_sha: headSha };
	const { ledger, outside } = changedFiles
		? outsideChangedFiles(foldReview({ output, target, priorProjection }), changedFiles)
		: { ledger: foldReview({ output, target, priorProjection }), outside: [] };
	const mergeGate = deriveMergeGate({ open_findings: ledger.open_findings });
	const capWarning = ledger.warnings.find((warning) => warning.includes("reachable blockers exceed"));
	const gateLines = formatMergeGateSummary(mergeGate, verdict).split("\n");
	if (outside.length > 0)
		gateLines.splice(-1, 0, `Advisory, outside the changed files: ${outside.map((finding) => finding.stable_id).join(", ")}`);
	const mergeGateSummary = `${gateLines.join("\n")}${capWarning ? `\n${capWarning}` : ""}`;
	const mergeGateLine = mergeGateSummary.split("\n", 1)[0];
	const inline = buildInlineApiComments({
		inlineComments: output?.inline_comments,
		reviewState: { open_findings: ledger.open_findings },
		patch,
	});

	return {
		reviewMarkdown,
		verdict,
		mergeGate,
		mergeGateSummary,
		mergeGateLine,
		statusState: mergeGate.status === "PASS" ? "success" : "failure",
		statusDescription: truncateStatusDescription(
			plainMergeGateLine(mergeGateLine),
		),
		inline,
		ledger: { ...ledger, review_target: target },
	};
}

function main(argv) {
	const [outputPath, patchPath, priorPath, changedFilesPath] = argv;
	if (!outputPath || !patchPath) {
		throw new Error(
			"usage: local-settlement.cjs <codex-review-output.json> <pr-diff.patch> [prior-projection.json] [changed-files.txt]",
		);
	}

	const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
	const patch = fs.readFileSync(patchPath, "utf8");
	const priorProjection = priorPath && fs.existsSync(priorPath) ? JSON.parse(fs.readFileSync(priorPath, "utf8")) : null;
	const changedFiles = changedFilesPath ? fs.readFileSync(changedFilesPath, "utf8").split("\n").filter(Boolean) : null;
	process.stdout.write(`${JSON.stringify(buildLocalSettlement({ output, patch, priorProjection, changedFiles }))}\n`);
}

if (require.main === module) runReviewCli(() => main(process.argv.slice(2)));

module.exports = {
	STATUS_DESCRIPTION_LIMIT,
	buildInlineApiComments,
	buildLocalSettlement,
	plainMergeGateLine,
	truncateStatusDescription,
};
