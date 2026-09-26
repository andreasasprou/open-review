const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const sourceEngine = resolve(__dirname, '../engine');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('pinned engine checks exact HEAD and file content, including development mode', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open-review-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(sourceEngine, join(root, 'engine'), { recursive: true });
  git(root, 'init', '--quiet');
  git(root, 'add', 'engine');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'engine');
  const sha = git(root, 'rev-parse', 'HEAD');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho reached-gh >&2\nexit 42\n', { mode: 0o755 });
  const run = (ref, extra = []) => spawnSync('bash', [join(root, 'engine/run-local.sh'), '--pr', '1', '--rules', 'rules.md', '--prepare-only', ...extra], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPEN_REVIEW_ENGINE_REF: ref },
    encoding: 'utf8',
  });

  const accepted = run(sha);
  assert.equal(accepted.status, 42);
  assert.match(accepted.stderr, /reached-gh/);
  assert.doesNotMatch(accepted.stdout, /Fetching origin\/main/);

  const wrongHead = run('0'.repeat(40));
  assert.equal(wrongHead.status, 1);
  assert.match(wrongHead.stderr, /HEAD must equal OPEN_REVIEW_ENGINE_REF/);

  writeFileSync(join(root, 'engine/prompt/core.md'), 'modified\n');
  const changed = run(sha, ['--allow-modified-runner']);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /engine files differ from pinned commit/);
  assert.doesNotMatch(changed.stderr, /reached-gh/);
});
