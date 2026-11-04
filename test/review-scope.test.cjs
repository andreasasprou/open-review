"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
	classify, docsOnly, latestTrustedSettlement, parseDocsPaths, parseSettlements,
} = require("../engine/review-scope.cjs");

const MARKER = "example-local-review:settlement";
const DOCS = parseDocsPaths("docs/**, site/content/**");

function repository(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-scope-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const run = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
	run("init", "-q", "-b", "main");
	run("config", "user.name", "Test");
	run("config", "user.email", "test@example.test");
	const write = (files) => {
		for (const [file, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		}
	};
	const commit = (files, message = "change") => {
		write(files);
		run("add", "-A");
		run("commit", "-qm", message);
		return run("rev-parse", "HEAD");
	};
	const lines = (prefix) => Array.from({ length: 40 }, (_, index) => `${prefix} ${index}`).join("\n") + "\n";
	const base = commit({ "src/a.ts": lines("a"), "src/b.ts": lines("b"), "docs/guide.md": "guide\n" }, "base");
	run("checkout", "-qb", "feature");
	const git = (args) => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { encoding: "utf8" });
	return { root, run, commit, lines, base, git };
}

const settlement = (head, gate = "PASS", id = 10) => ({ id, head, gate, author: "maintainer", url: `https://example.test/pull/1#issuecomment-${id}` });

test("a push after a passed review is reviewed only for the files whose patch changed", (t) => {
	const { commit, lines, base, git } = repository(t);
	const passed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const head = commit({ "src/b.ts": lines("b").replace("b 7\n", "b 7 changed\n") });
	assert.deepEqual(classify({ git, baseSha: base, headSha: head, latest: settlement(passed) }), {
		mode: "incremental", reason: "since_passed_review", from: passed,
		settlement: "https://example.test/pull/1#issuecomment-10", files: ["src/b.ts"],
	});
});

test("a PR without a passed review, or whose latest review blocked, gets a full review", (t) => {
	const { commit, lines, base, git } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const head = commit({ "src/b.ts": lines("b").replace("b 7\n", "b 7 changed\n") });
	assert.deepEqual(classify({ git, baseSha: base, headSha: head, latest: null }), { mode: "full", reason: "no_settled_review", files: [] });
	assert.equal(classify({ git, baseSha: base, headSha: head, latest: settlement(reviewed, "BLOCK") }).reason, "last_review_not_passed");
	assert.equal(classify({ git, baseSha: base, headSha: head, latest: settlement(reviewed), fullReview: true }).reason, "full_review_requested");
	assert.equal(classify({ git, baseSha: base, headSha: head, latest: settlement("f".repeat(40)) }).reason, "passed_head_missing");
	assert.equal(classify({ git, baseSha: base, headSha: head, latest: null, settlementsVerified: false }).reason, "settlement_author_unverified");
});

test("a force-push that rewrote the passed head and changed the patch gets a full review", (t) => {
	const { run, commit, lines, base, git } = repository(t);
	const passed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("reset", "-q", "--hard", base);
	const rewritten = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 rewritten\n") });
	assert.deepEqual(classify({ git, baseSha: base, headSha: rewritten, latest: settlement(passed) }),
		{ mode: "full", reason: "passed_head_rewritten", files: [] });
});

test("a rebase or a merge from the base branch with the same patch carries the pass", (t) => {
	const { run, commit, lines, base, git } = repository(t);
	const passed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("checkout", "-q", "main");
	const main = commit({ "src/b.ts": lines("b").replace("b 30\n", "b 30 on main\n"), "src/a.ts": lines("a").replace("a 35\n", "a 35 on main\n") }, "main moves");
	run("checkout", "-q", "feature");
	run("merge", "-q", "--no-edit", "main");
	const merged = run("rev-parse", "HEAD");
	assert.deepEqual(classify({ git, baseSha: main, headSha: merged, latest: settlement(passed) }), {
		mode: "carry", reason: "same_patch", from: passed, settlement: "https://example.test/pull/1#issuecomment-10", files: [],
	});
	run("checkout", "-qb", "rebased", passed);
	run("rebase", "-q", "main");
	const rebased = run("rev-parse", "HEAD");
	assert.notEqual(rebased, passed);
	assert.equal(classify({ git, baseSha: main, headSha: rebased, latest: settlement(passed) }).reason, "same_patch");
	assert.equal(classify({ git, baseSha: base, headSha: passed, latest: settlement(passed) }).reason, "same_head");
	assert.equal(base, run("merge-base", base, passed));
});

