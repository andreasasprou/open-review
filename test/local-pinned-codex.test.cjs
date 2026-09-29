const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = fs.readFileSync(path.join(__dirname, '../engine/run-local.sh'), 'utf8');
const start = script.indexOf('ensure_pinned_codex() {');
const ensurePinnedCodex = script.slice(start, script.indexOf('\n}\n', start) + 3);

function fixture(t, globalVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-review-pinned-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  if (globalVersion) fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho "codex-cli ${globalVersion}"\n`, { mode: 0o755 });
  // Fake npm: records the call and installs a codex that reports the requested version.
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$*" >> "${path.join(root, 'npm-calls')}"
[ -n "$FAIL_NPM" ] && exit 1
prefix="$3"; for a; do spec="$a"; done
# A parallel run publishes its cache while this install is still running.
if [ -n "$PARALLEL_WINNER" ]; then
  mkdir -p "$PARALLEL_WINNER/node_modules/.bin" && touch "$PARALLEL_WINNER/winner"
  printf '#!/bin/sh\necho "codex-cli 0.157.1"\n' > "$PARALLEL_WINNER/node_modules/.bin/codex"
  chmod +x "$PARALLEL_WINNER/node_modules/.bin/codex"
fi
mkdir -p "$prefix/node_modules/.bin"
printf '#!/bin/sh\\necho "codex-cli %s"\\n' "\${spec#@openai/codex@}" > "$prefix/node_modules/.bin/codex"
chmod +x "$prefix/node_modules/.bin/codex"
`, { mode: 0o755 });
  const run = (env = {}) => spawnSync('bash', ['--norc', '--noprofile', '-euo', 'pipefail', '-c',
    `require_command() { command -v "$1" >/dev/null; }\n${ensurePinnedCodex}\nensure_pinned_codex\ncodex --version\ncommand -v codex`],
  { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, XDG_CACHE_HOME: path.join(root, 'cache'),
    REQUIRED_CODEX_CLI_VERSION: '0.157.1', PYTHON_BIN: 'python3', ...env } });
  const calls = () => (fs.existsSync(path.join(root, 'npm-calls')) ? fs.readFileSync(path.join(root, 'npm-calls'), 'utf8').trim().split('\n') : []);
  return { root, bin, run, calls };
}

test('a matching machine codex is used as is', (t) => {
  const f = fixture(t, '0.157.1');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^codex-cli 0\.157\.1\n.*\/bin\/codex\n$/);
  assert.deepEqual(f.calls(), []);
});

test('another or missing machine codex gets the pinned version from a per-user cache, once', (t) => {
  for (const globalVersion of ['0.156.1', null]) {
    const f = fixture(t, globalVersion);
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    const cached = path.join(f.root, 'cache/open-review/codex/0.157.1/node_modules/.bin/codex');
    assert.equal(first.stdout, `codex-cli 0.157.1\n${cached}\n`);
    assert.equal(f.calls().length, 1);
    assert.match(f.calls()[0], /^install --prefix \S+ --no-save --no-audit --no-fund --loglevel=error @openai\/codex@0\.157\.1$/);
    if (globalVersion) assert.equal(fs.readFileSync(path.join(f.bin, 'codex'), 'utf8'), '#!/bin/sh\necho "codex-cli 0.156.1"\n');
    const second = f.run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(f.calls().length, 1, 'the second run reuses the cache');
  }
});

test('a failed install stops the run and leaves no cache behind', (t) => {
  const f = fixture(t, '0.156.1');
  const result = f.run({ FAIL_NPM: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not install @openai\/codex@0\.157\.1/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'cache/open-review/codex')), []);
});

test('a cache published by a parallel run is kept, and a broken cache is never deleted', (t) => {
  const f = fixture(t, '0.156.1');
  const cache = path.join(f.root, 'cache/open-review/codex/0.157.1');
  const raced = f.run({ PARALLEL_WINNER: cache });
  assert.equal(raced.status, 0, raced.stderr);
  assert.ok(fs.existsSync(path.join(cache, 'winner')), 'the parallel winner stays in place');
  assert.deepEqual(fs.readdirSync(path.dirname(cache)), ['0.157.1'], 'the losing staging copy is removed');
  fs.writeFileSync(path.join(cache, 'node_modules/.bin/codex'), '#!/bin/sh\necho "codex-cli 0.1.0"\n', { mode: 0o755 });
  const broken = f.run();
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Remove .*0\.157\.1 and run again/);
  assert.ok(fs.existsSync(path.join(cache, 'winner')), 'a broken cache is reported, not deleted');
});
