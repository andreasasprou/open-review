"use strict";

// Mechanical review scope: which part of a PR still needs a model. Reads git and
// the PR's own settlement comments; never runs a model. A carried or incremental
// pass is used only when it is provably equivalent; anything else is full.
//
// - skip: every path the PR changes matches the consumer's docs-only paths and
//   none is on the review floor (focused-workers.cjs sensitivePaths).
// - carry: the latest trusted settlement passed on the same base branch, and
//   every file of the PR has the same base and result blobs as at the passed
//   head (a rerun, or a rebase or merge that left the PR's files alone), or
//   differs only in docs-only files.
// - incremental: the latest trusted settlement passed on the same base branch
//   at an ancestor of this head; only the files whose blobs changed are
//   reviewed, from the passed head, or from the current merge base when the
//   base moved in between (so a dropped base-branch change shows).
// - full: anything else, including a retargeted PR, a passed head that was
//   force-rewritten, or a settlement that does not record its base.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { sensitivePaths } = require("./focused-workers.cjs");
const { recordCaughtError, runReviewCli } = require("./diagnostics-runtime.cjs");

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

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

// Each changed file's exact identity in a PR: its modes and blob ids at the
// merge base and at the head. Hunk text alone is not an identity: an edit moved
// between two identical regions of a file would look the same.
function fileStates(git, from, to) {
	const fields = git(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to]).split("\0");
	const states = new Map();
	for (let index = 0; index + 1 < fields.length; index += 2) {
		if (!fields[index].startsWith(":")) throw new Error("unexpected raw diff output");
		states.set(fields[index + 1], fields[index]);
	}
	return states;
}

/** Files whose base or result differs between two versions of a PR. */
function patchDelta(git, { before, after }) {
	const old = fileStates(git, before.mergeBase, before.head);
	const current = fileStates(git, after.mergeBase, after.head);
	return [...new Set([...old.keys(), ...current.keys()])].filter((path) => old.get(path) !== current.get(path)).sort();
}