test("after a merge from the base branch, only the PR's own changed patch is reviewed", (t) => {
	const { run, commit, lines, base, git } = repository(t);
	const passed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("checkout", "-q", "main");
	const main = commit({ "src/b.ts": lines("b").replace("b 30\n", "b 30 on main\n") }, "main moves");
	run("checkout", "-q", "feature");
	run("merge", "-q", "--no-edit", "main");
	const head = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n").replace("a 20\n", "a 20 fixed\n") });
	const scope = classify({ git, baseSha: main, headSha: head, latest: settlement(passed) });
	assert.equal(scope.mode, "incremental");
	assert.deepEqual(scope.files, ["src/a.ts"]);
	assert.equal(base, run("merge-base", base, main));
});

test("a merge that drops a base-branch change gets a full review", (t) => {
	const { run, commit, lines, git } = repository(t);
	const passed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("checkout", "-q", "main");
	const main = commit({ "src/b.ts": lines("b").replace("b 30\n", "b 30 on main\n") }, "main moves");
	run("checkout", "-q", "feature");
	run("merge", "-q", "-s", "ours", "--no-edit", "main");
	assert.equal(classify({ git, baseSha: main, headSha: run("rev-parse", "HEAD"), latest: settlement(passed) }).reason, "patch_changed_by_base");
});

test("docs-only PRs skip the model and docs-only pushes after a pass carry it", (t) => {
	const { run, commit, lines, base, git } = repository(t);
	const docs = commit({ "docs/guide.md": "guide, revised\n", "site/content/page.md": "page\n" });
	assert.deepEqual(classify({ git, baseSha: base, headSha: docs, docsPaths: DOCS }),
		{ mode: "skip", reason: "docs_only", files: ["docs/guide.md", "site/content/page.md"] });
	assert.equal(classify({ git, baseSha: base, headSha: docs }).reason, "no_settled_review", "no docs paths, no skip");
	const code = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	assert.equal(classify({ git, baseSha: base, headSha: code, docsPaths: DOCS }).mode, "full");
	const docsPush = commit({ "docs/guide.md": "guide, revised twice\n" });
	assert.deepEqual(classify({ git, baseSha: base, headSha: docsPush, docsPaths: DOCS, latest: settlement(code) }), {
		mode: "carry", reason: "docs_only_change", from: code, settlement: "https://example.test/pull/1#issuecomment-10", files: ["docs/guide.md"],
	});
	run("rm", "-q", "docs/guide.md");
	run("commit", "-qm", "remove guide");
	assert.equal(classify({ git, baseSha: base, headSha: run("rev-parse", "HEAD"), docsPaths: DOCS, latest: settlement(code) }).reason, "docs_only_change");
});

test("docs-only paths match whole segments and refuse traversal", () => {
	const paths = parseDocsPaths("docs/**  *.md,assets/*.png");
	assert.equal(docsOnly(["docs/a/b/c.md", "README.md", "assets/logo.png"], paths), true);
	assert.equal(docsOnly(["docs-site/index.ts"], paths), false);
	assert.equal(docsOnly(["src/README.md"], paths), false);
	assert.equal(docsOnly(["assets/icons/logo.png"], paths), false);
	assert.equal(docsOnly(["docs/../src/a.ts"], paths), false);
	assert.equal(docsOnly([], paths), false);
	assert.equal(docsOnly(["docs/a.md"], []), false);
});

