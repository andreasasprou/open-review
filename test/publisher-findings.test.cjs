const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { postResults, MARKERS } = require("../engine/index.cjs");
const { readProjectionComment } = require("../engine/ledger/projection.cjs");
const { createRecordingCaughtErrorDiagnosticRecorder } = require("./helpers/recording-recorder.cjs");

test("publisher keeps eight findings in summary, inline review, gate, and state", async (t) => {
	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-eight-"));
	t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
	const headSha = "a".repeat(40);
	const issues = Array.from({ length: 8 }, (_, index) => ({
		id: `OR-${index + 1}`,
		severity: index === 7 ? "P1" : "P2",
		reachability: "normal_path",
		title: `Finding ${index + 1}`,
	}));
	const inlineComments = issues.map((issue, index) => ({
		issue_id: issue.id,
		file: "src/example.js",
		line: index + 1,
		start_line: null,
		title: issue.title,
		body: `Cause and consequence for ${issue.id}`,
		category: "correctness",
		suggestion: null,
	}));
	fs.writeFileSync(path.join(outputDir, "codex-review-output.json"), JSON.stringify({
		review_markdown: `## Verdict: BLOCK\n### Findings\n${issues.map((issue) => `- ${issue.title}`).join("\n")}`,
		inline_comments: inlineComments,
		state: { open_issues: issues, recently_resolved_issues: [], review_dispositions: [] },
	}));
	fs.writeFileSync(path.join(outputDir, "pr-diff.patch"),
		`diff --git a/src/example.js b/src/example.js\n+++ b/src/example.js\n@@ -0,0 +1,8 @@\n${Array.from({ length: 8 }, (_, index) => `+line ${index + 1}`).join("\n")}\n`);

	const postedComments = [];
	let postedReview;
	let check;
	const github = { rest: {
		issues: { createComment: async (input) => {
			postedComments.push(input.body);
			return { data: { id: postedComments.length } };
		} },
		pulls: {
			createReview: async (input) => {
				postedReview = input;
				return { data: { id: 42 } };
			},
			listCommentsForReview: async () => ({ data: postedReview.comments.map((comment, index) => ({
				pull_request_review_id: 42,
				path: comment.path,
				line: comment.line,
				id: 100 + index,
			})) }),
		},
		checks: { update: async (input) => { check = input; } },
	} };
	const recorder = createRecordingCaughtErrorDiagnosticRecorder();
	const result = await postResults({
		recorder, github, owner: "o", repo: "r", prNumber: 1, headSha,
		checkId: 7, previousState: null, outputDir, metadata: {},
	});

	assert.equal(result.mergeGate.openCount, 8);
	assert.equal(result.mergeGate.blockingCount, 1);
	assert.equal(check.conclusion, "failure");
	assert.match(check.output.summary, /1 of 8 open findings/);
	for (const issue of issues) assert.match(postedComments[0], new RegExp(issue.title));
	assert.equal(postedReview.comments.length, 8);
	assert.equal(postedReview.commit_id, headSha);
	const stateBody = postedComments.find((body) => body.includes(MARKERS.state));
	assert.ok(stateBody);
	const encoded = stateBody.split(`<!-- ${MARKERS.state}\n`)[1].split("\n-->")[0];
	const state = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	assert.equal(state.open_issues.length, 8);
	assert.equal(Object.keys(state.inlineCommentMap).length, 8);
	assert.deepEqual(recorder.records, []);
});

