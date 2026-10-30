const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = fs.readFileSync(path.join(__dirname, '../engine/run-local.sh'), 'utf8');
const shellFunction = (name, closing) => {
  const start = script.indexOf(`${name}() {`);
  return script.slice(start, script.indexOf(closing, start) + closing.length);
};
const settlementFunction = shellFunction('write_settlement_body', '\n  }\n');
const inlineFunction = shellFunction('write_inline_review_payload', '\n    }\n');
const HEADER = '> AI-generated review, posted with the operator token.\n\n---';

function run(t, functionText, call, envFor, header) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-review-attribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, RUN_DIR: root, HEAD_SHA: 'a'.repeat(40), ...envFor(root) };
  delete env.ATTRIBUTION_HEADER;
  if (header !== undefined) env.ATTRIBUTION_HEADER = header;
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `${functionText}\n${call}`], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

function settlementBody(t, header) {
  const env = (root) => ({ SETTLEMENT_BODY: path.join(root, 'comment.md'), SETTLEMENT_MARKER: 'marker',
    MERGE_GATE_SUMMARY: 'Merge gate: PASS', RULES_CHANGED: 'false', REVIEW_MARKDOWN: '### Findings\n\n- None.',
    REQUIRED_CODEX_CLI_VERSION: '0.157.1', SANDBOX_BACKEND: 'read-only', MODEL_PROVIDER: 'chatgpt',
    EXECUTION_EVIDENCE_OUTPUT: 'commands=1' });
  const root = run(t, settlementFunction, 'write_settlement_body false', env, header);
  return fs.readFileSync(path.join(root, 'comment.md'), 'utf8');
}

function inlinePayload(t, header) {
  const env = (root) => {
    const settlement = path.join(root, 'settlement.json');
    fs.writeFileSync(settlement, JSON.stringify({ inline: { comments: [
      { path: 'a.ts', line: 3, side: 'RIGHT', body: '**First**\n\nDetail.' },
      { path: 'b.ts', line: 9, side: 'RIGHT', body: '**Second**' },
    ] } }));
    return { SETTLEMENT_JSON: settlement, INLINE_REVIEW_PAYLOAD: path.join(root, 'payload.json'),
      SETTLEMENT_COMMENT_URL: 'https://example.test/c/1' };
  };
  const root = run(t, inlineFunction, 'write_inline_review_payload', env, header);
  return JSON.parse(fs.readFileSync(path.join(root, 'payload.json'), 'utf8'));
}

test('settlement keeps the marker first and places the attribution header after it', (t) => {
  const plain = settlementBody(t, undefined);
  const attributed = settlementBody(t, HEADER);
  const marker = `<!-- marker head=${'a'.repeat(40)} -->`;
  assert.equal(plain.split('\n', 1)[0], marker);
  assert.equal(attributed.split('\n', 1)[0], marker);
  assert.ok(plain.startsWith(`${marker}\n\nMerge gate: PASS\n\n`));
  assert.ok(attributed.startsWith(`${marker}\n\n${HEADER}\n\nMerge gate: PASS\n\n`));
  assert.equal(attributed.replace(`${HEADER}\n\n`, ''), plain);
});

test('inline review body and every inline comment carry the attribution header', (t) => {
  const plain = inlinePayload(t, undefined);
  assert.equal(plain.body, 'See the local Code Review settlement: https://example.test/c/1');
  assert.deepEqual(plain.comments.map((comment) => comment.body), ['**First**\n\nDetail.', '**Second**']);

  const attributed = inlinePayload(t, HEADER);
  assert.equal(attributed.commit_id, 'a'.repeat(40));
  assert.equal(attributed.event, 'COMMENT');
  assert.equal(attributed.body, `${HEADER}\n\nSee the local Code Review settlement: https://example.test/c/1`);
  assert.deepEqual(attributed.comments.map((comment) => comment.body),
    [`${HEADER}\n\n**First**\n\nDetail.`, `${HEADER}\n\n**Second**`]);
  assert.deepEqual(attributed.comments.map(({ path: file, line, side }) => [file, line, side]),
    [['a.ts', 3, 'RIGHT'], ['b.ts', 9, 'RIGHT']]);
});