test("only a writer's settlement for the marker scopes a review", () => {
	const head = "a".repeat(40);
	const body = (gate, header = "") => `<!-- ${MARKER} head=${head} -->\n\n${header}Merge gate: **${gate}** — 0 open findings.`;
	const comments = [
		{ id: 1, user: { login: "maintainer" }, html_url: "u1", body: body("PASS") },
		{ id: 2, user: { login: "maintainer" }, html_url: "u2", body: body("BLOCK") },
		{ id: 3, user: { login: "visitor" }, html_url: "u3", body: body("PASS") },
		{ id: 4, user: { login: "maintainer" }, html_url: "u4", body: `<!-- other-marker head=${head} -->\n\nMerge gate: **PASS**` },
		{ id: 5, user: { login: "maintainer" }, html_url: "u5", body: `quoted\n${body("PASS")}` },
	];
	const settlements = parseSettlements(comments, { marker: MARKER });
	assert.deepEqual(settlements.map((entry) => entry.id), [1, 2, 3]);
	const permission = (login) => (login === "maintainer" ? "write" : "read");
	assert.deepEqual(latestTrustedSettlement(settlements, permission), { id: 2, head, gate: "BLOCK", author: "maintainer", url: "u2" });
	assert.equal(latestTrustedSettlement(settlements, () => "read"), null);
	// An unreadable permission must not skip a newer writer's BLOCK for an older PASS.
	assert.throws(() => latestTrustedSettlement(settlements, (login) => (login === "maintainer" ? null : "read")), /unreadable/);
	const header = "> Posted by the operator.";
	assert.deepEqual(parseSettlements([{ id: 6, user: { login: "maintainer" }, body: body("PASS", `${header}\n\n`) }],
		{ marker: MARKER, attributionHeader: header }).map((entry) => entry.gate), ["PASS"]);
	assert.deepEqual(parseSettlements([{ id: 7, user: { login: "maintainer" }, body: body("PASS") }],
		{ marker: MARKER, attributionHeader: header }), []);
});

test("the classify command reads the PR's comments and the author's permission", (t) => {
	const { commit, lines, base, root } = repository(t);
	const passed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const head = commit({ "src/b.ts": lines("b").replace("b 7\n", "b 7 changed\n") });
	const bin = path.join(root, ".bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\ncase \"$*\" in *collaborators/maintainer/permission*) echo '{\"permission\":\"maintain\"}' ;; *) exit 1 ;; esac\n", { mode: 0o755 });
	const comments = path.join(root, ".comments.json");
	fs.writeFileSync(comments, JSON.stringify([[{ id: 9, user: { login: "maintainer" }, html_url: "u9",
		body: `<!-- ${MARKER} head=${passed} -->\n\nMerge gate: **PASS** — 0 open findings.` }]]));
	const classifyCommand = (docs, full) => JSON.parse(execFileSync("node", [path.join(__dirname, "../engine/review-scope.cjs"),
		"classify", root, "example/repo", base, head, comments, MARKER, docs, full],
	{ encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }));
	assert.deepEqual(classifyCommand("docs/**", "false"),
		{ mode: "incremental", reason: "since_passed_review", from: passed, settlement: "u9", files: ["src/b.ts"] });
	assert.equal(classifyCommand("", "true").reason, "full_review_requested");
	fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	assert.equal(classifyCommand("", "false").reason, "settlement_author_unverified");
});

