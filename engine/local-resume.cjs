"use strict";

// Local review continuity lives with the existing, checkout-scoped run evidence.
// Save only after trusted settlement; never copy authentication or Codex databases.
const fs = require("node:fs");
const { recordCaughtError, runReviewCli } = require("./diagnostics-runtime.cjs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { findRolloutFiles } = require("./rollout-usage.cjs");
const { readRollout, readStreamIdentity, sessionDateDir, installResumedRollout } = require("./resume.cjs");
const { settlement } = require("./ledger/projection.cjs");

function json(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readParent(recorder, file, sessionId, model, expectedDigest) {
	const content = fs.readFileSync(file, "utf8");
	if (expectedDigest && createHash("sha256").update(content).digest("hex") !== expectedDigest) {
		throw new Error("saved parent transcript changed or was truncated");
	}
	// A truncated transcript cannot be accepted as complete native history.
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (line.trim()) JSON.parse(line);
	}
	const rollout = readRollout(recorder, fs, file);
	if (!rollout || rollout.sessionId !== sessionId || rollout.model !== model ||
		rollout.originator !== "codex_exec" || rollout.isSubagent || !sessionDateDir(file)) {
		throw new Error("parent session identity or model mismatch");
	}
	return rollout;
}

function readReview(runDir, headSha) {
	const review = json(path.join(runDir, "codex-review-output.json"));
	if (!review.review_markdown || review.state?.schema_version !== 1 ||
		review.state.last_reviewed_head_sha !== headSha ||
		!Array.isArray(review.new_findings) || !Array.isArray(review.prior_issue_evaluations)) {
		throw new Error("saved review state does not identify the reviewed head");
	}
	return review;
}

function hasUsableLocalLedger(runDir, headSha) {
	try {
		const saved = json(path.join(runDir, "local-settlement.json"));
		const ledger = saved.ledger;
		return ledger?.review_target?.head_sha === headSha &&
			Array.isArray(ledger.open_findings) &&
			Array.isArray(ledger.closed_findings) &&
			Array.isArray(ledger.prior_issue_evaluations) &&
			ledger.open_findings.every((finding) => typeof finding.stable_id === "string" &&
				["P0", "P1", "P2"].includes(finding.severity) &&
				["normal_path", "compound_path", "theoretical"].includes(finding.reachability)) &&
			saved.mergeGate?.status === (settlement(ledger.open_findings).conclusion === "block" ? "BLOCK" : "PASS");
	} catch {
		return false;
	}
}

function select({ recorder, root, repository, prNumber, headSha, mergeBaseSha, model, promptBlob }) {
	const runsRoot = path.join(root, ".agent-data/codex-review-local");
	const candidates = [];
	for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(`pr-${prNumber}-`)) continue;
		const runDir = path.join(runsRoot, entry.name);
		const metadataPath = path.join(runDir, "resume-metadata.json");
		if (!fs.existsSync(metadataPath)) continue;
		try {
			const metadata = json(metadataPath);
			if (metadata.repository === repository && metadata.prNumber === prNumber) {
				candidates.push({ runDir, metadata });
			}
		} catch (error) {
			recordCaughtError({ recorder, error, operation: "review.local_resume", stage: "metadata", disposition: "recover", context: {} });

		}
	}
	candidates.sort((a, b) => b.metadata.savedAt.localeCompare(a.metadata.savedAt));
	const previous = candidates[0];
	if (!previous) return { resumable: false, reason: "no_prior_local_session" };
	const { metadata, runDir } = previous;
	const refuse = (reason) => ({ resumable: false, reason });
	if (metadata.model !== model) return refuse("model_changed");
	// A resumed parent keeps the instructions it was started with, so a prompt
	// rollout must start a fresh parent or the new prompt never takes effect.
	if (metadata.promptBlob !== promptBlob) return refuse("prompt_changed");
	if (metadata.mergeBaseSha !== mergeBaseSha) return refuse("merge_base_changed");
	if (!/^[0-9a-f]{40}$/.test(metadata.headSha)) return refuse("invalid_previous_head");
	const git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	try {
		git(["merge-base", "--is-ancestor", metadata.headSha, headSha]);
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.local_resume", stage: "ancestry", disposition: "recover", context: {} });

		return refuse("previous_head_missing_or_rewritten");
	}
	if (!git(["diff", "--name-only", metadata.headSha, headSha]).trim()) return refuse("empty_repair_delta");
	readReview(runDir, metadata.headSha);
	if (!hasUsableLocalLedger(runDir, metadata.headSha)) return refuse("missing_local_ledger");
	const rolloutPath = path.join(runDir, "parent-session", metadata.basename);
	if (path.basename(metadata.basename) !== metadata.basename) throw new Error("invalid rollout basename");
	if (typeof metadata.rolloutDigest !== "string") return refuse("missing_transcript_digest");
	readParent(recorder, rolloutPath, metadata.sessionId, model, metadata.rolloutDigest);
	return { resumable: true, reason: "resumable", runDir, headSha: metadata.headSha,
		sessionId: metadata.sessionId, basename: metadata.basename, model };
}

