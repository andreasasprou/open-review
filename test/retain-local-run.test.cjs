const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const script = path.resolve(__dirname, "../engine/retain-local-run.sh");

test("retention archives parent and child rollouts without old sessions or auth", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-retain-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "--quiet", root]);
	const runDir = path.join(root, ".agent-data", "codex-review-local", "pr-1-test");
	const codexHome = path.join(root, "codex-home");
	const sessionDir = path.join(codexHome, "sessions", "2026", "09", "26");
	fs.mkdirSync(runDir, { recursive: true });
	fs.mkdirSync(sessionDir, { recursive: true });
	const marker = path.join(runDir, "session-start.marker");
	fs.writeFileSync(marker, "");
	const markerTime = Date.now() / 1000;
	fs.utimesSync(marker, markerTime, markerTime);
	const rollout = (name, content, seconds) => {
		const file = path.join(sessionDir, name);
		fs.writeFileSync(file, content);
		fs.utimesSync(file, markerTime + seconds, markerTime + seconds);
	};
	rollout("rollout-old.jsonl", "old\n", -10);
	rollout("rollout-parent.jsonl", "parent\n", 10);
	rollout("rollout-child.jsonl", "child\n", 11);
	fs.writeFileSync(path.join(codexHome, "auth.json"), "secret");
	fs.writeFileSync(path.join(runDir, "codex-output.jsonl"), "orchestrator\n");
	fs.writeFileSync(path.join(runDir, "summary.txt"), `Raw log: ${runDir}/codex-output.jsonl\n`);

	execFileSync("bash", [script, root, runDir, codexHome, marker, "clean"]);
	for (const [name, content] of [["parent", "parent\n"], ["child", "child\n"]]) {
		const archived = path.join(runDir, "sessions", "2026", "09", "26", `rollout-${name}.jsonl.gz`);
		assert.equal(zlib.gunzipSync(fs.readFileSync(archived)).toString(), content);
	}
	assert.equal(fs.existsSync(path.join(runDir, "sessions", "2026", "09", "26", "rollout-old.jsonl.gz")), false);
	assert.equal(fs.existsSync(path.join(runDir, "auth.json")), false);
	assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(runDir, "codex-output.jsonl.gz"))).toString(), "orchestrator\n");
	assert.match(fs.readFileSync(path.join(runDir, "summary.txt"), "utf8"), /codex-output\.jsonl\.gz/);
});

test("shared-home retention excludes a newer unrelated session by session cwd", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "open-review-shared-retain-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "--quiet", root]);
	const runDir = path.join(root, ".agent-data", "codex-review-local", "pr-1-test");
	const sessionDir = path.join(root, "codex-home", "sessions", "2026", "09", "26");
	fs.mkdirSync(runDir, { recursive: true });
	fs.mkdirSync(sessionDir, { recursive: true });
	const marker = path.join(runDir, "session-start.marker");
	fs.writeFileSync(marker, "");
	const markerTime = Date.now() / 1000;
	fs.utimesSync(marker, markerTime, markerTime);
	for (const [name, cwd] of [
		["parent", path.join(runDir, "worktree")],
		["child", path.join(runDir, "worktree")],
		["old", path.join(runDir, "worktree")],
		["unrelated", path.join(root, "another-worktree")],
	]) {
		const file = path.join(sessionDir, `rollout-${name}.jsonl`);
		fs.writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n${name}\n`);
		const sessionTime = markerTime + (name === "old" ? -10 : 10);
		fs.utimesSync(file, sessionTime, sessionTime);
	}
	fs.writeFileSync(path.join(runDir, "summary.txt"), "summary\n");
	execFileSync("bash", [script, root, runDir, path.join(root, "codex-home"), marker, "shared"]);
	const archive = (name) => path.join(runDir, "sessions", "2026", "09", "26", `rollout-${name}.jsonl.gz`);
	assert.equal(fs.existsSync(archive("parent")), true);
	assert.equal(fs.existsSync(archive("child")), true);
	assert.equal(fs.existsSync(archive("old")), false);
	assert.equal(fs.existsSync(archive("unrelated")), false);
});