test("25 complete findings fit both posted GitHub comments without losing state", async (t) => {
	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-twenty-five-"));
	t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
	const headSha = "b".repeat(40);
	const lengthen = (sentence, length) => sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
	const issues = Array.from({ length: 25 }, (_, index) => ({
		stable_id: `OR-${index + 1}`,
		severity: "P1",
		reachability: "normal_path",
		likelihood: "medium",
		likely_consequence: "The next read fails.",
		worst_credible_consequence: lengthen("A request completes with incorrect durable data. ", 150),
		recoverability: "operational_intervention",
		proof_strength: "deterministic_static_proof",
		attribution: "introduced",
		risk_rationale: "A supported caller cannot read its record.",
		disposition: "FIX_IN_PR",
		autonomous_eligibility: "YES",
		title: `Finding ${index + 1}: reader rejects the newly written record`,
		failure_scenario: "A written record cannot be read back.",
		approved_invariant: "Round-trip every record.",
		where: `src/example.js:${index + 1}-${index + 1}`,
		evidence: lengthen("The changed writer omits a relationship required by the unchanged reader. ", 420),
		affected_lifecycle_planes: [],
	}));
	const required = require("../engine/output-schema.json").$defs.finding.required;
	for (const issue of issues) {
		for (const field of required) assert.ok(Object.hasOwn(issue, field), field);
		assert.equal(issue.evidence.length, 420);
		assert.equal(issue.worst_credible_consequence.length, 150);
	}
	const findingMarkdown = issues.map((issue) => lengthen(
		`- ${issue.title}: The write succeeds but the next read cannot find the record. `,
		1400,
	));
	for (const finding of findingMarkdown) assert.equal(finding.length, 1400);
	fs.writeFileSync(path.join(outputDir, "codex-review-output.json"), JSON.stringify({
		review_markdown: `## Verdict: BLOCK\n\n### Findings\n${findingMarkdown.join("\n")}\n\n### Risks Not Raised\n- (none)\n\n## Human Reviewer Callouts (Non-Blocking)\n- (none)`,
		inline_comments: [],
		state: {
			schema_version: 1,
			last_reviewed_head_sha: headSha,
			review_count: 1,
			updated_at: "2026-09-26T00:00:00Z",
			pr_summary: "Changed writer and unchanged readers",
		},
		new_findings: issues,
		prior_issue_evaluations: [],
	}));
	fs.writeFileSync(path.join(outputDir, "ledger-evidence.json"), JSON.stringify({ priorProjection: null,
		humanDecisions: [], evidenceChallenges: [] }));
	const posted = [];
	const github = { rest: { issues: { createComment: async ({ body }) => {
		posted.push(body);
		return { data: { id: posted.length } };
	} }, pulls: { get: async () => ({ data: { head: { sha: headSha, repo: { full_name: "o/r" } }, base: { sha: headSha, ref: "main" } } }) },
	checks: { update: async () => ({ data: {} }) } } };
	const ledgerTarget = { repository: "o/r", pr_number: 1, base_ref: "main", base_sha: headSha,
		merge_base_sha: headSha, head_sha: headSha, trusted_reviewer_ref: headSha,
		evidence_bundle_sha256: "c".repeat(64), evidence_schema_version: 2 };
	const checkIdentity = { workflow_path: ".github/workflows/review.yml",
		workflow_ref: "o/r/.github/workflows/review.yml@refs/heads/main", trusted_workflow_sha: headSha,
		workflow_run_id: "1", workflow_run_attempt: 1, workflow_job_id: 1, check_run_id: 2,
		check_suite_id: 3, app_slug: "github-actions", head_sha: headSha };
	const recorder = createRecordingCaughtErrorDiagnosticRecorder();
	const result = await postResults({
		recorder, github, owner: "o", repo: "r", prNumber: 1, headSha,
		checkId: 7, previousState: null, outputDir, ledgerTarget, checkIdentity,
		metadata: { model: "gpt-6-astra", duration: 180, inputTokens: 100000, outputTokens: 10000,
			rulesChanged: true, rulesPath: ".github/review-rules.md" },
	});

	assert.equal(result.mergeGate.openCount, 25);
	assert.equal(posted.length, 3);
	assert.ok(posted[0].startsWith("<!-- codex-review:review -->"));
	assert.ok(posted[0].includes("Review Metadata"));
	assert.ok(posted[0].includes("Merge gate: **BLOCK**"));
	for (const [kind, body] of [["summary", posted[0]], ["projection", posted[1]], ["encoded state", posted[2]]]) {
		assert.ok(body.length < 65536, `${kind}: ${body.length} characters`);
		assert.ok(Buffer.byteLength(body, "utf8") < 65536, `${kind}: ${Buffer.byteLength(body, "utf8")} bytes`);
	}
	const projection = readProjectionComment(posted[1]);
	assert.equal(projection.open_findings.length, 25);
	const encoded = posted[2].split(`<!-- ${MARKERS.state}\n`)[1].split("\n-->")[0];
	const persisted = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	assert.equal(persisted.open_issues.length, 25);
	assert.deepEqual(persisted.open_issues.map((issue) => issue.id), issues.map((issue) => issue.stable_id));
	assert.deepEqual(recorder.records, []);
});
