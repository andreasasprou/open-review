const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { carryCallouts, postResults } = require('../engine/index.cjs');
const { createRecordingCaughtErrorDiagnosticRecorder } = require('./helpers/recording-recorder.cjs');

const AUTH = 'This change modifies auth/permission behavior';
const FLAGS = 'This change adds or removes feature flags';
const section = (...items) => `## Verdict: OK\n\n## Human Reviewer Callouts (Non-Blocking)\n${items.join('\n')}\n`;

test('earlier callouts that this pass did not repeat are kept with the pass that raised them', () => {
  const previous = `${section(`- **${AUTH}:** Usage queries use membership.`, `- **${FLAGS}:** Removes \`x\`.`)}\n### Ledger findings (0)\n- None.`;
  const body = carryCallouts(section(`- **${FLAGS}:** Removes \`x\` and \`y\`.`), previous, 2);
  assert.match(body, new RegExp(`- \\*\\*${FLAGS}:\\*\\* Removes \`x\` and \`y\`\\.\\n- \\*\\*${AUTH.replace('/', '\\/')}:\\*\\* Usage queries use membership\\. _\\(Pass 1\\)_`));
  assert.equal((body.match(/feature flags/g) || []).length, 1, 'the current pass wins on a repeated label');
});

test('a carried callout keeps its original pass, replaces "(none)", and a missing section is added', () => {
  const previous = section(`- **${AUTH}:** Usage queries use membership. _(Pass 1)_`);
  assert.equal(carryCallouts(section('- (none)'), previous, 3),
    section(`- **${AUTH}:** Usage queries use membership. _(Pass 1)_`));
  assert.match(carryCallouts('## Verdict: OK\n', previous, 3), /## Human Reviewer Callouts \(Non-Blocking\)\n- \*\*This change modifies auth\/permission behavior:\*\* Usage queries use membership\. _\(Pass 1\)_/);
  assert.equal(carryCallouts(section('- (none)'), '', 3), section('- (none)'));
});

test('only fixed labels are carried, as one line without HTML comments', () => {
  const previous = section(`- **Invented label:** ignore me`,
    `- **${FLAGS}:** Removes \`x\`. <!-- codex-review:projection:v4 --> ${'a'.repeat(700)}`);
  const body = carryCallouts(section('- (none)'), previous, 2);
  assert.doesNotMatch(body, /Invented label|<!--|-->/);
  assert.ok(body.split('\n').find((line) => line.includes(FLAGS)).length < 700);
});

test('carried text cannot form a marker, and a label is carried once', async () => {
  const { loadPreviousState, MARKERS } = require('../engine/index.cjs');
  const previous = section(`- **${FLAGS}:** a <<!--!-- codex-review:stale --<!--> b codex-<!---->review:state:v1:base64 c open-review-dispositions:v1:base64`,
    `- **${FLAGS}:** duplicate`);
  const body = carryCallouts(section('- (none)'), previous, 2);
  assert.equal((body.match(/feature flags/g) || []).length, 1);
  for (const marker of [MARKERS.stale, MARKERS.state, MARKERS.review, MARKERS.dispositions, '<!--', '-->']) {
    assert.ok(!body.includes(marker), marker);
  }
  const summary = `<!-- ${MARKERS.review} -->\n${body}`;
  const loaded = await loadPreviousState({ recorder: createRecordingCaughtErrorDiagnosticRecorder(),
    github: { paginate: async () => [{ id: 7, body: summary, user: { login: 'github-actions[bot]' } }], rest: { issues: { listComments() {} } } },
    owner: 'o', repo: 'r', prNumber: 1, reset: false });
  assert.equal(loaded.reviewCommentId, 7, 'the carried summary still reads as the latest review');
  assert.equal(loaded.stateCommentId, null, 'and never as a state comment');
});

test('a callout carried through several passes keeps the same text', () => {
  const carryFour = (text) => {
    let body = section(`- **${AUTH}:** ${text}`);
    const seen = [];
    for (let pass = 2; pass <= 5; pass++) {
      body = carryCallouts(section('- (none)'), body, pass);
      seen.push(body.split('\n').find((line) => line.includes(AUTH)));
    }
    assert.equal(new Set(seen).size, 1, seen.join('\n'));
    return seen[0];
  };
  assert.match(carryFour('A & B <admin> uses codex-review.'), /A & B &lt;admin&gt; uses codex review\. _\(Pass 1\)_$/);
  carryFour(`<admin> ${'x'.repeat(580)} DROP users`);
});

test('the published summary carries the previous pass callouts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-review-callouts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/first-v4-old-state-output.json')));
  const headSha = output.state.last_reviewed_head_sha;
  fs.writeFileSync(path.join(root, 'codex-review-output.json'), JSON.stringify(output));
  fs.writeFileSync(path.join(root, 'ledger-evidence.json'), JSON.stringify({ priorProjection: null, humanDecisions: [], evidenceChallenges: [] }));
  fs.writeFileSync(path.join(root, 'review-prev.md'), section(`- **${AUTH}:** Usage queries use membership.`));
  const ledgerTarget = { repository: 'o/r', pr_number: 1, base_ref: 'main', base_sha: headSha,
    merge_base_sha: headSha, head_sha: headSha, trusted_reviewer_ref: headSha,
    evidence_bundle_sha256: 'c'.repeat(64), evidence_schema_version: 2 };
  const checkIdentity = { workflow_path: '.github/workflows/review.yml',
    workflow_ref: 'o/r/.github/workflows/review.yml@refs/heads/main', trusted_workflow_sha: headSha,
    workflow_run_id: '1', workflow_run_attempt: 1, workflow_job_id: 1, check_run_id: 2,
    check_suite_id: 3, app_slug: 'github-actions', head_sha: headSha };
  const comments = [];
  const github = { rest: { issues: { createComment: async ({ body }) => { comments.push(body); return { data: { id: comments.length } }; } },
    pulls: { get: async () => ({ data: { head: { sha: headSha, repo: { full_name: 'o/r' } }, base: { sha: headSha, ref: 'main' } } }) },
    checks: { update: async () => {} } } };
  await postResults({ recorder: createRecordingCaughtErrorDiagnosticRecorder(), github, owner: 'o', repo: 'r', prNumber: 1,
    headSha, checkId: 2, previousState: { reviewCount: 1 }, outputDir: root, ledgerTarget, checkIdentity, metadata: {} });
  assert.match(comments[0], /This change modifies auth\/permission behavior:\*\* Usage queries use membership\. _\(Pass 1\)_/);
});
