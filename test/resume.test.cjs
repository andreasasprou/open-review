"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRecordingCaughtErrorDiagnosticRecorder } = require("./helpers/recording-recorder.cjs");
const {
	REFUSAL,
	defaultDownloadTranscripts,
	installResumedRollout,
	resolveResumableSession,
	withTransientRetry,
} = require("../engine/resume.cjs");

const ARTIFACT_DIR = path.join(__dirname, "testdata", "resume-artifact");
const ORCHESTRATOR_SESSION_ID = "01911111-1111-7111-8111-111111111111";
const LAST_REVIEWED_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "f".repeat(40);

function priorState(overrides = {}) {
	return {
		last_reviewed_head_sha: LAST_REVIEWED_SHA,
		last_review_run_id: "123456",
		last_review_run_attempt: 1,
		last_review_merge_base_sha: MERGE_BASE_SHA,
		...overrides,
	};
}

function buildInput(overrides = {}) {
	return {
		recorder: createRecordingCaughtErrorDiagnosticRecorder(),
		github: {},
		owner: "example-org",
		repo: "example-repo",
		prior: priorState(),
		headSha: HEAD_SHA,
		baseSha: BASE_SHA,
		currentHeadSha: HEAD_SHA,
		expectedModel: "gpt-5.6-sol",
		git: {
			isAncestor: () => true,
			mergeBase: () => MERGE_BASE_SHA,
			diffNames: () => "src/changed.ts\n",
		},
		downloadTranscripts: async () => ({ dir: ARTIFACT_DIR }),
		...overrides,
	};
}

test("a clean follow-up round resumes the prior orchestrator session", async () => {
	const decision = await resolveResumableSession(buildInput());
	assert.equal(decision.resumable, true);
	assert.equal(decision.sessionId, ORCHESTRATOR_SESSION_ID);
	assert.equal(decision.lastReviewedSha, LAST_REVIEWED_SHA);
	assert.equal(decision.priorRunId, "123456");
	assert.ok(decision.telemetry.baselineUsage.inputTokens > 0);
});

test("state written before incremental review refuses on the missing run id", async () => {
	const prior = priorState();
	delete prior.last_review_run_id;
	delete prior.last_review_run_attempt;
	const decision = await resolveResumableSession(buildInput({ prior }));
	assert.equal(decision.resumable, false);
	assert.equal(decision.reason, REFUSAL.RUN_ID);
});

test("no prior state refuses", async () => {
	const decision = await resolveResumableSession(buildInput({ prior: null }));
	assert.equal(decision.reason, REFUSAL.NO_PRIOR);
});

test("a rebased branch refuses instead of resuming a meaningless delta", async () => {
	const decision = await resolveResumableSession(
		buildInput({
			git: {
				isAncestor: () => false,
				mergeBase: () => MERGE_BASE_SHA,
				diffNames: () => "src/changed.ts\n",
			},
		}),
	);
	assert.equal(decision.reason, REFUSAL.REBASED);
});

test("a moved merge base refuses", async () => {
	const decision = await resolveResumableSession(
		buildInput({
			git: {
				isAncestor: () => true,
				mergeBase: () => "d".repeat(40),
				diffNames: () => "src/changed.ts\n",
			},
		}),
	);
	assert.equal(decision.reason, REFUSAL.MERGE_BASE);
});

test("an empty repair delta refuses", async () => {
	const decision = await resolveResumableSession(
		buildInput({
			git: {
				isAncestor: () => true,
				mergeBase: () => MERGE_BASE_SHA,
				diffNames: () => "  \n",
			},
		}),
	);
	assert.equal(decision.reason, REFUSAL.EMPTY_DELTA);
});

test("a superseded run refuses so it cannot fork the shared session", async () => {
	const decision = await resolveResumableSession(
		buildInput({ currentHeadSha: "e".repeat(40) }),
	);
	assert.equal(decision.reason, REFUSAL.HEAD_MOVED);
});

test("a missing transcript artifact refuses", async () => {
	const decision = await resolveResumableSession(
		buildInput({ downloadTranscripts: async () => null }),
	);
	assert.equal(decision.reason, REFUSAL.ARTIFACT);
});

test("a model change since the prior round refuses", async () => {
	const decision = await resolveResumableSession(
		buildInput({ expectedModel: "gpt-5.6-terra" }),
	);
	assert.ok(decision.reason.startsWith(REFUSAL.MODEL));
});

