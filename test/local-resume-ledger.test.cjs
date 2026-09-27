"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { select, hasUsableLocalLedger } = require("../engine/local-resume.cjs");
const { createRecordingCaughtErrorDiagnosticRecorder } = require("./helpers/recording-recorder.cjs");

test("local resume refuses incremental scope without a usable v4 ledger", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-local-ledger-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.test");
	fs.writeFileSync(path.join(root, "source.txt"), "base\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const mergeBaseSha = git("rev-parse", "HEAD");
	fs.writeFileSync(path.join(root, "source.txt"), "previous\n");
	git("commit", "-qam", "previous");
	const priorHead = git("rev-parse", "HEAD");
	fs.writeFileSync(path.join(root, "source.txt"), "current\n");
	git("commit", "-qam", "current");
	const headSha = git("rev-parse", "HEAD");
	const runDir = path.join(root, ".agent-data/codex-review-local/pr-1-saved");
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "resume-metadata.json"), JSON.stringify({
		repository: "o/r", prNumber: "1", headSha: priorHead, mergeBaseSha,
		model: "gpt-6-astra", promptBlob: "prompt", savedAt: "2026-09-27T00:00:00Z",
	}));
	fs.writeFileSync(path.join(runDir, "codex-review-output.json"), JSON.stringify({
		review_markdown: "## Verdict: BLOCK", state: { schema_version: 1, last_reviewed_head_sha: priorHead },
		new_findings: [], prior_issue_evaluations: [],
	}));
	const input = { recorder: createRecordingCaughtErrorDiagnosticRecorder(), root, repository: "o/r",
		prNumber: "1", headSha, mergeBaseSha, model: "gpt-6-astra", promptBlob: "prompt" };
	assert.equal(select(input).reason, "missing_local_ledger");
	fs.writeFileSync(path.join(runDir, "local-settlement.json"), JSON.stringify({ ledger: { open_findings: [] } }));
	assert.equal(select(input).reason, "missing_local_ledger");
	fs.writeFileSync(path.join(runDir, "local-settlement.json"), JSON.stringify({
		mergeGate: { status: "BLOCK" }, ledger: { review_target: { head_sha: priorHead },
			open_findings: [], closed_findings: [], prior_issue_evaluations: [] },
	}));
	assert.equal(hasUsableLocalLedger(runDir, priorHead), false);
	fs.writeFileSync(path.join(runDir, "local-settlement.json"), JSON.stringify({
		mergeGate: { status: "PASS" }, ledger: { review_target: { head_sha: priorHead },
			open_findings: [], closed_findings: [], prior_issue_evaluations: [] },
	}));
	assert.equal(hasUsableLocalLedger(runDir, priorHead), true);
});
