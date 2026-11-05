"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
	classify, docsOnly, latestTrustedSettlement, modelRounds, parseDocsPaths, parseSettlements,
} = require("../engine/review-scope.cjs");

const MARKER = "example-local-review:settlement";
const DOCS = parseDocsPaths("docs/**, site/content/**");
const URL = "https://example.test/pull/1#issuecomment-10";

function repository(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-scope-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const run = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
	run("init", "-q", "-b", "main");
	run("config", "user.name", "Test");
	run("config", "user.email", "test@example.test");
	const commit = (files, message = "change") => {
		for (const [file, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		}
		run("add", "-A");
		run("commit", "-qm", message);
		return run("rev-parse", "HEAD");
	};
	const lines = (prefix) => Array.from({ length: 40 }, (_, index) => `${prefix} ${index}`).join("\n") + "\n";
	const base = commit({ "src/a.ts": lines("a"), "src/b.ts": lines("b"), "docs/guide.md": "guide\n" }, "base");
	run("checkout", "-qb", "feature");
	const git = (args) => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { encoding: "utf8" });
	const scope = (input) => classify({ git, baseRef: "main", ...input });
	return { root, run, commit, lines, base, git, scope };
}

// A writer's settlement for `head`, recording the base branch and merge base it reviewed against.
const passed = (head, mergeBase, { gate = "PASS", baseRef = "main" } = {}) =>
	({ id: 10, head, gate, author: "maintainer", url: URL, base: { baseRef, mergeBase } });

test("a push after a passed review is reviewed only for the files that changed, from the passed head", (t) => {
	const { commit, lines, base, scope } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const head = commit({ "src/b.ts": lines("b").replace("b 7\n", "b 7 changed\n") });
	assert.deepEqual(scope({ baseSha: base, headSha: head, latest: passed(reviewed, base) }), {
		mode: "incremental", reason: "since_passed_review", diffBase: reviewed, from: reviewed, settlement: URL, files: ["src/b.ts"],
	});
});

test("a PR without a usable passed review gets a full review", (t) => {
	const { commit, lines, base, scope } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const head = commit({ "src/b.ts": lines("b").replace("b 7\n", "b 7 changed\n") });
	const reason = (input) => scope({ baseSha: base, headSha: head, ...input }).reason;
	assert.equal(reason({ latest: null }), "no_settled_review");
	assert.equal(reason({ latest: passed(reviewed, base, { gate: "BLOCK" }) }), "last_review_not_passed");
	assert.equal(reason({ latest: passed(reviewed, base), fullReview: true }), "full_review_requested");
	assert.equal(reason({ latest: passed("f".repeat(40), base) }), "passed_head_missing");
	assert.equal(reason({ latest: null, settlementsVerified: false }), "settlement_author_unverified");
	assert.equal(reason({ latest: { ...passed(reviewed, base), base: null } }), "passed_base_unrecorded");
});

test("a force-push that rewrote the passed head and changed the patch gets a full review", (t) => {
	const { run, commit, lines, base, scope } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("reset", "-q", "--hard", base);
	const rewritten = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 rewritten\n") });
	assert.deepEqual(scope({ baseSha: base, headSha: rewritten, latest: passed(reviewed, base) }),
		{ mode: "full", reason: "passed_head_rewritten", files: [] });
});

test("a rerun, or a rebase or merge that left the PR's files alone, carries the pass", (t) => {
	const { run, commit, lines, base, scope } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("checkout", "-q", "main");
	const main = commit({ "src/b.ts": lines("b").replace("b 30\n", "b 30 on main\n") }, "main moves");
	run("checkout", "-q", "feature");
	run("merge", "-q", "--no-edit", "main");
	const merged = run("rev-parse", "HEAD");
	assert.deepEqual(scope({ baseSha: main, headSha: merged, latest: passed(reviewed, base) }),
		{ mode: "carry", reason: "same_patch", from: reviewed, settlement: URL, files: [] });
	run("checkout", "-qb", "rebased", reviewed);
	run("rebase", "-q", "main");
	const rebased = run("rev-parse", "HEAD");
	assert.notEqual(rebased, reviewed);
	assert.equal(scope({ baseSha: main, headSha: rebased, latest: passed(reviewed, base) }).reason, "same_patch");
	assert.equal(scope({ baseSha: main, headSha: reviewed, latest: passed(reviewed, base) }).reason, "same_head");
});