test("the local runner settles a carried or skipped head without a model, under the exact-head marker", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-scope-settle-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const script = fs.readFileSync(path.join(__dirname, "../engine/run-local.sh"), "utf8");
	const block = script.slice(script.indexOf('SCOPE_MODE="$(jq'), script.indexOf('if [ "$SCOPE_MODE" = "incremental" ]; then'));
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "${"b".repeat(40)}"\n`, { mode: 0o755 });
	const head = "b".repeat(40);
	const passed = "c".repeat(40);
	const settle = (scope, extra = {}) => {
		const run = fs.mkdtempSync(path.join(root, "run-"));
		const stub = 'verify_trusted_runner_files_unchanged() { :; }\npublish_settlement() { cp "$SETTLEMENT_BODY" "$RUN_DIR/posted.md"; ' +
			'printf "%s|%s" "$STATUS_STATE" "$STATUS_DESCRIPTION" > "$RUN_DIR/status"; }\n';
		const result = execFileSync("bash", ["-euo", "pipefail", "-c", `${stub}${block}\necho not-settled`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: {
			...process.env, PATH: `${bin}:${process.env.PATH}`, RUN_DIR: run, SCOPE_JSON: JSON.stringify(scope),
			SETTLEMENT_JSON: path.join(run, "local-settlement.json"), SETTLEMENT_BODY: path.join(run, "settlement-comment.md"),
			ENGINE_DIR: path.join(__dirname, "../engine"), SETTLEMENT_MARKER: MARKER, HEAD_SHA: head, BASE_SHA: "a".repeat(40),
			REMOTE_HEAD_SHA: head, PR_NUMBER: "1", PREPARE_ONLY: "false", ...extra,
		} });
		assert.doesNotMatch(result, /not-settled/);
		return { result, run, read: (file) => fs.readFileSync(path.join(run, file), "utf8") };
	};
	const carried = settle({ mode: "carry", reason: "same_patch", from: passed, settlement: "https://example.test/c/9", files: [] });
	assert.equal(carried.read("posted.md"), `<!-- ${MARKER} head=${head} -->\n\n` +
		"Merge gate: **PASS** — 0 open findings, none requiring a fix or owner decision.\nModel verdict (display only): `carried`\n\n" +
		`Review scope: carried from ${passed} (passed settlement https://example.test/c/9). This head's patch is the same file for file.\n\n` +
		`Local Code Review settlement: head=${head}; runner=trusted-local; review_scope=carry; scope_base=${passed}; model=none.\n`);
	assert.equal(carried.read("status"), "success|Merge gate: PASS — carried from cccccccc");
	const ledger = JSON.parse(carried.read("local-settlement.json"));
	assert.deepEqual(ledger.ledger.open_findings, []);
	assert.equal(ledger.ledger.review_target.head_sha, head);
	assert.equal(parseSettlements([{ id: 1, user: { login: "maintainer" }, body: carried.read("posted.md") }], { marker: MARKER })[0].gate, "PASS");

	const skipped = settle({ mode: "skip", reason: "docs_only", files: ["docs/a.md", "docs/b.md"] });
	assert.match(skipped.read("posted.md"), /`skipped`\n\nReview scope: skipped, docs only\. All 2 changed files match the docs-only paths, so no model reviewed this PR\.\n/);
	assert.equal(skipped.read("status"), "success|Merge gate: PASS — skipped, docs only");

	const moved = (() => {
		try {
			settle({ mode: "carry", reason: "same_head", from: head, settlement: "u", files: [] }, { REMOTE_HEAD_SHA: "d".repeat(40) });
			return null;
		} catch (error) {
			return String(error.stderr);
		}
	})();
	assert.match(moved, /PR head changed during local review; refusing settlement/);
});

test("the runner scopes a review of the PR's current head and base, even when a wrapper names them", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-scope-gate-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const script = fs.readFileSync(path.join(__dirname, "../engine/run-local.sh"), "utf8");
	const block = script.slice(script.indexOf("SCOPE_JSON='{\"mode\":\"full\",\"reason\":\"unscoped_run\""), script.indexOf('SCOPE_MODE="$(jq'));
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\necho '{"mode":"incremental","reason":"since_passed_review","files":["a"]}'\n`, { mode: 0o755 });
	const head = "a".repeat(40);
	const base = "b".repeat(40);
	fs.writeFileSync(path.join(root, "pr.json"), JSON.stringify({ headRefOid: head, baseRefOid: base }));
	const scope = (extra) => execFileSync("bash", ["-euo", "pipefail", "-c", `${block}\nprintf '%s' "$SCOPE_JSON"`], {
		encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUN_DIR: root,
			SETUP_LOG: path.join(root, "setup.log"), PUBLISH_TRUSTED_ARTIFACTS: "true", REMOTE_HEAD_SHA: head, HEAD_SHA: head, BASE_SHA: base,
			CURRENT_REPOSITORY: "example/repo", PR_NUMBER: "1", ENGINE_DIR: root, ROOT: root, SETTLEMENT_MARKER: MARKER,
			DOCS_ONLY_PATHS: "", FULL_REVIEW: "false", ...extra },
	});
	assert.equal(JSON.parse(scope({})).mode, "incremental", "current head and base, named or not");
	assert.equal(JSON.parse(scope({ HEAD_SHA: "c".repeat(40) })).reason, "unscoped_run", "a historical head");
	assert.equal(JSON.parse(scope({ BASE_SHA: "c".repeat(40) })).reason, "unscoped_run", "another base");
	assert.equal(JSON.parse(scope({ PUBLISH_TRUSTED_ARTIFACTS: "false" })).reason, "unscoped_run", "a non-publishing run");
});
