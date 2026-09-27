const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { postResults, MARKERS } = require("../engine/index.cjs");
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
		id: `OR-${index + 1}`,
		severity: "P1",
		reachability: "normal_path",
		likelihood: "medium",
		worst_credible_consequence: lengthen("A request completes with incorrect durable data. ", 150),
		recoverability: "painful",
		area: "Code",
		category: "correctness",
		title: `Finding ${index + 1}: reader rejects the newly written record`,
		location: `src/example.js:${index + 1}-${index + 1}`,
		status: "open",
		notes: lengthen("The changed writer omits a relationship required by the unchanged reader. ", 420),
		first_seen_head_sha: headSha,
		last_seen_head_sha: headSha,
	}));
	const required = require("../engine/output-schema.json").properties.state.properties.open_issues.items.required;
	for (const issue of issues) {
		for (const field of required) assert.ok(Object.hasOwn(issue, field), field);
		assert.equal(issue.notes.length, 420);
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
			open_issues: issues,
			recently_resolved_issues: [],
			review_dispositions: [],
		},
	}));
	const posted = [];
	const github = { rest: { issues: { createComment: async ({ body }) => {
		posted.push(body);
		return { data: { id: posted.length } };
	} } } };
	const recorder = createRecordingCaughtErrorDiagnosticRecorder();
	const result = await postResults({
		recorder, github, owner: "o", repo: "r", prNumber: 1, headSha,
		checkId: null, previousState: null, outputDir,
		metadata: { model: "gpt-6-astra", duration: 180, inputTokens: 100000, outputTokens: 10000,
			rulesChanged: true, rulesPath: ".github/review-rules.md" },
	});

	assert.equal(result.mergeGate.openCount, 25);
	assert.equal(posted.length, 2);
	assert.ok(posted[0].includes("Review Metadata"));
	assert.ok(posted[0].includes("Merge gate: **BLOCK**"));
	for (const [kind, body] of [["summary", posted[0]], ["encoded state", posted[1]]]) {
		assert.ok(body.length < 65536, `${kind}: ${body.length} characters`);
		assert.ok(Buffer.byteLength(body, "utf8") < 65536, `${kind}: ${Buffer.byteLength(body, "utf8")} bytes`);
	}
	const encoded = posted[1].split(`<!-- ${MARKERS.state}\n`)[1].split("\n-->")[0];
	const persisted = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	assert.equal(persisted.open_issues.length, 25);
	assert.deepEqual(persisted.open_issues, issues);
	assert.deepEqual(recorder.records, []);
});