test("when the base branch also changed a PR file, the pass is not carried", (t) => {
	const { run, commit, lines, base, scope } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("checkout", "-q", "main");
	const main = commit({ "src/a.ts": lines("a").replace("a 35\n", "a 35 on main\n") }, "main moves");
	run("checkout", "-qb", "rebased", reviewed);
	run("rebase", "-q", "main");
	assert.equal(scope({ baseSha: main, headSha: run("rev-parse", "HEAD"), latest: passed(reviewed, base) }).reason, "passed_head_rewritten");
	run("checkout", "-q", "feature");
	run("merge", "-q", "--no-edit", "main");
	assert.deepEqual(scope({ baseSha: main, headSha: run("rev-parse", "HEAD"), latest: passed(reviewed, base) }), {
		mode: "incremental", reason: "since_passed_review_base_moved", diffBase: main, from: reviewed, settlement: URL, files: ["src/a.ts"],
	});
});

// Review P1: incremental scope hid a base-branch fix that the PR dropped.
test("after the base moved, an incremental review reads the whole PR patch of the changed files", (t) => {
	const { run, git, commit, lines, base, scope } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("checkout", "-q", "main");
	const main = commit({ "src/a.ts": lines("a").replace("a 35\n", "a 35 security fix\n") }, "upstream fix");
	run("checkout", "-q", "feature");
	run("merge", "-q", "-s", "ours", "--no-edit", "main");
	const head = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n").replace("a 20\n", "a 20 unrelated\n") });
	const result = scope({ baseSha: main, headSha: head, latest: passed(reviewed, base) });
	assert.equal(result.mode, "incremental");
	assert.equal(result.diffBase, main);
	assert.deepEqual(result.files, ["src/a.ts"]);
	assert.match(git(["diff", result.diffBase, head, "--", ...result.files]), /^-a 35 security fix$/m);
	assert.doesNotMatch(git(["diff", reviewed, head, "--", "src/a.ts"]), /security fix/, "the passed-head diff alone hides it");
});

// Review P1: retargeting an unchanged passed head inherited the pass.
test("a PR retargeted to another base branch gets a full review", (t) => {
	const { run, commit, lines, base, scope } = repository(t);
	run("checkout", "-q", "main");
	const inherited = commit({ "src/b.ts": lines("b").replace("b 9\n", "b 9 on main only\n") }, "main only");
	run("checkout", "-q", "-b", "pr", inherited);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	run("branch", "release", base);
	assert.equal(scope({ baseSha: inherited, headSha: reviewed, latest: passed(reviewed, inherited) }).reason, "same_head");
	assert.deepEqual(scope({ baseRef: "release", baseSha: base, headSha: reviewed, latest: passed(reviewed, inherited) }),
		{ mode: "full", reason: "base_retargeted", files: [] });
	// The recorded merge base, not one recomputed from the current base, defines the passed patch.
	const result = scope({ baseSha: base, headSha: reviewed, latest: passed(reviewed, inherited) });
	assert.equal(result.mode, "incremental");
	assert.deepEqual(result.files, ["src/b.ts"]);
});

// Review P1: an edit moved between two identical regions looked like the same patch.
test("an edit moved between identical regions of a file is a different patch", (t) => {
	const { run, commit, scope } = repository(t);
	// Two regions with the same three lines of context on each side, far apart.
	const region = (edit) => `p\np\np\nblock\nsame line\n${edit}end\nq\nq\nq\n`;
	const file = (first, second) => `${region(first)}${Array.from({ length: 8 }, (_, index) => `separator ${index}\n`).join("")}${region(second)}`;
	run("checkout", "-q", "main");
	const start = commit({ "src/c.ts": file("", "") }, "two regions on the base branch");
	run("checkout", "-qb", "relocated", start);
	const reviewed = commit({ "src/c.ts": file("checked\n", "") });
	run("reset", "-q", "--hard", start);
	const moved = commit({ "src/c.ts": file("", "checked\n") });
	assert.deepEqual(scope({ baseSha: start, headSha: moved, latest: passed(reviewed, start) }),
		{ mode: "full", reason: "passed_head_rewritten", files: [] });
});

