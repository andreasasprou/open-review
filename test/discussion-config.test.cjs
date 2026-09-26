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
	assert.match(note, /base-branch version/);
	assert.ok(note.endsWith("\n\n"));
});
