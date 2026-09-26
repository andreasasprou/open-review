"use strict";

// Decide whether this review round may continue the Codex session that
// reviewed the previous head of the same pull request.
//
// Round 1 reviews the whole target from a cold session and uploads its
// transcripts as `code-review-transcripts-<attempt>`. Round 2+ can restore the
// orchestrator rollout from that artifact and run `codex exec resume`, which
// replays the round-1 context instead of re-deriving it from the prompt. The
// session is an accelerator only: the posted review state stays the sole
// settlement authority, and every refusal here falls back to a cold review.
//
// Two findings from production use are folded in: the artifact API returns
// 5xx often enough to need a retry, and a restored conversation keeps its own
// tool surface, so the caller must still pin the subagent model.

const nodeChildProcess = require("node:child_process");
const nodeFs = require("node:fs");
const nodeOs = require("node:os");
const { recordCaughtError, requireCaughtErrorDiagnosticRecorder } = require("./diagnostics-runtime.cjs");
const nodePath = require("node:path");
const { findRolloutFiles } = require("./rollout-usage.cjs");

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;
const ROLLOUT_BASENAME_RE =
	/^rollout-(\d{4})-(\d{2})-(\d{2})T[\dT:-]+-.+\.jsonl$/;

// Every refusal reason is a stable anchor: each round publishes its reason in
// the review footer, so the real fallback rate is countable by these ids.
const REFUSAL = {
	NO_PRIOR: "g1_no_prior_state",
	PRIOR_HEAD: "g1_prior_head_sha_invalid",
	RUN_ID: "g2_prior_run_id_invalid",
	REBASED: "g3_prior_head_not_ancestor",
	MERGE_BASE: "g4_merge_base_moved",
	ARTIFACT: "g5_transcript_artifact_unavailable",
	ORCHESTRATOR: "g6_orchestrator_rollout_not_identified",
	MODEL: "g7_model_drift",
	EMPTY_DELTA: "g9_empty_repair_delta",
	HEAD_MOVED: "g10_head_moved_during_run",
	ERROR: "error_resume_resolution_failed",
};

function refuse(reason) {
	return {
		resumable: false,
		sessionId: null,
		lastReviewedSha: null,
		priorRunId: null,
		reason,
		rollout: null,
		telemetry: null,
	};
}

function isFullSha(value) {
	return typeof value === "string" && FULL_SHA_RE.test(value);
}

// Rollout lines wrap the event in `payload`; the raw `--json` stream does not.
function eventBody(recorder, line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.resume", stage: "parse_event", disposition: "recover", context: {} });
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

function findFile(recorder, fs, dir, name) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.resume", stage: "find_file", disposition: "recover", context: {} });
		return null;
	}
	for (const entry of entries.toSorted((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const full = nodePath.join(dir, entry.name);
		if (entry.isDirectory()) {
			const found = findFile(recorder, fs, full, name);
			if (found) return found;
		} else if (entry.isFile() && entry.name === name) {
			return full;
		}
	}
	return null;
}

/** Thread id and model of the run that produced this artifact. */
function readStreamIdentity(recorder, fs, dir, filename = "codex-output.json") {
	requireCaughtErrorDiagnosticRecorder(recorder);
	const file = findFile(recorder, fs, dir, filename);
	if (!file) return null;
	let content;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.resume", stage: "read_stream", disposition: "recover", context: {} });
		return null;
	}
	for (const line of content.split("\n")) {
		if (!line.includes('"thread.started"')) continue;
		const event = eventBody(recorder, line);
		if (!event || event.type !== "thread.started") continue;
		const threadId = event.body.thread_id;
		if (typeof threadId !== "string" || !threadId) continue;
		return {
			threadId,
			model: typeof event.body.model === "string" ? event.body.model : null,
		};
	}
	return null;
}