test("model rounds count writers' settlements by the model the runner recorded", () => {
	const head = "a".repeat(40);
	const trailer = (model) => `Local Code Review settlement: head=${head}; runner=trusted-local; review_level=floor-high; triage=none; model=${model}; codex_cli=0.157.1; sandbox_backend=bwrap.\n`;
	const body = (text) => `<!-- ${MARKER} head=${head} -->\n\nMerge gate: **PASS** — 0 open findings.\n${text}`;
	const comments = [
		{ id: 1, user: { login: "maintainer" }, body: body(trailer("gpt-6-astra")) },
		{ id: 2, user: { login: "maintainer" }, body: body(`### Review\n${trailer("gpt-6-luna")}\n${trailer("gpt-6-astra")}`) },
		{ id: 3, user: { login: "maintainer" }, body: body(`${trailer("gpt-6-astra")}### Review\n${trailer("gpt-6.1-sol")}`) },
		{ id: 4, user: { login: "maintainer" }, body: body(`Local Code Review settlement: head=${head}; runner=trusted-local; review_scope=carry; scope_base=${head}; model=none.\n`) },
		{ id: 5, user: { login: "visitor" }, body: body(trailer("gpt-6-astra")) },
		{ id: 6, user: { login: "unknown" }, body: body(trailer("gpt-6-astra")) },
	];
	const settlements = parseSettlements(comments, { marker: MARKER });
	assert.deepEqual(settlements.map((entry) => entry.model), ["gpt-6-astra", "gpt-6-astra", "gpt-6.1-sol", null, "gpt-6-astra", "gpt-6-astra"]);
	const permission = (login) => ({ maintainer: "admin", visitor: "read" })[login] ?? null;
	assert.deepEqual(modelRounds(settlements, permission), { "gpt-6-astra": 2, "gpt-6.1-sol": 1 });
});

