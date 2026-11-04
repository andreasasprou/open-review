"use strict";

// Mechanical review scope: which part of a PR still needs a model. Reads git and
// the PR's own settlement comments; never runs a model.
//
// - skip: every path the PR changes matches the consumer's docs-only paths.
// - carry: the latest trusted settlement passed, and the PR's patch is the same
//   file for file (a rebase, a merge from the base branch or a rerun), or now
//   differs from the passed one only in docs-only files.
// - incremental: the latest trusted settlement passed on an ancestor of this
//   head; only the files whose patch changed since then need review.
// - full: anything else, including a passed head that was force-rewritten.

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { recordCaughtError, runReviewCli } = require("./diagnostics-runtime.cjs");

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);
// Fixed output: user diff configuration must not change a patch's identity.
const PATCH_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary",
	"--src-prefix=a/", "--dst-prefix=b/", "--unified=3"];

function gitRunner(root) {
	return (args) => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function globExpression(glob) {
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		if (char === "*" && glob[index + 1] === "*") {
			index += 1;
			if (glob[index + 1] === "/") {
				index += 1;
				source += "(?:.*/)?";
			} else {
				source += ".*";
			}
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
		}
	}
	return new RegExp(`^${source}$`, "u");
}

/** Glob patterns separated by whitespace or commas: `**` crosses directories, `*` and `?` do not. */
function parseDocsPaths(text) {
	return String(text || "").split(/[\s,]+/u).filter(Boolean).map(globExpression);
}

function docsOnly(paths, docsPaths) {
	return docsPaths.length > 0 && paths.length > 0 && paths.every((path) =>
		!path.split("/").some((part) => part === "" || part === "." || part === "..") &&
		docsPaths.some((pattern) => pattern.test(path)));
}

function changedPaths(git, from, to) {
	return git(["diff", "--name-only", "-z", "--no-renames", from, to]).split("\0").filter(Boolean);
}

// One digest per changed file, without blob ids or hunk line numbers, so a rebase
// that only moves a hunk keeps its identity (as `git patch-id` does). Null when
// the patch cannot be attributed to its files.
function filePatchDigests(git, from, to) {
	const paths = changedPaths(git, from, to);
	const byHeader = new Map(paths.map((path) => [`diff --git a/${path} b/${path}`, path]));
	const digests = new Map();
	let path = null;
	let hash = null;
	// Every line ends in a newline, so the last file's digest gains no empty line.
	for (const line of git(["diff", ...PATCH_FLAGS, from, to]).replace(/\n$/u, "").split("\n")) {
		if (line.startsWith("diff --git ")) {
			if (path !== null) digests.set(path, hash.digest("hex"));
			path = byHeader.get(line) ?? null;
			if (path === null || digests.has(path)) return null;
			hash = createHash("sha256");
		} else if (path === null) {
			if (line !== "") return null;
		} else if (!line.startsWith("index ")) {
			hash.update(line.startsWith("@@") ? "@@\n" : `${line}\n`);
		}
	}
	if (path !== null) digests.set(path, hash.digest("hex"));
	return digests.size === paths.length ? digests : null;
}

/** Files whose patch differs between two versions of a PR, or null when unreadable. */
function patchDelta(git, { before, after }) {
	const old = filePatchDigests(git, before.mergeBase, before.head);
	const current = filePatchDigests(git, after.mergeBase, after.head);
	if (old === null || current === null) return null;
	return [...new Set([...old.keys(), ...current.keys()])].filter((path) => old.get(path) !== current.get(path)).sort();
}