/**
 * Session identity, model and usage recorded in one rollout transcript.
 *
 * `session_meta` names the thread; a subagent carries `thread_source` or
 * `parent_thread_id`. The model lives on `turn_context`, and the last one wins
 * because a mid-session model change is what gate g7 must catch.
 */
function readRollout(recorder, fs, file) {
	requireCaughtErrorDiagnosticRecorder(recorder);
	let content;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.resume", stage: "read_rollout", disposition: "recover", context: {} });
		return null;
	}
	let sessionId = null;
	let originator = null;
	let isSubagent = false;
	let model = null;
	let contextInputTokens = 0;
	let contextWindow = 0;
	let baselineUsage = null;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const event = eventBody(recorder, line);
		if (!event) continue;
		const { type, body } = event;
		if (type === "session_meta") {
			sessionId = typeof body.id === "string" ? body.id : null;
			originator = typeof body.originator === "string" ? body.originator : null;
			if (body.thread_source === "subagent" || body.parent_thread_id) {
				isSubagent = true;
			}
			if (typeof body.model === "string") model = body.model;
			continue;
		}
		if (type === "turn_context") {
			if (typeof body.model === "string") model = body.model;
			continue;
		}
		if (type !== "token_count") continue;
		const info = body.info;
		if (!info || typeof info !== "object") continue;
		const last = info.last_token_usage;
		if (last && Number.isFinite(last.input_tokens)) {
			contextInputTokens = last.input_tokens;
		}
		if (Number.isFinite(info.model_context_window)) {
			contextWindow = info.model_context_window;
		}
		const total = info.total_token_usage;
		if (total && typeof total === "object") {
			baselineUsage = {
				inputTokens: Number(total.input_tokens) || 0,
				cachedInputTokens: Number(total.cached_input_tokens) || 0,
				outputTokens: Number(total.output_tokens) || 0,
				reasoningOutputTokens: Number(total.reasoning_output_tokens) || 0,
			};
		}
	}
	return {
		file,
		content,
		sessionId,
		originator,
		isSubagent,
		model,
		contextInputTokens,
		contextWindow,
		baselineUsage,
	};
}

/** `sessions/<yyyy>/<mm>/<dd>` of a restored rollout, preserved on install. */
function sessionDateDir(file) {
	const parts = file.split(nodePath.sep);
	const index = parts.lastIndexOf("sessions");
	if (index >= 0 && parts.length >= index + 4) {
		const candidate = parts.slice(index + 1, index + 4).join("/");
		if (SESSION_DATE_RE.test(candidate)) return candidate;
	}
	const match = ROLLOUT_BASENAME_RE.exec(nodePath.basename(file));
	return match ? `${match[1]}/${match[2]}/${match[3]}` : null;
}

/**
 * Retry a GitHub API call that failed for a reason unrelated to this review.
 *
 * The artifact endpoints return 5xx often enough to matter: two rounds of one
 * PR once lost their resume to "No server is currently available" and each
 * paid for a cold full review. Only transport-shaped
 * failures retry; a 404 or a permissions error still refuses immediately, so
 * the fail-open behaviour of the surrounding resolver is unchanged.
 */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isTransientApiError(error) {
	if (!error) return false;
	if (TRANSIENT_STATUS.has(error.status)) return true;
	return /no server is currently available|socket hang up|ETIMEDOUT|ECONNRESET/i.test(
		error.message || "",
	);
}

const defaultBackoff = (attempt) =>
	new Promise((done) => setTimeout(done, attempt * 1000));

async function withTransientRetry(
	call,
	{ recorder, attempts = 3, sleep = defaultBackoff, attempt = 1 },
) {
	requireCaughtErrorDiagnosticRecorder(recorder);
	const [result] = await Promise.allSettled([Promise.resolve().then(call)]);
	if (result.status === "fulfilled") return result.value;
	const error = result.reason;
	if (attempt >= attempts || !isTransientApiError(error)) {
		recordCaughtError({ recorder, error, operation: "review.resume", stage: "artifact_request", disposition: "propagate", context: {} });
		throw error;
	}
	recordCaughtError({ recorder, error, operation: "review.resume", stage: "artifact_request", disposition: "recover", context: {} });
	if (sleep) await sleep(attempt);
	return withTransientRetry(call, { recorder, attempts, sleep, attempt: attempt + 1 });
}