// Review P1 (round 2): a path with a newline split into two pathspecs and left its change unreviewed.
test("a changed path the runner cannot pass line by line gets a full review", (t) => {
	const { commit, lines, base, scope } = repository(t);
	const reviewed = commit({ "src/pay\nload.js": "pay\n", "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const head = commit({ "src/pay\nload.js": "pay, changed\n", "src/b.ts": lines("b").replace("b 7\n", "b 7 changed\n") });
	assert.deepEqual(scope({ baseSha: base, headSha: head, latest: passed(reviewed, base) }),
		{ mode: "full", reason: "path_unrepresentable", files: [] });
});

// Review P2 (round 2): a historical-base review needs the PR's current base, which may be absent locally.
test("the runner fetches the PR's current base before computing its merge base", (t) => {
	const { root: origin, commit, base } = repository(t);
	const head = commit({ "src/new.ts": "new\n" });
	const clone = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-scope-clone-"));
	t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
	execFileSync("git", ["clone", "-q", origin, clone]);
	execFileSync("git", ["-C", origin, "checkout", "-q", "main"]);
	const moved = commit({ "src/later.ts": "later\n" }, "main moves after the clone");
	const script = fs.readFileSync(path.join(__dirname, "../engine/run-local.sh"), "utf8");
	const start = script.indexOf('PR_START_BASE_SHA="$(jq');
	const block = script.slice(start, script.indexOf("\n", script.indexOf("PR_START_MERGE_BASE_SHA=", start)) + 1);
	const run = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-scope-run-"));
	t.after(() => fs.rmSync(run, { recursive: true, force: true }));
	fs.writeFileSync(path.join(run, "pr.json"), JSON.stringify({ baseRefOid: moved }));
	const output = execFileSync("bash", ["-euo", "pipefail", "-c", `${block}printf '%s' "$PR_START_MERGE_BASE_SHA"`], {
		encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ROOT: clone, RUN_DIR: run, HEAD_SHA: head, SETUP_LOG: path.join(run, "setup.log") },
	});
	assert.equal(output, base);
});

test("docs-only PRs skip the model and docs-only pushes after a pass carry it", (t) => {
	const { run, commit, lines, base, scope } = repository(t);
	const docs = commit({ "docs/guide.md": "guide, revised\n", "site/content/page.md": "page\n" });
	assert.deepEqual(scope({ baseSha: base, headSha: docs, docsPaths: DOCS }),
		{ mode: "skip", reason: "docs_only", files: ["docs/guide.md", "site/content/page.md"] });
	assert.equal(scope({ baseSha: base, headSha: docs }).reason, "no_settled_review", "no docs paths, no skip");
	const code = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	assert.equal(scope({ baseSha: base, headSha: code, docsPaths: DOCS }).mode, "full");
	const docsPush = commit({ "docs/guide.md": "guide, revised twice\n" });
	assert.deepEqual(scope({ baseSha: base, headSha: docsPush, docsPaths: DOCS, latest: passed(code, base) }),
		{ mode: "carry", reason: "docs_only_change", from: code, settlement: URL, files: ["docs/guide.md"] });
	run("rm", "-q", "docs/guide.md");
	run("commit", "-qm", "remove guide");
	assert.equal(scope({ baseSha: base, headSha: run("rev-parse", "HEAD"), docsPaths: DOCS, latest: passed(code, base) }).reason, "docs_only_change");
});

test("the floor wins over docs-only paths: protected files never skip or carry without a model", (t) => {
	const { commit, lines, base, scope } = repository(t);
	const docsAll = parseDocsPaths("docs/**, config/**");
	const code = commit({ "docs/auth/handler.ts": "export const ok = true;\n" });
	assert.equal(scope({ baseSha: base, headSha: code, docsPaths: docsAll }).reason, "no_settled_review");
	assert.equal(scope({ baseSha: base, headSha: code, docsPaths: docsAll, fullReview: true }).reason, "full_review_requested");
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const mdx = commit({ "docs/security/page.mdx": "<Policy />\n" });
	assert.equal(scope({ baseSha: base, headSha: mdx, docsPaths: docsAll, latest: passed(reviewed, base) }).mode, "incremental");
	const pack = commit({ "config/team-guide.md": "rule\n" });
	assert.equal(scope({ baseSha: base, headSha: pack, docsPaths: docsAll, latest: passed(mdx, base), protectedFiles: ["config/team-guide.md"] }).mode,
		"incremental", "the configured rule pack");
	assert.equal(scope({ baseSha: base, headSha: pack, docsPaths: docsAll, latest: passed(mdx, base) }).reason, "docs_only_change");
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

test("only a writer's settlement for the marker scopes a review, with the base the runner recorded", () => {
	const head = "a".repeat(40);
	const mergeBase = "c".repeat(40);
	const scoped = `Model verdict (display only): \`pass\`\n\nReview scope: full (no_settled_review).\nReview base: \`main\` at ${mergeBase}.\n\n`;
	const body = (gate, header = "", rest = scoped) =>
		`<!-- ${MARKER} head=${head} -->\n\n${header}Merge gate: **${gate}** — 0 open findings.\n${rest}### Review`;
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
	assert.deepEqual(latestTrustedSettlement(settlements, permission),
		{ id: 2, head, gate: "BLOCK", author: "maintainer", url: "u2", base: { baseRef: "main", mergeBase }, model: null });
	assert.equal(latestTrustedSettlement(settlements, () => "read"), null);
	// An unreadable permission must not skip a newer writer's BLOCK for an older PASS.
	assert.throws(() => latestTrustedSettlement(settlements, (login) => (login === "maintainer" ? null : "read")), /unreadable/);
	// A base line inside review text, after an unscoped prefix, is not the runner's record.
	const forged = body("PASS", "", `Model verdict (display only): \`pass\`\n\n### Review\n\n${scoped}`);
	assert.equal(parseSettlements([{ id: 6, user: { login: "maintainer" }, body: forged }], { marker: MARKER })[0].base, null);
	const header = "> Posted by the operator.";
	assert.deepEqual(parseSettlements([{ id: 7, user: { login: "maintainer" }, body: body("PASS", `${header}\n\n`) }],
		{ marker: MARKER, attributionHeader: header }).map((entry) => entry.base?.mergeBase), [mergeBase]);
	assert.deepEqual(parseSettlements([{ id: 8, user: { login: "maintainer" }, body: body("PASS") }],
		{ marker: MARKER, attributionHeader: header }), []);
});

test("the classify command reads the PR's comments and the author's permission", (t) => {
	const { commit, lines, base, root } = repository(t);
	const reviewed = commit({ "src/a.ts": lines("a").replace("a 3\n", "a 3 changed\n") });
	const head = commit({ "src/b.ts": lines("b").replace("b 7\n", "b 7 changed\n") });
	const bin = path.join(root, ".bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\ncase \"$*\" in *collaborators/maintainer/permission*) echo '{\"permission\":\"maintain\"}' ;; *) exit 1 ;; esac\n", { mode: 0o755 });
	const comments = path.join(root, ".comments.json");
	fs.writeFileSync(comments, JSON.stringify([[{ id: 9, user: { login: "maintainer" }, html_url: "u9",
		body: `<!-- ${MARKER} head=${reviewed} -->\n\nMerge gate: **PASS** — 0 open findings.\nModel verdict (display only): \`pass\`\n\n` +
			`Review scope: full (no_settled_review).\nReview base: \`main\` at ${base}.\n\n### Review` }]]));
	const classifyCommand = (docs, full) => JSON.parse(execFileSync("node", [path.join(__dirname, "../engine/review-scope.cjs"),
		"classify", root, "example/repo", "main", base, head, comments, MARKER, docs, full],
	{ encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }));
	assert.deepEqual(classifyCommand("docs/**", "false"),
		{ mode: "incremental", reason: "since_passed_review", diffBase: reviewed, from: reviewed, settlement: "u9", files: ["src/b.ts"], modelRounds: {} });
	assert.equal(classifyCommand("", "true").reason, "full_review_requested");
	fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	assert.equal(classifyCommand("", "false").reason, "settlement_author_unverified");
});

// The runner's revalidation function and its carry/skip settlement block, with git real and GitHub stubbed.
function settleRunner(t) {
	const { root, commit, base } = repository(t);
	const head = commit({ "src/new.ts": "new\n" });
	const script = fs.readFileSync(path.join(__dirname, "../engine/run-local.sh"), "utf8");
	const verify = script.slice(script.indexOf("verify_review_target_unchanged() {"), script.indexOf("\n}\n", script.indexOf("verify_review_target_unchanged() {")) + 3);
	const block = script.slice(script.indexOf('SCOPE_MODE="$(jq'), script.indexOf('if [ "$SCOPE_MODE" = "incremental" ]; then'));
	const bin = path.join(root, ".bin");
	fs.mkdirSync(bin);
	const passedHead = "c".repeat(40);
	return (scope, current = {}) => {
		const run = fs.mkdtempSync(path.join(root, ".run-"));
		fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ headRefOid: head, baseRefName: "main", baseRefOid: base, ...current })}'\n`, { mode: 0o755 });
		const stub = 'verify_trusted_runner_files_unchanged() { :; }\npublish_settlement() { cp "$SETTLEMENT_BODY" "$RUN_DIR/posted.md"; ' +
			'printf "%s|%s" "$STATUS_STATE" "$STATUS_DESCRIPTION" > "$RUN_DIR/status"; }\n';
		let stderr = "";
		try {
			execFileSync("bash", ["-euo", "pipefail", "-c", `${stub}${verify}${block}\necho not-settled`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: {
				...process.env, PATH: `${bin}:${process.env.PATH}`, RUN_DIR: run, SCOPE_JSON: JSON.stringify({ from: passedHead, ...scope }),
				SETTLEMENT_JSON: path.join(run, "local-settlement.json"), SETTLEMENT_BODY: path.join(run, "settlement-comment.md"),
				ENGINE_DIR: path.join(__dirname, "../engine"), SETTLEMENT_MARKER: MARKER, HEAD_SHA: head, BASE_SHA: base, BASE_REF: "main",
				MERGE_BASE_SHA: base, PR_START_MERGE_BASE_SHA: base, REMOTE_HEAD_SHA: head, PR_NUMBER: "1", PREPARE_ONLY: "false",
				ROOT: root, SETUP_LOG: path.join(run, "setup.log"),
			} });
		} catch (error) {
			stderr = String(error.stderr);
		}
		const read = (file) => (fs.existsSync(path.join(run, file)) ? fs.readFileSync(path.join(run, file), "utf8") : null);
		return { head, base, passedHead, stderr, read };
	};
}

