"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createRecordingCaughtErrorDiagnosticRecorder } = require("./helpers/recording-recorder.cjs");
const { buildMetadataFooter } = require("../engine/index.cjs");
const { sumRolloutUsage } = require("../engine/rollout-usage.cjs");

const SESSIONS_DIR = path.join(__dirname, "fixtures", "rollout-sessions");
const WORKFLOW_PATH = path.join(__dirname, "..", "action.yml");
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, "utf8");

// The degraded-transcript branch of the Run Codex step. Reading the filters out
// of the action keeps these assertions honest: a filter that stops reading the
// event, or goes back to a hard-coded zero, fails here.
function turnCompletedFallbackFilter(variableName) {
	const pattern = new RegExp(
		`^\\s*${variableName}=\\$\\(echo "\\$USAGE_JSON" \\| jq -r '(.+)'\\)$`,
		"m",
	);
	const match = WORKFLOW.match(pattern);
	assert.ok(match, `no turn.completed fallback filter for ${variableName}`);
	return match[1];
}

function runJq(filter, event) {
	return execFileSync("jq", ["-r", filter], {
		input: event,
		encoding: "utf8",
	}).trim();
}

test("sums the final counter of every rollout transcript", () => {
	const usage = sumRolloutUsage(SESSIONS_DIR, createRecordingCaughtErrorDiagnosticRecorder());
	assert.deepEqual(usage, {
		inputTokens: 1000,
		cachedInputTokens: 600,
		outputTokens: 100,
		reasoningOutputTokens: 60,
		threads: 2,
		subagentThreads: 1,
		files: 3,
	});
});

test("reports no threads when the sessions directory is missing", () => {
	const usage = sumRolloutUsage(path.join(SESSIONS_DIR, "absent"), createRecordingCaughtErrorDiagnosticRecorder());
	assert.equal(usage.threads, 0);
	assert.equal(usage.inputTokens, 0);
});

test("reports no threads when no directory is given", () => {
	assert.equal(sumRolloutUsage(undefined, createRecordingCaughtErrorDiagnosticRecorder()).threads, 0);
});

test("footer names the thread count when every thread is counted", () => {
	const footer = buildMetadataFooter({
		inputTokens: "39834453",
		cachedTokens: "37442816",
		outputTokens: "104489",
		reasoningTokens: "61091",
		usageScope: "all-threads",
		threadCount: "5",
		subagentCount: "4",
	});
	assert.match(footer, /\| Input tokens \| 39,834,453 \|/);
	assert.match(footer, /\| Reasoning tokens \| 61,091 \|/);
	assert.match(
		footer,
		/\| Token scope \| all 5 threads \(1 orchestrator \+ 4 subagent\) \|/,
	);
});

test("footer flags the orchestrator-only fallback", () => {
	const footer = buildMetadataFooter({
		inputTokens: "40000",
		outputTokens: "2000",
		usageScope: "orchestrator-only",
	});
	assert.match(footer, /\| Token scope \| orchestrator thread only \|/);
	assert.match(footer, /\| Reasoning tokens \| 0 \|/);
});

test("the degraded fallback reads every token field from turn.completed", () => {
	const event = JSON.stringify({
		type: "turn.completed",
		usage: {
			input_tokens: 40000,
			cached_input_tokens: 30000,
			output_tokens: 2000,
			reasoning_output_tokens: 17402,
		},
	});
	assert.equal(
		runJq(turnCompletedFallbackFilter("INPUT_TOKENS"), event),
		"40000",
	);
	assert.equal(
		runJq(turnCompletedFallbackFilter("CACHED_TOKENS"), event),
		"30000",
	);
	assert.equal(
		runJq(turnCompletedFallbackFilter("OUTPUT_TOKENS"), event),
		"2000",
	);
	// The regression this guards: reasoning was hard-coded to 0 in this branch.
	assert.equal(
		runJq(turnCompletedFallbackFilter("REASONING_TOKENS"), event),
		"17402",
	);
});

test("the degraded fallback reports zero for token fields the event omits", () => {
	const event = JSON.stringify({ type: "turn.completed", usage: {} });
	for (const variableName of [
		"INPUT_TOKENS",
		"CACHED_TOKENS",
		"OUTPUT_TOKENS",
		"REASONING_TOKENS",
	]) {
		assert.equal(runJq(turnCompletedFallbackFilter(variableName), event), "0");
	}
});