/** Download and unpack the prior run's transcript artifact. */
async function defaultDownloadTranscripts({
	recorder,
	github,
	owner,
	repo,
	runId,
	runAttempt,
	fs = nodeFs,
	retry = withTransientRetry,
}) {
	requireCaughtErrorDiagnosticRecorder(recorder);
	const artifacts = await retry(() =>
		github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
			owner,
			repo,
			run_id: runId,
			per_page: 100,
		}),
		{ recorder },
	);
	const wanted = `code-review-transcripts-${runAttempt}`;
	const artifact = artifacts.find(
		(item) => item.name === wanted && item.expired !== true,
	);
	if (!artifact) return null;
	const { data } = await retry(() =>
		github.rest.actions.downloadArtifact({
			owner,
			repo,
			artifact_id: artifact.id,
			archive_format: "zip",
		}),
		{ recorder },
	);
	const cleanupDir = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "codex-review-resume-"));
	const archivePath = nodePath.join(cleanupDir, "transcripts.zip");
	fs.writeFileSync(archivePath, Buffer.from(data), { flag: "wx", mode: 0o400 });
	const dir = nodePath.join(cleanupDir, "extracted");
	fs.mkdirSync(dir, { mode: 0o700 });
	nodeChildProcess.execFileSync("unzip", ["-q", archivePath, "-d", dir], {
		maxBuffer: 128 * 1024 * 1024,
	});
	return { dir, cleanupDir };
}

/**
 * Resolve the Codex session this round may resume, or the reason it may not.
 *
 * Fail-open by construction: any unexpected error becomes a refusal, and a
 * refusal means the caller runs the normal cold review.
 */
async function resolveResumableSession(input) {
	const recorder = requireCaughtErrorDiagnosticRecorder(input.recorder);
	try {
		return await resolve(input);
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.resume", stage: "resolve", disposition: "recover", context: {} });
		return refuse(REFUSAL.ERROR);
	}
}