test("the local runner settles a carried or skipped head without a model, under the exact-head marker", (t) => {
	const settle = settleRunner(t);
	const carried = settle({ mode: "carry", reason: "same_patch", settlement: "https://example.test/c/9", files: [] });
	const { head, base, passedHead } = carried;
	assert.equal(carried.read("posted.md"), `<!-- ${MARKER} head=${head} -->\n\n` +
		"Merge gate: **PASS** — 0 open findings, none requiring a fix or owner decision.\nModel verdict (display only): `carried`\n\n" +
		`Review scope: carried from ${passedHead} (passed settlement https://example.test/c/9). This head's patch is the same file for file.\n` +
		`Review base: \`main\` at ${base}.\n\n` +
		`Local Code Review settlement: head=${head}; runner=trusted-local; review_scope=carry; scope_base=${passedHead}; model=none.\n`);
	assert.equal(carried.read("status"), "success|Merge gate: PASS — carried from cccccccc");
	const ledger = JSON.parse(carried.read("local-settlement.json"));
	assert.deepEqual(ledger.ledger.open_findings, []);
	assert.equal(ledger.ledger.review_target.head_sha, head);
	const [parsed] = parseSettlements([{ id: 1, user: { login: "maintainer" }, body: carried.read("posted.md") }], { marker: MARKER });
	assert.deepEqual([parsed.gate, parsed.base], ["PASS", { baseRef: "main", mergeBase: base }]);

	const skipped = settle({ mode: "skip", reason: "docs_only", files: ["docs/a.md", "docs/b.md"] });
	assert.match(skipped.read("posted.md"), /`skipped`\n\nReview scope: skipped, docs only\. All 2 changed files match the docs-only paths, so no model reviewed this PR\.\n/);
	assert.equal(skipped.read("status"), "success|Merge gate: PASS — skipped, docs only");
});

