"use strict";

// Consumer-supplied discussion settings: decision owners, the disposition
// ledger marker, extra review-context keywords, and the rule-pack note.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createRecordingCaughtErrorDiagnosticRecorder } = require("./helpers/recording-recorder.cjs");
const {
	fetchReviewDiscussionContext,
	formatRulesChangedNote,
	mentionsReviewContext,
	MARKERS,
} = require("../engine/index.cjs");

function ledgerComment({ id, login, association, marker, dispositions }) {
	const payload = Buffer.from(JSON.stringify(dispositions)).toString("base64");
	return {
		id,
		user: { login },
		author_association: association,
		body: `Ledger\n<!-- ${marker}\n${payload}\n-->`,
		created_at: "2026-09-01T00:00:00Z",
	};
}

function fakeGithub(issueComments) {
	return {
		rest: { issues: { listComments: "issues" }, pulls: { listReviews: "reviews" } },
		paginate: async (endpoint) => (endpoint === "issues" ? issueComments : []),
		graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } }),
	};
}

function fetchContext(issueComments, options = {}) {
	return fetchReviewDiscussionContext({
		recorder: createRecordingCaughtErrorDiagnosticRecorder(),
		github: fakeGithub(issueComments),
		owner: "example-org",
		repo: "example-repo",
		prNumber: 7,
		headSha: "f".repeat(40),
		prAuthorLogin: "author",
		...options,
	});
}

test("extra keywords widen review-context detection and are matched literally", () => {
	assert.equal(mentionsReviewContext("Fixed in the widget runner"), false);
	assert.equal(mentionsReviewContext("Fixed in the widget runner", ["widget"]), true);
	assert.equal(mentionsReviewContext("see aab", ["a+b"]), false, "keywords are escaped, not regex");
	assert.equal(mentionsReviewContext("see a+b", ["a+b"]), true);
	assert.equal(mentionsReviewContext("Addressed the review thread"), true);
});

test("decision owners are trusted without an OWNER/MEMBER/COLLABORATOR association", async () => {
	const comment = ledgerComment({
		id: 1,
		login: "Decider",
		association: "NONE",
		marker: MARKERS.dispositions,
		dispositions: [{ disposition: "won't fix", rationale: "Accepted trade-off." }],
	});
	const untrusted = await fetchContext([comment]);
	assert.equal(untrusted.dispositions.length, 0);
	const trusted = await fetchContext([comment], { decisionOwners: ["decider"] });
	assert.deepEqual(
		trusted.dispositions.map((item) => [item.disposition, item.actor]),
		[["wont-fix", "Decider"]],
	);
});

test("a configured ledger marker replaces the default marker", async () => {
	const custom = "example-review-dispositions:v1:base64";
	const comments = [
		ledgerComment({ id: 1, login: "m", association: "MEMBER", marker: custom, dispositions: [{ disposition: "deferred", rationale: "custom" }] }),
		ledgerComment({ id: 2, login: "m", association: "MEMBER", marker: MARKERS.dispositions, dispositions: [{ disposition: "fixed", rationale: "default" }] }),
	];
	const withDefault = await fetchContext(comments);
	assert.deepEqual(withDefault.dispositions.map((item) => item.rationale), ["default"]);
	const withCustom = await fetchContext(comments, { dispositionMarker: custom });
	assert.deepEqual(withCustom.dispositions.map((item) => item.rationale), ["custom"]);
});

test("the rule-pack note appears only when the PR changes the rule pack", () => {
	assert.equal(formatRulesChangedNote({}), "");
	assert.equal(formatRulesChangedNote({ rulesChanged: false, rulesPath: "x.md" }), "");
	const note = formatRulesChangedNote({ rulesChanged: true, rulesPath: ".github/review-rules.md" });
	assert.match(note, /^> \*\*Rule pack changed:\*\*/);
	assert.match(note, /`\.github\/review-rules\.md`/);
	assert.match(note, /default-branch version/);
	assert.ok(note.endsWith("\n\n"));
});

test("discussion-context none keeps every human comment from the model, whatever its author or association", async () => {
	const ledger = ledgerComment({ id: 1, login: "author", association: "OWNER", marker: MARKERS.dispositions,
		dispositions: [{ disposition: "won't fix", rationale: "Accepted trade-off." }] });
	const reply = (id, login, association, body) => ({ databaseId: id, body, author: { login }, authorAssociation: association, createdAt: "2026-09-01T00:00:00Z", url: `u${id}` });
	const github = {
		rest: { issues: { listComments: "issues" }, pulls: { listReviews: "reviews" } },
		paginate: async (endpoint) => (endpoint === "issues" ? [ledger] : [
			{ id: 5, user: { login: "github-actions[bot]" }, state: "COMMENTED", body: "Bot review", submitted_at: "2026-09-01T00:00:00Z" },
			{ id: 6, user: { login: "author" }, author_association: "OWNER", state: "COMMENTED", body: "Fixed, please close.", submitted_at: "2026-09-01T00:01:00Z" }]),
		graphql: async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [
			{ id: "T1", isResolved: false, isOutdated: false, path: "a.js", line: 1, comments: { nodes: [
				reply(10, "github-actions[bot]", "NONE", "**[P1] Finding**"), reply(11, "author", "OWNER", "Disposition: fixed")] } },
			{ id: "T2", isResolved: false, isOutdated: false, path: "b.js", line: 2, comments: { nodes: [reply(20, "member", "MEMBER", "Human thread")] } },
		] } } } }),
	};
	const context = humanContext => fetchReviewDiscussionContext({ recorder: createRecordingCaughtErrorDiagnosticRecorder(), github,
		owner: "example-org", repo: "example-repo", prNumber: 7, headSha: "f".repeat(40), prAuthorLogin: "author", humanContext });
	const trusted = await context(true);
	assert.ok(trusted.dispositions.length >= 2);
	assert.deepEqual(trusted.threads.map(({ thread_id }) => thread_id), ["T1", "T2"]);
	const none = await context(false);
	assert.deepEqual(none.dispositions, []);
	assert.deepEqual(none.review_summaries.map(({ author }) => author), ["github-actions[bot]"]);
	assert.deepEqual(none.top_level_review_responses, []);
	assert.deepEqual(none.threads.map(({ thread_id, trusted_responses }) => [thread_id, trusted_responses]), [["T1", []]]);
	assert.doesNotMatch(JSON.stringify(none), /Fixed, please close|Disposition: fixed|Accepted trade-off|Human thread/);
});