async function resolve({
	recorder,
	github,
	owner,
	repo,
	prior,
	headSha,
	baseSha,
	currentHeadSha = "",
	expectedModel,
	git,
	downloadTranscripts = defaultDownloadTranscripts,
	fs = nodeFs,
}) {
	if (!prior || typeof prior !== "object") return refuse(REFUSAL.NO_PRIOR);

	// g1 — the prior state names the head it reviewed.
	const lastReviewedSha = prior.last_reviewed_head_sha;
	if (!isFullSha(lastReviewedSha)) return refuse(REFUSAL.PRIOR_HEAD);

	// g2 — and the run whose artifact holds that session. State written before
	// this change has no run id, so those pull requests review cold once more
	// and carry the id from their next round onward.
	const priorRunId = String(prior.last_review_run_id ?? "");
	const priorRunAttempt = Number(prior.last_review_run_attempt);
	if (
		!/^\d+$/.test(priorRunId) ||
		!Number.isSafeInteger(priorRunAttempt) ||
		priorRunAttempt <= 0
	) {
		return refuse(REFUSAL.RUN_ID);
	}

	// g10 — two runs on the same pull request overlap often. Only the run
	// reviewing the current head may continue the shared session; a superseded
	// run would fork it.
	if (!isFullSha(headSha)) return refuse(REFUSAL.HEAD_MOVED);
	if (currentHeadSha && currentHeadSha !== headSha) {
		return refuse(REFUSAL.HEAD_MOVED);
	}

	// g3 — a force-push or rebase makes `lastReviewedSha..head` meaningless.
	if (!git.isAncestor(lastReviewedSha, headSha)) return refuse(REFUSAL.REBASED);

	// g4 — a moved merge base changes what the full target even is.
	const priorMergeBase = prior.last_review_merge_base_sha;
	const currentMergeBase = git.mergeBase(baseSha, headSha);
	if (!isFullSha(priorMergeBase) || priorMergeBase !== currentMergeBase) {
		return refuse(REFUSAL.MERGE_BASE);
	}

	// g9 — with no repair delta there is nothing incremental to review.
	if (!git.diffNames(lastReviewedSha, headSha).trim()) {
		return refuse(REFUSAL.EMPTY_DELTA);
	}

	// g5 — transcripts expire after 3 days and their upload is best-effort.
	const transcripts = await downloadTranscripts({
		recorder,
		github,
		owner,
		repo,
		runId: Number(priorRunId),
		runAttempt: priorRunAttempt,
		fs,
	});
	if (!transcripts || !transcripts.dir) return refuse(REFUSAL.ARTIFACT);

	try {
		// g6 — the orchestrator is the rollout whose session id equals the
		// `thread.started` id of the run's own event stream. Subagent rollouts are
		// discarded: only the orchestrator conversation is restored.
		const stream = readStreamIdentity(recorder, fs, transcripts.dir);
		if (!stream) return refuse(REFUSAL.ORCHESTRATOR);
		const rollouts = findRolloutFiles(transcripts.dir, recorder)
			.map((file) => readRollout(recorder, fs, file))
			.filter(
				(rollout) =>
					rollout &&
					rollout.sessionId === stream.threadId &&
					rollout.originator === "codex_exec" &&
					!rollout.isSubagent,
			);
		if (rollouts.length !== 1) return refuse(REFUSAL.ORCHESTRATOR);
		const orchestrator = rollouts[0];
		const dateDir = sessionDateDir(orchestrator.file);
		if (!dateDir) return refuse(REFUSAL.ORCHESTRATOR);

		// g7 — a different model invalidates the recorded reasoning. A CLI
		// version change does not: it only costs prompt cache.
		const sessionModel = orchestrator.model || stream.model;
		if (!sessionModel || sessionModel !== expectedModel) {
			return refuse(
				`${REFUSAL.MODEL}: recorded ${sessionModel || "unknown"}, expected ${expectedModel}`,
			);
		}

		return {
			resumable: true,
			sessionId: orchestrator.sessionId,
			lastReviewedSha,
			priorRunId,
			reason: "resumable",
			rollout: {
				basename: nodePath.basename(orchestrator.file),
				dateDir,
				content: orchestrator.content,
			},
			// Telemetry only: auto-compaction is accepted, so these numbers are
			// logged and never decide anything.
			telemetry: {
				contextInputTokens: orchestrator.contextInputTokens,
				contextWindow: orchestrator.contextWindow,
				baselineUsage: orchestrator.baselineUsage,
			},
		};
	} finally {
		if (transcripts.cleanupDir) {
			fs.rmSync(transcripts.cleanupDir, { recursive: true, force: true });
		}
	}
}

/**
 * Place the restored orchestrator rollout where Codex looks for sessions.
 *
 * Only the rollout JSONL is needed: a resume reads the conversation from the
 * transcript, not from any index or database.
 */
function installResumedRollout({ codexHome, rollout, fs = nodeFs }) {
	if (!codexHome) {
		throw new Error("CODEX_HOME is required to restore a session");
	}
	const dir = nodePath.join(
		codexHome,
		"sessions",
		...rollout.dateDir.split("/"),
	);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = nodePath.join(dir, rollout.basename);
	fs.writeFileSync(target, rollout.content, { flag: "wx", mode: 0o600 });
	return target;
}

module.exports = {
	REFUSAL,
	readRollout,
	readStreamIdentity,
	defaultDownloadTranscripts,
	installResumedRollout,
	isTransientApiError,
	resolveResumableSession,
	sessionDateDir,
	withTransientRetry,
};