function install({ recorder, selectionFile, codexHome }) {
	const selection = json(selectionFile);
	if (!hasUsableLocalLedger(selection.runDir, selection.headSha))
		throw new Error("saved local ledger is unavailable; start a full review");
	const parent = readParent(recorder, path.join(selection.runDir, "parent-session", selection.basename), selection.sessionId, selection.model, selection.rolloutDigest);
	fs.copyFileSync(path.join(selection.runDir, "codex-review-output.json"), path.join(path.dirname(selectionFile), "resumed-review.json"));
	const settlement = path.join(selection.runDir, "local-settlement.json");
	fs.copyFileSync(settlement, path.join(path.dirname(selectionFile), "resumed-settlement.json"));
	installResumedRollout({ codexHome, rollout: {
		basename: selection.basename,
		dateDir: sessionDateDir(parent.file),
		content: parent.content,
	} });
}

function save({ recorder, runDir, codexHome, repository, prNumber, headSha, mergeBaseSha, model, promptBlob }) {
	readReview(runDir, headSha);
	if (!hasUsableLocalLedger(runDir, headSha)) throw new Error("settled local ledger is unavailable");
	const sessionId = readStreamIdentity(recorder, fs, runDir, "codex-output.jsonl")?.threadId;
	if (!sessionId) throw new Error("review stream has no parent thread identity");
	const matches = findRolloutFiles(path.join(codexHome, "sessions"), recorder)
		.filter((file) => readRollout(recorder, fs, file)?.sessionId === sessionId);
	if (matches.length !== 1) throw new Error("review parent rollout is missing or ambiguous");
	const parent = readParent(recorder, matches[0], sessionId, model);
	const parentDir = path.join(runDir, "parent-session");
	fs.mkdirSync(parentDir, { mode: 0o700 });
	const basename = path.basename(parent.file);
	fs.writeFileSync(path.join(parentDir, basename), parent.content, { mode: 0o600, flag: "wx" });
	// Written last: failed or interrupted runs cannot become resume candidates.
	fs.writeFileSync(path.join(runDir, "resume-metadata.json"), JSON.stringify({
		repository, prNumber, headSha, mergeBaseSha, model, promptBlob, sessionId, basename,
		rolloutDigest: createHash("sha256").update(parent.content).digest("hex"),
		savedAt: new Date().toISOString(),
	}), { mode: 0o600, flag: "wx" });
}

if (require.main === module) runReviewCli(recorder => {
	const [operation, ...args] = process.argv.slice(2);
	if (operation === "install") {
		const [selectionFile, codexHome] = args;
		return install({ recorder, selectionFile, codexHome });
	}
	if (operation === "save") {
		const [runDir, codexHome, repository, prNumber, headSha, mergeBaseSha, model, promptBlob] = args;
		return save({ recorder, runDir, codexHome, repository, prNumber, headSha, mergeBaseSha, model, promptBlob });
	}
	if (operation !== "select") throw new Error(`unknown local resume operation: ${operation}`);
	try {
		const [root, repository, prNumber, headSha, mergeBaseSha, model, promptBlob] = args;
		console.log(JSON.stringify(select({ recorder, root, repository, prNumber, headSha, mergeBaseSha, model, promptBlob })));
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.local_resume", stage: "execute", disposition: "recover", context: {} });
		console.log(JSON.stringify({ resumable: false, reason: "unavailable_local_history" }));
	}
});

module.exports = { select, hasUsableLocalLedger };