test("an unexpected error refuses rather than throwing", async () => {
	const decision = await resolveResumableSession(
		buildInput({
			git: {
				isAncestor: () => {
					throw new Error("git exploded");
				},
				mergeBase: () => MERGE_BASE_SHA,
				diffNames: () => "src/changed.ts\n",
			},
		}),
	);
	assert.ok(decision.reason.startsWith(REFUSAL.ERROR));
	assert.equal(decision.resumable, false);
});

test("the restored rollout lands where Codex looks for sessions", async () => {
	const decision = await resolveResumableSession(buildInput());
	const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
	try {
		const target = installResumedRollout({
			codexHome,
			rollout: decision.rollout,
		});
		assert.equal(
			target,
			path.join(
				codexHome,
				"sessions",
				"2026",
				"08",
				"16",
				decision.rollout.basename,
			),
		);
		assert.equal(fs.readFileSync(target, "utf8"), decision.rollout.content);
	} finally {
		fs.rmSync(codexHome, { recursive: true, force: true });
	}
});

function transientServerError() {
	const error = new Error("Server Error");
	error.status = 500;
	return error;
}

test("a transient artifact API failure is retried instead of losing the resume", async () => {
	const recorder = createRecordingCaughtErrorDiagnosticRecorder();
	const attempts = [];
	const call = async () => {
		attempts.push(attempts.length + 1);
		if (attempts.length < 3) {
			const error = new Error(
				"No server is currently available to service your request.",
			);
			error.status = 503;
			throw error;
		}
		return "artifacts";
	};
	const result = await withTransientRetry(call, { recorder,
		attempts: 3,
		sleep: async () => {},
	});
	assert.equal(result, "artifacts");
	assert.equal(attempts.length, 3);
	assert.deepEqual(recorder.records.map(record => record.disposition), ["recover", "recover"]);
});

test("a non-transient artifact API failure refuses immediately", async () => {
	const recorder = createRecordingCaughtErrorDiagnosticRecorder();
	let calls = 0;
	const call = async () => {
		calls += 1;
		const error = new Error("Not Found");
		error.status = 404;
		throw error;
	};
	await assert.rejects(
		() => withTransientRetry(call, { recorder, attempts: 3, sleep: async () => {} }),
		{ message: "Not Found" },
	);
	assert.equal(calls, 1);
	assert.deepEqual(recorder.records.map(record => record.disposition), ["propagate"]);
});

test("exhausted artifact retries record the final propagation", async () => {
	const recorder = createRecordingCaughtErrorDiagnosticRecorder();
	const original = Object.assign(new Error("Unavailable"), { status: 503 });
	await assert.rejects(() => withTransientRetry(() => Promise.reject(original), {
		recorder, attempts: 3, sleep: async () => {},
	}), error => error === original);
	assert.deepEqual(recorder.records.map(record => record.disposition), ["recover", "recover", "propagate"]);
});

test("the artifact download retries the list and the download separately", async () => {
	const seen = [];
	let listCalls = 0;
	let downloadCalls = 0;
	const github = {
		paginate: async () => {
			listCalls += 1;
			if (listCalls === 1) throw transientServerError();
			return [{ id: 7, name: "code-review-transcripts-2", expired: false }];
		},
		rest: {
			actions: {
				listWorkflowRunArtifacts: "list",
				downloadArtifact: async () => {
					downloadCalls += 1;
					if (downloadCalls === 1) throw transientServerError();
					return { data: Buffer.from("") };
				},
			},
		},
	};
	await assert.rejects(() =>
		defaultDownloadTranscripts({
			recorder: createRecordingCaughtErrorDiagnosticRecorder(),
			github,
			owner: "o",
			repo: "r",
			runId: 1,
			runAttempt: 2,
			retry: (call) => withTransientRetry(call, { recorder: createRecordingCaughtErrorDiagnosticRecorder(), sleep: async () => {} }),
			fs: {
				mkdtempSync: () => {
					seen.push("mkdtemp");
					throw new Error("stop after the retried calls");
				},
			},
		}),
	);
	assert.equal(listCalls, 2);
	assert.equal(downloadCalls, 2);
	assert.deepEqual(seen, ["mkdtemp"]);
});