function escapeExpression(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// The base a settlement reviewed against, from the runner-written lines right
// after the merge-gate summary; review text further down cannot supply it.
function recordedBase(body) {
	const verdict = body.indexOf("\nModel verdict (display only): ");
	if (verdict < 0) return null;
	const match = /^\nReview scope: [^\n]*\nReview base: `([^`\n]+)` at ([0-9a-f]{40})\.\n/u.exec(body.slice(body.indexOf("\n", verdict + 1) + 1));
	return match ? { baseRef: match[1], mergeBase: match[2] } : null;
}

/** Settlement comments the local runner publishes, in comment order, with their merge gate and base. */
function parseSettlements(comments, { marker, attributionHeader = "" }) {
	const header = attributionHeader ? `${escapeExpression(attributionHeader)}\\n\\n` : "";
	const pattern = new RegExp(`^<!-- ${escapeExpression(marker)} head=([0-9a-f]{40}) -->\\n\\n${header}Merge gate: \\*\\*(PASS|BLOCK|UNKNOWN)\\*\\*`, "u");
	return comments.flatMap((comment) => {
		const body = String(comment?.body ?? "");
		const match = pattern.exec(body);
		const author = comment?.user?.login;
		return match && Number.isSafeInteger(comment.id) && typeof author === "string" && author !== ""
			? [{ id: comment.id, head: match[1], gate: match[2], author, url: String(comment.html_url ?? ""), base: recordedBase(body) }]
			: [];
	}).sort((left, right) => left.id - right.id);
}

/**
 * The newest settlement whose author can write to the repository; anyone can
 * comment. `permissionOf` returns null when it cannot tell, and then this throws:
 * skipping that author could pass over a newer BLOCK.
 */
function latestTrustedSettlement(settlements, permissionOf) {
	const permissions = new Map();
	for (const settlement of [...settlements].reverse()) {
		if (!permissions.has(settlement.author)) permissions.set(settlement.author, permissionOf(settlement.author));
		const permission = permissions.get(settlement.author);
		if (permission === null) throw new Error("settlement author's permission is unreadable");
		if (WRITE_PERMISSIONS.has(permission)) return settlement;
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
 * Review scope for `headSha` on `baseRef` at `baseSha`. `latest` is the latest
 * trusted settlement on the PR or null; its head and recorded merge base must
 * already be fetched. `settlementsVerified` is false when the settlements'
 * authors could not be checked. A full review names its reason.
 */
function classify({ git, baseRef, baseSha, headSha, docsPaths = [], latest = null, settlementsVerified = true, fullReview = false, protectedFiles = [] }) {
	const full = (reason) => ({ mode: "full", reason, files: [] });
	const mergeBase = git(["merge-base", baseSha, headSha]).trim();
	const files = changedPaths(git, mergeBase, headSha);
	// Docs-only paths never cover a floor file (code or MDX under docs/, policy files).
	const docsOnlyUnprotected = (paths) => docsOnly(paths, docsPaths) && sensitivePaths(paths, protectedFiles).length === 0;
	if (docsOnlyUnprotected(files)) return { mode: "skip", reason: "docs_only", files };
	if (fullReview) return full("full_review_requested");
	if (!settlementsVerified) return full("settlement_author_unverified");
	if (latest === null) return full("no_settled_review");
	if (latest.gate !== "PASS") return full("last_review_not_passed");
	if (latest.base === null) return full("passed_base_unrecorded");
	if (latest.base.baseRef !== baseRef) return full("base_retargeted");
	if (!commitExists(git, latest.head) || !commitExists(git, latest.base.mergeBase)) return full("passed_head_missing");
	const delta = patchDelta(git, {
		before: { mergeBase: latest.base.mergeBase, head: latest.head },
		after: { mergeBase, head: headSha },
	});
	const scope = { from: latest.head, settlement: latest.url, files: delta };
	if (delta.length === 0) return { mode: "carry", reason: latest.head === headSha ? "same_head" : "same_patch", ...scope };
	if (docsOnlyUnprotected(delta)) return { mode: "carry", reason: "docs_only_change", ...scope };
	if (!isAncestor(git, latest.head, headSha)) return full("passed_head_rewritten");
	// The runner passes the scoped paths line by line; a path with a newline
	// would split and leave a change unreviewed.
	if (delta.some((file) => file.includes("\n"))) return full("path_unrepresentable");
	// When the base moved in between, a diff from the passed head would hide a
	// base-branch change the PR dropped; review those files' whole PR patch.
	const baseMoved = latest.base.mergeBase !== mergeBase;
	return { mode: "incremental", reason: baseMoved ? "since_passed_review_base_moved" : "since_passed_review",
		diffBase: baseMoved ? mergeBase : latest.head, ...scope };
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
	if (command !== "classify") throw new Error("usage: review-scope.cjs classify <root> <repository> <base-ref> <base-sha> <head-sha> <comments.json> <marker> <docs-paths> <full-review> [<rules-path>]");
	const [root, repository, baseRef, baseSha, headSha, commentsFile, marker, docsPathsText, fullReview, rulesPath = ""] = args;
	const git = gitRunner(root);
	const settlements = parseSettlements(readComments(commentsFile),
		{ marker, attributionHeader: process.env.OPEN_REVIEW_ATTRIBUTION_HEADER || "" });
	let latest = null;
	let settlementsVerified = true;
	try {
		latest = latestTrustedSettlement(settlements, (login) => githubPermission(recorder, repository, login));
	} catch (error) {
		recordCaughtError({ recorder, error, operation: "review.scope", stage: "trusted_settlement", disposition: "recover", context: {} });
		settlementsVerified = false;
	}
	const missing = latest === null ? [] : [latest.head, latest.base?.mergeBase].filter((sha) => sha && !commitExists(git, sha));
	if (missing.length > 0) {
		try {
			git(["fetch", "--quiet", "--no-tags", "origin", ...missing]);
		} catch (error) {
			// A passed head or base that cannot be fetched cannot scope this review; classify reports it.
			recordCaughtError({ recorder, error, operation: "review.scope", stage: "fetch_passed_head", disposition: "recover", context: {} });
		}
	}
	process.stdout.write(`${JSON.stringify(classify({ git, baseRef, baseSha, headSha, docsPaths: parseDocsPaths(docsPathsText),
		latest, settlementsVerified, fullReview: fullReview === "true",
		protectedFiles: rulesPath ? [rulesPath] : [] }))}\n`);
}

if (require.main === module) runReviewCli((recorder) => main(recorder, process.argv.slice(2)));

module.exports = { classify, docsOnly, fileStates, latestTrustedSettlement, parseDocsPaths, parseSettlements, patchDelta, recordedBase };
