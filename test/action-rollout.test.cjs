const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { cpSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { test } = require('node:test');

const action = readFileSync(resolve(__dirname, '../action.yml'), 'utf8');

test('first v4 prompt hides old state issues while a v4 continuation retains them', () => {
  const { preparePromptState } = require('../engine/index.cjs');
  const state = { schema_version: 1, review_count: 3,
    open_issues: [{ id: 'RETRY-CONTROL-001' }], pr_summary: 'Old review' };
  assert.deepEqual(preparePromptState(state, null), { ...state, open_issues: [] });
  assert.deepEqual(preparePromptState(state, { schema_version: 4 }), state);
  assert.match(action, /preparePromptState\(.*priorProjection/);
  assert.match(readFileSync(resolve(__dirname, '../engine/run-local.sh'), 'utf8'), /preparePromptState/);
});

test('hosted post-processing failure logs the ledger code and message', () => {
  const script = block('Post results', 'script');
  assert.match(script, /catch \(error\) \{[\s\S]*?recordCaughtError\(\{ recorder, error, operation: "review\.workflow", stage: "post_results"[\s\S]*?console\.error\([^\n]*error\?\.code[^\n]*error\?\.message/);
});

async function postResultsWithPr(getPr) {
  const updates = [];
  const root = mkdtempSync(join(tmpdir(), 'open-review-post-'));
  mkdirSync(join(root, 'open-review'));
  symlinkSync(resolve(__dirname, '../engine'), join(root, 'open-review/engine'));
  const github = { rest: {
    pulls: { get: getPr },
    checks: { update: async ({ check_run_id, conclusion }) => { updates.push([check_run_id, conclusion]); } },
  } };
  const core = { setFailed: (reason) => { updates.push(['failed', reason]); } };
  const vars = { RUNNER_TEMP: root, PR_NUMBER: '7', CHECK_ID: '11', HEAD_SHA: 'a'.repeat(40), SHOULD_SKIP: 'false', REVIEW_MODE: 'full',
    REVIEW_GENERATED: 'true', JOB_STATUS: 'success' };
  const old = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    await new AsyncFunction('github', 'context', 'core', 'require', 'console', block('Post results', 'script'))(
      github, { repo: { owner: 'owner', repo: 'repo' } }, core, require, { log() {}, error() {} });
  } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
  return updates;
}

test('a PR merged during the review cancels the check and publishes nothing', async () => {
  assert.deepEqual(await postResultsWithPr(async () => ({ data: { state: 'closed', merged: true } })), [[11, 'cancelled']]);
});

test('a new head pushed during the review cancels the check and publishes nothing', async () => {
  assert.deepEqual(await postResultsWithPr(async () => ({ data: { state: 'open', merged: false, head: { sha: 'f'.repeat(40) } } })),
    [[11, 'cancelled']]);
});

test('a failed PR lookup completes the check as failed', async () => {
  assert.deepEqual(await postResultsWithPr(async () => { throw new Error('lookup failed'); }),
    [['failed', 'Review post-processing failed; no trusted projection was completed.'], [11, 'failure']]);
});

function block(name, key) {
  const lines = action.split('\n');
  const start = lines.findIndex((line) => line === `    - name: ${name}`);
  assert.notEqual(start, -1);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('    - name: '));
  const step = lines.slice(start, end < 0 ? undefined : end);
  const marker = step.findIndex((line) => new RegExp(`^ +${key}: \\|$`).test(line));
  assert.notEqual(marker, -1);
  const indent = step[marker].search(/\S/) + 2;
  const body = [];
  for (const line of step.slice(marker + 1)) {
    if (line && !line.startsWith(' '.repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(t, baseHasRules, trustedHasRules) {
  const root = mkdtempSync(join(tmpdir(), 'open-review-rollout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.test');
  mkdirSync(join(root, '.open-review'));
  writeFileSync(join(root, 'source.txt'), 'base\n');
  if (baseHasRules) writeFileSync(join(root, '.open-review/rules.md'), 'base rules\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  if (trustedHasRules) {
    writeFileSync(join(root, '.open-review/rules.md'), 'trusted rules\n');
  } else {
    writeFileSync(join(root, 'source.txt'), 'trusted\n');
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'trusted');
  const trusted = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', root);
  const runner = root;
  mkdirSync(join(runner, 'open-review'));
  const output = join(root, 'output');
  writeFileSync(output, '');
  return { root, base, trusted, runner, output };
}

function runShell(source, cwd, env) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', source], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
  });
}

for (const [name, baseRules, trustedRules, baseRef, expected, source] of [
  ['default-branch base preferred', true, true, 'main', 'base rules\n', 'base'],
  ['non-default base ignored', true, true, 'release', 'trusted rules\n', 'default_branch'],
  ['default-branch fallback', false, true, 'main', 'trusted rules\n', 'default_branch'],
  ['missing on default branch fails closed', false, false, 'main', null, null],
]) {
  test(`hosted rule pack: ${name}`, (t) => {
    const f = fixture(t, baseRules, trustedRules);
    const result = runShell(block('Load trusted rule pack', 'run'), f.root, {
      BASE_SHA: f.base, HEAD_SHA: f.base, MERGE_BASE_SHA: f.base,
      BASE_REF: baseRef, DEFAULT_BRANCH: 'main', DEFAULT_BRANCH_SHA: f.trusted,
      TRUSTED_WORKFLOW_SHA: f.base, GITHUB_TOKEN: 'test-token',
      RULES_PATH: '.open-review/rules.md', RUNNER_TEMP: f.runner,
      GITHUB_OUTPUT: f.output,
    });
    assert.equal(result.status, expected === null ? 1 : 0, result.stderr);
    if (expected === null) {
      assert.match(result.stdout, /Rule pack.*does not exist/);
    } else {
      assert.equal(readFileSync(join(f.runner, 'open-review/rules.md'), 'utf8'), expected);
      assert.match(result.stdout, new RegExp(`Rule pack: .* @ ${expected.startsWith('base') ? f.base.slice(0, 8) : f.trusted.slice(0, 8)}`));
      assert.match(result.stdout, new RegExp(`source=${source}`));
    }
  });
}

async function commandOutputs(eventName, body) {
  const root = mkdtempSync(join(tmpdir(), 'open-review-command-'));
  try {
    mkdirSync(join(root, 'open-review'));
    const outputs = {};
    const core = { setOutput: (key, value) => { outputs[key] = value; }, setFailed: (reason) => { throw Error(reason); } };
    const context = {
      eventName, ref: 'refs/heads/main', repo: { owner: 'owner', repo: 'repo' },
      issue: eventName === 'issue_comment' ? { number: 7 } : {}, payload: {
        issue: { pull_request: {} }, comment: { body, author_association: 'MEMBER' },
        repository: { default_branch: 'main' },
      },
    };
    const github = { rest: { repos: { getBranch: async () => ({ data: {
      commit: { sha: 'c'.repeat(40) },
    } }) }, pulls: { get: async () => ({ data: {
      number: 7, head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'owner/repo' } },
      base: { sha: 'b'.repeat(40), ref: 'main' }, title: 'Test', user: { login: 'person', type: 'User' },
    } }) } } };
    const oldTemp = process.env.RUNNER_TEMP;
    const oldCommands = process.env.REVIEW_COMMANDS;
    const oldNumber = process.env.PR_NUMBER_INPUT;
    process.env.RUNNER_TEMP = root;
    process.env.REVIEW_COMMANDS = 'code-review,alias-review';
    process.env.PR_NUMBER_INPUT = '7';
    try { await new AsyncFunction('github', 'context', 'core', 'require', 'console', block('Get PR details', 'script'))(github, context, core, require, { log() {} }); }
    finally {
      if (oldTemp === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = oldTemp;
      if (oldCommands === undefined) delete process.env.REVIEW_COMMANDS; else process.env.REVIEW_COMMANDS = oldCommands;
      if (oldNumber === undefined) delete process.env.PR_NUMBER_INPUT; else process.env.PR_NUMBER_INPUT = oldNumber;
    }
    return outputs;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const [event, body] of [
  ['issue_comment', '/code-review'],
  ['issue_comment', '/code-review please review this'],
  ['issue_comment', '/code-review full'],
  ['issue_comment', '/alias-review'],
  ['issue_comment', '/alias-review full'],
  ['workflow_dispatch', ''],
]) {
  test(`explicit ${event} ${body || '(manual)'} reviews an unchanged head`, async (t) => {
    const outputs = await commandOutputs(event, body);
    assert.equal(outputs.trigger_rejected, undefined);
    assert.equal(outputs.default_branch, 'main');
    assert.equal(outputs.default_branch_sha, 'c'.repeat(40));
    const f = fixture(t, false, false);
    mkdirSync(join(f.root, '.codex-ci'));
    writeFileSync(join(f.root, '.codex-ci/ledger-evidence.json'), JSON.stringify({
      priorProjection: {}, modelReviewRequired: false,
      humanDecisions: [], evidenceChallenges: [],
    }));
    const result = runShell(block('Determine review scope', 'run'), f.root, {
      BASE_SHA: f.base, HEAD_SHA: f.base, LAST_REVIEWED_SHA: f.base,
      FORCE_FULL_REVIEW: outputs.force_full_review, RESET_STATE: outputs.reset_state,
      SINCE_SHA: outputs.since_sha, EVENT_NAME: event, GITHUB_OUTPUT: f.output,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(f.output, 'utf8'), /review_mode=full/);
  });
}

test('automatic unchanged head may skip', (t) => {
  const f = fixture(t, false, false);
  mkdirSync(join(f.root, '.codex-ci'));
  writeFileSync(join(f.root, '.codex-ci/ledger-evidence.json'), JSON.stringify({
    priorProjection: {}, modelReviewRequired: false, humanDecisions: [], evidenceChallenges: [],
  }));
  const result = runShell(block('Determine review scope', 'run'), f.root, {
    BASE_SHA: f.base, HEAD_SHA: f.base, LAST_REVIEWED_SHA: f.base,
    FORCE_FULL_REVIEW: 'false', RESET_STATE: 'false', SINCE_SHA: '',
    EVENT_NAME: 'pull_request_target', GITHUB_OUTPUT: f.output,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.output, 'utf8'), /review_mode=skip/);
});

test('explicit --since retains incremental scope', async (t) => {
  const f = fixture(t, false, false);
  const outputs = await commandOutputs('issue_comment', `/code-review --since ${f.base}`);
  assert.equal(outputs.since_sha, f.base);
  mkdirSync(join(f.root, '.codex-ci'));
  writeFileSync(join(f.root, '.codex-ci/ledger-evidence.json'), JSON.stringify({
    priorProjection: {}, modelReviewRequired: false, humanDecisions: [], evidenceChallenges: [],
  }));
  const result = runShell(block('Determine review scope', 'run'), f.root, {
    BASE_SHA: f.base, HEAD_SHA: f.trusted, LAST_REVIEWED_SHA: '',
    FORCE_FULL_REVIEW: outputs.force_full_review, RESET_STATE: outputs.reset_state,
    SINCE_SHA: outputs.since_sha, EVENT_NAME: 'issue_comment', GITHUB_OUTPUT: f.output,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.output, 'utf8'), /review_mode=incremental/);
  assert.match(readFileSync(f.output, 'utf8'), /review_scope_reason=since_requested_sha/);
});

test('a merge from the base branch after the last pass makes a full review', (t) => {
  const f = fixture(t, false, false);
  git(f.root, 'checkout', '-qb', 'pr', f.base);
  writeFileSync(join(f.root, 'pr.txt'), 'one\n');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-qm', 'pr one');
  const reviewed = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'pr.txt'), 'two\n');
  git(f.root, 'commit', '-qam', 'pr two');
  const pushed = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'merge', '-q', '--no-edit', f.trusted);
  const merged = git(f.root, 'rev-parse', 'HEAD');
  mkdirSync(join(f.root, '.codex-ci'));
  writeFileSync(join(f.root, '.codex-ci/ledger-evidence.json'), JSON.stringify({
    priorProjection: {}, modelReviewRequired: false, humanDecisions: [], evidenceChallenges: [],
  }));
  const scope = (head) => {
    writeFileSync(f.output, '');
    const result = runShell(block('Determine review scope', 'run'), f.root, {
      BASE_SHA: f.trusted, HEAD_SHA: head, LAST_REVIEWED_SHA: reviewed,
      FORCE_FULL_REVIEW: 'false', RESET_STATE: 'false', SINCE_SHA: '',
      EVENT_NAME: 'pull_request_target', GITHUB_OUTPUT: f.output,
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(f.output, 'utf8');
  };
  assert.match(scope(pushed), /review_mode=incremental\n[^]*review_scope_reason=since_last_review/);
  assert.match(scope(merged), /review_mode=full\n[^]*review_scope_reason=merge_base_moved/);
});

test('hosted prompt handles a multibyte character across the 4000-byte limit', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open-review-body-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reviewTmp = join(root, 'open-review');
  mkdirSync(reviewTmp);
  cpSync(resolve(__dirname, '../engine'), join(reviewTmp, 'engine'), { recursive: true });
  cpSync(resolve(__dirname, '../examples/rules.md'), join(reviewTmp, 'rules.md'));
  writeFileSync(join(reviewTmp, 'pr-body.txt'), 'a'.repeat(3998) + '—');
  mkdirSync(join(root, '.codex-ci'));
  const result = runShell(block('Build review prompt', 'run'), root, {
    RUNNER_TEMP: root, PARENT_MODEL: 'parent', CHILD_MODEL: 'child',
    PR_NUMBER: '7', PR_TITLE: 'Test', BASE_REF: 'main', HEAD_REF: 'feature',
    REVIEW_MODE: 'full', REVIEW_SCOPE_REASON: 'test', COMMIT_RANGE: '',
    COMMIT_COUNT: '0', DIFF_BASE_SHA: '', MERGE_BASE_SHA: '', HEAD_SHA: '',
  });
  assert.equal(result.status, 0, result.stderr);
  const prompt = readFileSync(join(root, '.codex-ci/review-prompt.md'), 'utf8');
  assert.ok(prompt.includes('a'.repeat(3998)));
  assert.ok(!prompt.includes('a'.repeat(3998) + '—'));
});

test('hosted prompt handles a 50000-character CJK description', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open-review-body-large-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reviewTmp = join(root, 'open-review');
  mkdirSync(reviewTmp);
  cpSync(resolve(__dirname, '../engine'), join(reviewTmp, 'engine'), { recursive: true });
  cpSync(resolve(__dirname, '../examples/rules.md'), join(reviewTmp, 'rules.md'));
  writeFileSync(join(reviewTmp, 'pr-body.txt'), '界'.repeat(50000));
  mkdirSync(join(root, '.codex-ci'));
  const result = runShell(block('Build review prompt', 'run'), root, {
    RUNNER_TEMP: root, PARENT_MODEL: 'parent', CHILD_MODEL: 'child',
    PR_NUMBER: '7', PR_TITLE: 'Test', BASE_REF: 'main', HEAD_REF: 'feature',
    REVIEW_MODE: 'full', REVIEW_SCOPE_REASON: 'test', COMMIT_RANGE: '',
    COMMIT_COUNT: '0', DIFF_BASE_SHA: '', MERGE_BASE_SHA: '', HEAD_SHA: '',
  });
  assert.equal(result.status, 0, result.stderr);
  const prompt = readFileSync(join(root, '.codex-ci/review-prompt.md'), 'utf8');
  assert.ok(prompt.includes('界'.repeat(1333)));
  assert.ok(!prompt.includes('界'.repeat(1334)));
});

for (const [name, baseRules, trustedRules, expected] of [
  ['base preferred', true, true, 'base rules\n'],
  ['non-default base ignored', true, true, 'trusted rules\n'],
  ['trusted default-branch fallback', false, true, 'trusted rules\n'],
  ['missing in both fails closed', false, false, null],
  ['large CJK body', true, true, 'base rules\n'],
]) {
  test(`local rule pack: ${name}`, (t) => {
    const f = fixture(t, baseRules, trustedRules);
    const engineRepo = mkdtempSync(join(tmpdir(), 'open-review-engine-'));
    t.after(() => rmSync(engineRepo, { recursive: true, force: true }));
    cpSync(resolve(__dirname, '../engine'), join(engineRepo, 'engine'), { recursive: true });
    git(engineRepo, 'init', '-q', '-b', 'main');
    git(engineRepo, 'config', 'user.name', 'Test');
    git(engineRepo, 'config', 'user.email', 'test@example.test');
    git(engineRepo, 'add', '.');
    git(engineRepo, 'commit', '-qm', 'engine');
    git(engineRepo, 'remote', 'add', 'origin', engineRepo);

    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    const pr = {
      number: 7, title: 'Test', body: name === 'base preferred' ? 'a'.repeat(3998) + '—' : name === 'large CJK body' ? '界'.repeat(50000) : 'description', baseRefName: name === 'non-default base ignored' ? 'release' : 'main',
      headRefName: 'feature', baseRefOid: f.base, headRefOid: f.base,
      headRepository: { nameWithOwner: 'owner/repo' }, url: 'https://example.test/pr/7',
    };
    const gh = `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then cat '${join(f.root, 'pr.json')}'; exit 0; fi
if [ "$1 $2" = "repo view" ]; then
  case "$*" in *defaultBranchRef*) echo main;; *) echo owner/repo;; esac
  exit 0
fi
if [ "$1" = api ]; then
  case "$2" in repos/owner/repo/git/ref/*) echo '${f.trusted}';; *) echo '[]';; esac
  exit 0
fi
exit 1
`;
    writeFileSync(join(f.root, 'pr.json'), JSON.stringify(pr));
    writeFileSync(join(bin, 'gh'), gh, { mode: 0o755 });
    const result = spawnSync('bash', [join(engineRepo, 'engine/run-local.sh'), '--pr', '7',
      '--rules', '.open-review/rules.md', '--prepare-only', '--allow-modified-runner'], {
      cwd: f.root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, expected === null ? 1 : 0, `${result.stdout}\n${result.stderr}`);
    if (expected === null) assert.match(result.stderr, /failed to stage rule pack/);
    else {
      const promptDir = result.stdout.match(/Run dir: (.+)/)?.[1];
      assert.ok(promptDir, result.stdout);
      assert.equal(readFileSync(join(promptDir, 'review-prompts/rules.md'), 'utf8'), expected);
      assert.match(result.stdout, new RegExp(`Rule pack ref: ${(expected.startsWith('base') ? f.base : f.trusted).slice(0, 7)}.*source=${expected.startsWith('base') ? 'base' : 'trusted_default_branch'}`));
      if (name === 'base preferred') {
        const prompt = readFileSync(join(promptDir, 'worktree/.codex-ci/review-prompt.md'), 'utf8');
        assert.ok(prompt.includes('a'.repeat(3998)));
        assert.ok(!prompt.includes('a'.repeat(3998) + '—'));
      }
      if (name === 'large CJK body') {
        const prompt = readFileSync(join(promptDir, 'worktree/.codex-ci/review-prompt.md'), 'utf8');
        assert.ok(prompt.includes('界'.repeat(1333)));
        assert.ok(!prompt.includes('界'.repeat(1334)));
      }
    }
  });
}

test('focused worker action step is guarded, fail-open and uses the staged engine', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open-review-action-fw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.codex-ci'));
  writeFileSync(join(root, '.codex-ci/focused-workers.json'), 'stale');
  mkdirSync(join(root, 'open-review'));
  writeFileSync(join(root, 'open-review/rules.md'), 'review rules\n');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/node'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$NODE_RECORD"\n', { mode: 0o755 });
  const start = action.indexOf('    - name: Run focused workers');
  const end = action.indexOf('    - name: Upload review transcripts', start);
  const step = action.slice(start, end);
  assert.match(step, /review_generated == 'true'/);
  assert.match(step, /review_mode != 'skip'/);
  assert.match(step, /steps\.skip\.outputs\.skip != 'true'/);
  assert.match(step, /continue-on-error: true/);
  assert.ok(start > action.indexOf('    - name: Verify checkout not modified'));
  const result = runShell(block('Run focused workers', 'run'), root, {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: root,
    CODEX_HOME: join(root, 'parent-home'), FOCUSED_WORKERS: '4', RULES_WORKER: 'true',
    DIFF_BASE_SHA: 'a'.repeat(40), NODE_RECORD: join(root, 'node-call'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, '.codex-ci/focused-workers.json')), false);
  assert.equal(readFileSync(join(root, '.codex-ci/rules.md'), 'utf8'), 'review rules\n');
  assert.match(readFileSync(join(root, 'node-call'), 'utf8'), /focused-workers\.cjs run 4 a{40}/);
  assert.match(readFileSync(join(root, 'node-call'), 'utf8'), /\/tmp\/open-review-fw\.[A-Za-z0-9]+ - \.codex-ci /);
  const privateHomeRoot = readFileSync(join(root, 'node-call'), 'utf8').match(/\/tmp\/open-review-fw\.[A-Za-z0-9]+/)?.[0];
  assert.ok(privateHomeRoot, 'worker home root must be outside the runner temp directory');
  assert.equal(existsSync(privateHomeRoot), false, 'worker stage removes its private home root');
  rmSync(join(root, 'node-call'));
  const invalid = runShell(block('Run focused workers', 'run'), root, {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: root,
    CODEX_HOME: join(root, 'parent-home'), FOCUSED_WORKERS: '5', RULES_WORKER: 'true',
    DIFF_BASE_SHA: 'a'.repeat(40), NODE_RECORD: join(root, 'node-call'),
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(existsSync(join(root, 'node-call')), false);
  const invalidRules = runShell(block('Run focused workers', 'run'), root, {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: root,
    CODEX_HOME: join(root, 'parent-home'), FOCUSED_WORKERS: '4', RULES_WORKER: 'yes',
    DIFF_BASE_SHA: 'a'.repeat(40), NODE_RECORD: join(root, 'node-call'),
  });
  assert.notEqual(invalidRules.status, 0);
  assert.equal(existsSync(join(root, 'node-call')), false);
  assert.match(step, /RULES_WORKER: \$\{\{ inputs\.rules-worker \}\}/);
});

test('the hosted action writes no credential file and removes the Codex home', (t) => {
  assert.doesNotMatch(action, /codex-auth-json-b64|auth\.json"|> "\$CODEX_HOME/);
  const root = mkdtempSync(join(tmpdir(), 'open-review-action-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'parent/sessions'), { recursive: true });
  const result = runShell(block('Remove Codex home', 'run'), root, { RUNNER_TEMP: root, CODEX_HOME: join(root, 'parent') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'parent')), false);
});

test('the provider check fails without a provider URL', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open-review-action-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runShell(block('Verify model provider reachability', 'run'), root,
    { PROVIDER_BASE_URL: '', PROVIDER_ENV_KEY: '', CODEX_CLI_VERSION: '0.157.1' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /provider-base-url is required/);
});
