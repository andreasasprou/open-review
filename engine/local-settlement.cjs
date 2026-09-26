#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { runReviewCli } = require("./diagnostics-runtime.cjs");

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

function buildLocalSettlement({ output, patch }) {
	const reviewMarkdown = String(output?.review_markdown || "").trim();
	if (!reviewMarkdown) {
		throw new Error("review output has no review_markdown");
	}

	const verdict = extractVerdict(reviewMarkdown);
	const mergeGate = deriveMergeGate(output?.state);
	const mergeGateSummary = formatMergeGateSummary(mergeGate, verdict);
	const mergeGateLine = mergeGateSummary.split("\n", 1)[0];
	const inline = buildInlineApiComments({
		inlineComments: output?.inline_comments,
		reviewState: output?.state,
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
	};
}

function main(argv) {
	const [outputPath, patchPath] = argv;
	if (!outputPath || !patchPath) {
		throw new Error(
			"usage: local-settlement.cjs <codex-review-output.json> <pr-diff.patch>",
		);
	}

	const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
	const patch = fs.readFileSync(patchPath, "utf8");
	process.stdout.write(`${JSON.stringify(buildLocalSettlement({ output, patch }))}\n`);
}

if (require.main === module) runReviewCli(() => main(process.argv.slice(2)));

module.exports = {
	STATUS_DESCRIPTION_LIMIT,
	buildInlineApiComments,
	buildLocalSettlement,
	plainMergeGateLine,
	truncateStatusDescription,
};
