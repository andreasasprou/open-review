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
		childrenOnParentModel: [],
	});
});

test("names child threads that ran on the parent model without asking for it", (t) => {
	const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "open-review-forked-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const line = (type, payload) => JSON.stringify({ type, payload });
	const usage = line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } } });
	const spawn = (args) => line("response_item", { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ message: "brief", ...args }) });
	const child = (name, model) => [
		line("session_meta", { id: name, thread_source: "subagent", parent_thread_id: "root",
			source: { subagent: { thread_spawn: { agent_path: `/root/${name}` } } } }),
		line("turn_context", { model, effort: "high" }), usage,
	];
	const threads = {
		root: [line("session_meta", { id: "root", thread_source: "user" }), line("turn_context", { model: "parent-x" }),
			spawn({ task_name: "forked_map", model: "child-y", fork_turns: "all" }),
			spawn({ task_name: "unnamed_fork" }),
			spawn({ task_name: "asked_parent", model: "parent-x", fork_turns: "none" }),
			spawn({ task_name: "plain_child", model: "child-y", fork_turns: "none" }), usage],
		forked: child("forked_map", "parent-x"),
		unnamed: child("unnamed_fork", "parent-x"),
		asked: child("asked_parent", "parent-x"),
		plain: child("plain_child", "child-y"),
	};
	for (const [name, lines] of Object.entries(threads)) fs.writeFileSync(path.join(dir, `rollout-${name}.jsonl`), `${lines.join("\n")}\n`);
	const result = sumRolloutUsage(dir, createRecordingCaughtErrorDiagnosticRecorder());
	assert.equal(result.subagentThreads, 4);
	assert.deepEqual(result.childrenOnParentModel, ["/root/forked_map (parent-x)", "/root/unnamed_fork (parent-x)"]);
});

test("the local runner warns about a child on the parent model and leaves the gate alone", () => {
	const local = fs.readFileSync(path.join(__dirname, "..", "engine", "run-local.sh"), "utf8");
	const block = local.slice(local.indexOf("CHILDREN_ON_PARENT_MODEL="), local.indexOf("\nfi\n", local.indexOf("CHILDREN_ON_PARENT_MODEL=")) + 4);
	const run = (rollout) => require("node:child_process").spawnSync("bash", ["-euo", "pipefail", "-c", `RUN_DIR="$(mktemp -d)"; trap 'rm -rf -- "$RUN_DIR"' EXIT\n${block}\ncat "$RUN_DIR/summary.txt" 2>/dev/null || true; echo reached`],
		{ env: { ...process.env, ROLLOUT_USAGE: rollout }, encoding: "utf8" });
	const warned = run(JSON.stringify({ childrenOnParentModel: ["/root/forked_map (parent-x)"] }));
	assert.equal(warned.status, 0, warned.stderr);
	assert.match(warned.stderr, /Warning: child threads ran on the parent model without asking for it \(forked spawn\): \/root\/forked_map \(parent-x\)/);
	assert.match(warned.stdout, /^Warning: child threads ran on the parent model[^\n]*\nreached\n$/);
	for (const rollout of ["{}", JSON.stringify({ childrenOnParentModel: [] })]) {
		const quiet = run(rollout);
		assert.equal(quiet.status, 0, quiet.stderr);
		assert.equal(quiet.stdout, "reached\n");
		assert.equal(quiet.stderr, "");
	}
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
