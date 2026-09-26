"use strict";

// Total token usage for one Codex review run.
//
// `codex exec --json` emits a single `turn.completed` event that carries the
// orchestrator thread only. Subagent threads bill separately and never reach
// that stream, so the event under-reports real usage by 3-4x once fanout is
// enabled (measured on a production review pipeline: 12.41M input reported,
// 41.66M billed).
//
// Every thread does write its own rollout transcript under
// `$CODEX_HOME/sessions/**/rollout-*.jsonl`, and each transcript carries
// `token_count` events whose `info.total_token_usage` is a cumulative counter
// for that thread. Summing the final counter of every transcript gives the
// true total across all threads.

const fs = require("node:fs");
const { recordCaughtError, requireCaughtErrorDiagnosticRecorder, runReviewCli } = require("./diagnostics-runtime.cjs");
const path = require("node:path");

const USAGE_FIELDS = [
	["inputTokens", "input_tokens"],
	["cachedInputTokens", "cached_input_tokens"],
	["outputTokens", "output_tokens"],
	["reasoningOutputTokens", "reasoning_output_tokens"],
];

function emptyTotals() {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
	};
}

function findRolloutFiles(dir, recorder) {
	requireCaughtErrorDiagnosticRecorder(recorder);
	const files = [];
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.usage", stage: "list_rollouts", disposition: "recover", context: {} });
		return files;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...findRolloutFiles(full, recorder));
		} else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
			files.push(full);
		}
	}
	return files.toSorted();
}

function readNonNegativeInt(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.floor(value);
}

// Rollout lines wrap the event in `payload`; the raw `--json` stream does not.
// `session_meta` names itself on the envelope, `token_count` on the payload.
function eventBody(line, recorder) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.usage", stage: "parse_event", disposition: "recover", context: {} });
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const body =
		parsed.payload && typeof parsed.payload === "object"
			? parsed.payload
			: parsed;
	const type = typeof body.type === "string" ? body.type : parsed.type;
	return { type, body };
}

/**
 * Usage totals for a single rollout transcript.
 *
 * `total_token_usage` counters only grow within a thread, so the per-field
 * maximum is the thread total and survives a truncated final line.
 */
function sumRolloutFile(file, recorder) {
	requireCaughtErrorDiagnosticRecorder(recorder);
	const totals = emptyTotals();
	let tokenEvents = 0;
	let isSubagent = false;
	let sessionId = null;
	let originator = null;
	let content;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.usage", stage: "read_rollout", disposition: "recover", context: {} });
		return { totals, tokenEvents, isSubagent, sessionId, originator };
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const event = eventBody(line, recorder);
		if (!event) continue;
		const { type, body } = event;
		if (type === "session_meta") {
			if (typeof body.id === "string") sessionId = body.id;
			if (typeof body.originator === "string") originator = body.originator;
			if (body.thread_source === "subagent" || body.parent_thread_id) {
				isSubagent = true;
			}
			continue;
		}
		if (type !== "token_count") continue;
		const usage = body.info && body.info.total_token_usage;
		if (!usage || typeof usage !== "object") continue;
		let matched = false;
		for (const [key, field] of USAGE_FIELDS) {
			const value = readNonNegativeInt(usage[field]);
			if (value === null) continue;
			matched = true;
			if (value > totals[key]) totals[key] = value;
		}
		if (matched) tokenEvents += 1;
	}
	return { totals, tokenEvents, isSubagent, sessionId, originator };
}

// A resumed round continues the previous round's transcript, whose counters
// already include everything the earlier rounds spent. `Restore prior review
// session` records that starting point so this round reports only its own use.
function baselinesFromEnv(recorder) {
	const raw = process.env.CODEX_RESUME_BASELINE_USAGE;
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.usage", stage: "parse_baseline", disposition: "recover", context: {} });
		return {};
	}
}

/**
 * Usage this round added to one transcript.
 *
 * Counters that continued from the restored session are net of the baseline;
 * a counter below its baseline means the resumed session restarted counting,
 * so the file total already describes this round alone.
 */
function netOfBaseline(fileTotals, baseline) {
	if (!baseline || typeof baseline !== "object") return fileTotals;
	const net = emptyTotals();
	for (const [key] of USAGE_FIELDS) {
		const before = readNonNegativeInt(baseline[key]) ?? 0;
		net[key] =
			fileTotals[key] >= before ? fileTotals[key] - before : fileTotals[key];
	}
	return net;
}

/**
 * Usage totals across every rollout transcript under `sessionsDir`.
 *
 * `threads` counts transcripts that reported usage. A zero means no transcript
 * was readable and the caller must fall back to the `turn.completed` figure.
 */
function sumRolloutUsage(sessionsDir, recorder, baselines = baselinesFromEnv(recorder)) {
	requireCaughtErrorDiagnosticRecorder(recorder);
	const totals = emptyTotals();
	const files = sessionsDir ? findRolloutFiles(sessionsDir, recorder) : [];
	let threads = 0;
	let subagentThreads = 0;
	for (const file of files) {
		const {
			totals: fileTotals,
			tokenEvents,
			isSubagent,
			sessionId,
		} = sumRolloutFile(file, recorder);
		if (tokenEvents === 0) continue;
		threads += 1;
		if (isSubagent) subagentThreads += 1;
		const net = netOfBaseline(fileTotals, sessionId && baselines[sessionId]);
		for (const [key] of USAGE_FIELDS) totals[key] += net[key];
	}
	return { ...totals, threads, subagentThreads, files: files.length };
}

module.exports = { sumRolloutUsage, sumRolloutFile, findRolloutFiles };

if (require.main === module) runReviewCli(recorder => {
	const sessionsDir = process.argv[2];
	process.stdout.write(`${JSON.stringify(sumRolloutUsage(sessionsDir, recorder))}\n`);
});