function escapeExpression(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Settlement comments the local runner publishes, in comment order, with their merge gate. */
function parseSettlements(comments, { marker, attributionHeader = "" }) {
	const header = attributionHeader ? `${escapeExpression(attributionHeader)}\\n\\n` : "";
	const pattern = new RegExp(`^<!-- ${escapeExpression(marker)} head=([0-9a-f]{40}) -->\\n\\n${header}Merge gate: \\*\\*(PASS|BLOCK|UNKNOWN)\\*\\*`, "u");
	return comments.flatMap((comment) => {
		const match = pattern.exec(String(comment?.body ?? ""));
		const author = comment?.user?.login;
		return match && Number.isSafeInteger(comment.id) && typeof author === "string" && author !== ""
			? [{ id: comment.id, head: match[1], gate: match[2], author, url: String(comment.html_url ?? "") }]
			: [];
	}).sort((left, right) => left.id - right.id);
}

/** The newest settlement whose author can write to the repository; anyone can comment. */
function latestTrustedSettlement(settlements, permissionOf) {
	const permissions = new Map();
	for (const settlement of [...settlements].reverse()) {
		if (!permissions.has(settlement.author)) permissions.set(settlement.author, permissionOf(settlement.author));
		if (WRITE_PERMISSIONS.has(permissions.get(settlement.author))) return settlement;
	}
	return null;
}

function commitExists(git, sha) {
	try {
		git(["cat-file", "-e", `${sha}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

function isAncestor(git, ancestor, head) {
	try {
		git(["merge-base", "--is-ancestor", ancestor, head]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Review scope for `headSha`. `latest` is the latest trusted settlement on the PR
 * or null; its head must already be fetched. A full review names its reason.
 */
function classify({ git, baseSha, headSha, docsPaths = [], latest = null, fullReview = false }) {
	const full = (reason) => ({ mode: "full", reason, files: [] });
	const mergeBase = git(["merge-base", baseSha, headSha]).trim();
	const files = changedPaths(git, mergeBase, headSha);
	if (docsOnly(files, docsPaths)) return { mode: "skip", reason: "docs_only", files };
	if (fullReview) return full("full_review_requested");
	if (latest === null) return full("no_settled_review");
	if (latest.gate !== "PASS") return full("last_review_not_passed");
	if (!commitExists(git, latest.head)) return full("passed_head_missing");
	let passedMergeBase;
	try {
		passedMergeBase = git(["merge-base", baseSha, latest.head]).trim();
	} catch {
		return full("passed_head_unrelated");
	}
	const delta = patchDelta(git, {
		before: { mergeBase: passedMergeBase, head: latest.head },
		after: { mergeBase, head: headSha },
	});
	if (delta === null) return full("patch_unreadable");
	const scope = { from: latest.head, settlement: latest.url, files: delta };
	if (delta.length === 0) return { mode: "carry", reason: latest.head === headSha ? "same_head" : "same_patch", ...scope };
	if (docsOnly(delta, docsPaths)) return { mode: "carry", reason: "docs_only_change", ...scope };
	if (!isAncestor(git, latest.head, headSha)) return full("passed_head_rewritten");
	// A merge that drops a base-branch change alters the patch but not the files
	// since the passed head; a diff from that head would not show it.
	const moved = new Set(changedPaths(git, latest.head, headSha));
	if (!delta.every((path) => moved.has(path))) return full("patch_changed_by_base");
	return { mode: "incremental", reason: "since_passed_review", ...scope };
}

function readComments(file) {
	const pages = JSON.parse(fs.readFileSync(file, "utf8"));
	return Array.isArray(pages) ? pages.flat() : [];
}

function githubPermission(recorder, repository, login) {
	try {
		return JSON.parse(execFileSync("gh", ["api", `repos/${repository}/collaborators/${login}/permission`],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).permission ?? null;
	} catch (error) {
		// An unreadable permission never trusts a settlement; the review runs in full.
		recordCaughtError({ recorder, error, operation: "review.scope", stage: "permission", disposition: "recover", context: {} });
		return null;
	}
}

function main(recorder, argv) {
	const [command, ...args] = argv;
	if (command === "delta") {
		// Hosted scope: the files whose PR patch changed between two reviewed heads.
		const [root, baseSha, sinceSha, headSha] = args;
		const git = gitRunner(root);
		const delta = patchDelta(git, {
			before: { mergeBase: git(["merge-base", baseSha, sinceSha]).trim(), head: sinceSha },
			after: { mergeBase: git(["merge-base", baseSha, headSha]).trim(), head: headSha },
		});
		if (delta === null) throw new Error("PR patch could not be attributed to its files");
		const moved = new Set(changedPaths(git, sinceSha, headSha));
		process.stdout.write(`${JSON.stringify({ files: delta, moved: delta.every((path) => moved.has(path)) })}\n`);
		return;
	}
	if (command !== "classify") throw new Error("usage: review-scope.cjs classify|delta ...");
	const [root, repository, baseSha, headSha, commentsFile, marker, docsPathsText, fullReview] = args;
	const git = gitRunner(root);
	const settlements = parseSettlements(readComments(commentsFile),
		{ marker, attributionHeader: process.env.OPEN_REVIEW_ATTRIBUTION_HEADER || "" });
	const latest = latestTrustedSettlement(settlements, (login) => githubPermission(recorder, repository, login));
	if (latest !== null && !commitExists(git, latest.head)) {
		try {
			git(["fetch", "--quiet", "--no-tags", "origin", latest.head]);
		} catch (error) {
			// A passed head that cannot be fetched cannot scope this review; classify reports it.
			recordCaughtError({ recorder, error, operation: "review.scope", stage: "fetch_passed_head", disposition: "recover", context: {} });
		}
	}
	process.stdout.write(`${JSON.stringify(classify({ git, baseSha, headSha, docsPaths: parseDocsPaths(docsPathsText),
		latest, fullReview: fullReview === "true" }))}\n`);
}

if (require.main === module) runReviewCli((recorder) => main(recorder, process.argv.slice(2)));

module.exports = { classify, docsOnly, filePatchDigests, latestTrustedSettlement, parseDocsPaths, parseSettlements, patchDelta };