// Review P1: publication checked only the head, so a retargeted PR could settle.
test("the local runner refuses to settle when the PR's head, base branch or merge base changed", (t) => {
	const settle = settleRunner(t);
	const carry = { mode: "carry", reason: "same_head", settlement: "u", files: [] };
	assert.match(settle(carry, { headRefOid: "d".repeat(40) }).stderr, /PR head changed during local review; refusing settlement/);
	const retargeted = settle(carry, { baseRefName: "release" });
	assert.match(retargeted.stderr, /PR base branch changed during local review; refusing settlement/);
	assert.equal(retargeted.read("posted.md"), null);
	const { head } = settle(carry);
	assert.match(settle(carry, { baseRefOid: head }).stderr, /PR merge base changed during local review; refusing settlement/);
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
			BASE_REF: "main", CURRENT_REPOSITORY: "example/repo", PR_NUMBER: "1", ENGINE_DIR: root, ROOT: root, SETTLEMENT_MARKER: MARKER,
			DOCS_ONLY_PATHS: "", FULL_REVIEW: "false", RULES_PATH: ".open-review/rules.md", ...extra },
	});
	assert.equal(JSON.parse(scope({})).mode, "incremental", "current head and base, named or not");
	assert.equal(JSON.parse(scope({ HEAD_SHA: "c".repeat(40) })).reason, "unscoped_run", "a historical head");
	assert.equal(JSON.parse(scope({ BASE_SHA: "c".repeat(40) })).reason, "unscoped_run", "another base");
	assert.equal(JSON.parse(scope({ PUBLISH_TRUSTED_ARTIFACTS: "false" })).reason, "unscoped_run", "a non-publishing run");
	// Unreadable PR comments could hide a BLOCK: never "no previous settlement".
	fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	assert.deepEqual(JSON.parse(scope({})), { mode: "full", reason: "settlement_history_unreadable", files: [] });
});

test("after the level's round cap, the runner reviews with the cap's model and effort", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-round-cap-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const script = fs.readFileSync(path.join(__dirname, "../engine/run-local.sh"), "utf8");
	const start = script.indexOf("if [ \"$ROUND_CAP_JSON\" != \"null\" ]; then");
	const block = script.slice(start, script.indexOf('"$PYTHON_BIN" "$ENGINE_DIR/interpolate-code-review.py" assemble', start));
	const cap = JSON.stringify({ rounds: 2, parentModel: "gpt-6.1-sol", reasoning: "high" });
	const parent = (rounds, roundCap = cap, model = "gpt-6-astra") => execFileSync("bash", ["-euo", "pipefail", "-c",
		`${block}\nprintf '%s %s %s' "$CODEX_MODEL" "$CODEX_REASONING" "$INCREMENTAL_REASONING"`], {
		encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUN_DIR: root, ROUND_CAP_JSON: roundCap,
			CODEX_MODEL: model, CODEX_REASONING: "xhigh", INCREMENTAL_REASONING: "xhigh", SCOPE_JSON: JSON.stringify({ modelRounds: rounds }) },
	}).split("\n").at(-1);
	assert.equal(parent({ "gpt-6-astra": 1, "gpt-6.1-sol": 4 }), "gpt-6-astra xhigh xhigh");
	assert.equal(parent({ "gpt-6-astra": 2 }), "gpt-6.1-sol high high");
	assert.equal(parent(undefined), "gpt-6-astra xhigh xhigh", "a scope without rounds keeps the level's model");
	assert.equal(parent({ "gpt-6-astra": 5 }, "null"), "gpt-6-astra xhigh xhigh", "a configured model has no cap");
});
