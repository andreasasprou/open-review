#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { unquoteGitPath } = require("./inventory-diff.cjs");

const TEST_SEGS = new Set(["__tests__", "test", "tests", "eval", "evals"]);
const FIXTURE_SEGS = new Set(["fixtures", "fixture", "__fixtures__"]);
const GEN_SEGS = new Set(["generated", "__generated__"]);
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock", "npm-shrinkwrap.json", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock", "go.sum"]);
const HEADER_RE = /@generated|DO NOT EDIT|auto-?generated/i;
const CANDIDATE_KEYS = ["title", "file", "line", "property", "property_source", "initial_state", "input", "trace", "violation", "pr_causality", "guard_checked", "severity"];
const RULES_KEYS = ["title", "file", "line", "severity", "rule_source", "change", "violation"];
const RULES_FILE = "(repository rules)";
const MAX_WORKERS = 4;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
// The rules worker reads repository guidance and needs up to 12 minutes on large PRs.
const STAGE_TIMEOUT_MS = 13 * 60 * 1000;
const REAP_TIMEOUT_MS = 30 * 1000;

function excluded(pathname, header = "") {
  const segments = pathname.split("/");
  const name = segments.pop();
  if (name.includes(".test.") || name.includes(".spec.") || name.includes(".eval.") || name.includes(".vitest") || segments.some((s) => TEST_SEGS.has(s))) return "test";
  if (name.endsWith(".md") || segments.includes("docs")) return "doc";
  if (name.toLowerCase().includes("fixture") || segments.some((s) => FIXTURE_SEGS.has(s))) return "fixture";
  if (name.endsWith(".snap") || segments.includes("__snapshots__")) return "snapshot";
  if (LOCKFILES.has(name) || /[-.]lock\.(json|ya?ml)$/.test(name)) return "lockfile";
  if (segments.some((s) => GEN_SEGS.has(s)) || /\.(generated|gen)\./.test(name) || name.endsWith(".min.js") || name.endsWith(".map")) return "generated";
  if (HEADER_RE.test(header.split(/\r?\n/).slice(0, 5).join("\n"))) return "generated";
  return null;
}

function parseDiff(patch) {
  const chunks = patch.split(/(?=^diff --git )/m).filter((part) => part.startsWith("diff --git "));
  return chunks.map((chunk) => {
    const header = chunk.match(/^diff --git ("(?:\\.|[^"])*"|a\/.*?)(?: )("(?:\\.|[^"])*"|b\/.*)$/m);
    const oldMatch = chunk.match(/^--- (.+)$/m);
    const newMatch = chunk.match(/^\+\+\+ (.+)$/m);
    const gitPath = (value, prefix) => value && value.trim() !== "/dev/null"
      ? unquoteGitPath(value.trim()).replace(new RegExp(`^${prefix}/`), "") : "";
    const pathname = gitPath(newMatch?.[1], "b") || gitPath(oldMatch?.[1], "a") ||
      gitPath(header?.[2], "b");
    if (!pathname) return null;
    let added = 0; let removed = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return { file: pathname, deleted: newMatch?.[1]?.trim() === "/dev/null" || /^deleted file mode /m.test(chunk), added, removed,
      hunks: [...chunk.matchAll(/^@@ -\S+ \+\S+ @@/gm)].map((m) => m[0]) };
  }).filter(Boolean);
}

function selectSlices(patch, max, headerForFile = () => "") {
  if (!Number.isInteger(max) || max < 0 || max > MAX_WORKERS) throw new Error("focused-workers must be an integer from 0 to 4");
  // The pilot ranks deleted paths too; their old content remains available at BASE.
  return parseDiff(patch).filter((entry) => !excluded(entry.file, entry.deleted ? "" : headerForFile(entry.file)))
    .sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, max).map((entry, index) => ({ index, file: entry.file, hunks: entry.hunks }));
}

function validOutput(output, slice) {
  const bounded = (value, max = 2000) => typeof value === "string" && value.length <= max;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  if (Object.keys(output).sort().join() !== ["slice", "status", "candidates", "inputs_tried", "open_suspicions"].sort().join()) return false;
  if (output.slice !== slice.file || !bounded(output.slice) || !["candidates", "no_counterexample_within_budget"].includes(output.status)) return false;
  if (!Array.isArray(output.candidates) || output.candidates.length > 5 || !Array.isArray(output.inputs_tried) || !Array.isArray(output.open_suspicions) || output.open_suspicions.length > 3) return false;
  if (output.inputs_tried.some((v) => !bounded(v)) || output.open_suspicions.some((v) => !bounded(v))) return false;
  return output.candidates.every((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    Object.keys(candidate).sort().join() === CANDIDATE_KEYS.slice().sort().join() &&
    CANDIDATE_KEYS.filter((key) => key !== "line" && key !== "severity").every((key) => bounded(candidate[key], key === "title" ? 200 : 2000)) &&
    Number.isInteger(candidate.line) && candidate.line > 0 && ["P1", "P2", "P3"].includes(candidate.severity));
}

function validRulesOutput(output) {
  const bounded = (value, max = 2000) => typeof value === "string" && value.length <= max;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  if (Object.keys(output).sort().join() !== "files_read,findings") return false;
  if (!Array.isArray(output.findings) || output.findings.length > 8 || !Array.isArray(output.files_read) ||
    output.files_read.length > 50 || output.files_read.some((v) => !bounded(v))) return false;
  return output.findings.every((finding) => finding && typeof finding === "object" && !Array.isArray(finding) &&
    Object.keys(finding).sort().join() === RULES_KEYS.slice().sort().join() &&
    ["title", "file", "rule_source", "change", "violation"].every((key) => bounded(finding[key], key === "title" ? 200 : 2000)) &&
    Number.isInteger(finding.line) && finding.line > 0 && ["P2", "P3"].includes(finding.severity));
}

function usageFromLog(logPath) {
  let usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  try {
    for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
      if (!line.includes('"turn.completed"')) continue;
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) {
        usage = Object.fromEntries(Object.keys(usage).map((key) => [key, Number(event.usage[key]) || 0]));
      }
    }
  } catch { /* A failed worker still reports its last readable usage. */ }
  return usage;
}

function configArgs(providerBaseUrl, providerEnvKey) {
  if (!providerBaseUrl) return [];
  const args = [
    '-c', 'model_provider="open-review"',
    '-c', 'model_providers.open-review.name="openai"',
    '-c', `model_providers.open-review.base_url=${JSON.stringify(providerBaseUrl.replace(/\/$/, ""))}`,
    '-c', 'model_providers.open-review.wire_api="responses"',
    '-c', 'model_providers.open-review.supports_websockets=false',
    '-c', 'model_providers.open-review.requires_openai_auth=false',
  ];
  if (providerEnvKey) args.push('-c', `model_providers.open-review.env_key=${JSON.stringify(providerEnvKey)}`);
  return args;
}

function signalWorkerTree(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function workerTreeAlive(pgid) {
  if (!pgid) return false;
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function runWorker(slice, options) {
  const home = fs.mkdtempSync(path.join(options.homeRoot, `codex-home-fw-${slice.index}-`));
  fs.chmodSync(home, 0o700);
  try {
    return await new Promise((resolve, reject) => {
      const output = path.join(options.outputDir, `focused-worker-${slice.index}.json`);
      const log = path.join(options.outputDir, `focused-worker-${slice.index}.jsonl`);
      const rules = slice.kind === "rules";
      const prompt = rules ? fs.readFileSync(path.join(__dirname, "rules-worker-prompt.txt"), "utf8")
        : fs.readFileSync(path.join(__dirname, "focused-worker-prompt.txt"), "utf8")
          .replaceAll("{{SLICE_FILE}}", slice.file).replaceAll("{{HUNKS}}", slice.hunks.join(", "))
          .replaceAll("{{BASE_SHA}}", options.baseSha);
      if (options.authSource && fs.existsSync(options.authSource)) {
        fs.copyFileSync(options.authSource, path.join(home, "auth.json"));
        fs.chmodSync(path.join(home, "auth.json"), 0o600);
      }
      const args = ['--kill-after=30s', rules ? '12m' : '8m', 'codex', 'exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config',
        '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort="high"', '-c', 'sandbox_mode="read-only"',
        '-c', 'allow_login_shell=false', '-c', 'web_search="disabled"',
        '-c', `shell_environment_policy.exclude=${JSON.stringify(["CODEX_HOME", "HOME", "RUNNER_TEMP", ...(options.providerEnvKey ? [options.providerEnvKey] : [])])}`,
        ...configArgs(options.providerBaseUrl, options.providerEnvKey), '--disable', 'plugins', '--json',
        '--output-schema', path.join(__dirname, rules ? 'rules-worker-schema.json' : 'focused-worker-schema.json'), '-o', output, '-'];
      const env = { PATH: process.env.PATH, TERM: process.env.TERM || 'dumb', LANG: process.env.LANG || 'C.UTF-8', CODEX_HOME: home };
      if (options.providerEnvKey) env[options.providerEnvKey] = process.env[options.providerEnvKey];
      let stdoutFd;
      let stderrFd;
      let child;
      let spawnFailed = false;
      try {
        stdoutFd = fs.openSync(log, 'w');
        stderrFd = fs.openSync(path.join(options.outputDir, `focused-worker-${slice.index}.stderr.log`), 'w');
        child = spawn(options.timeoutCommand || 'timeout', args,
          { cwd: options.root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.once('error', () => { spawnFailed = true; });
      } catch (error) {
        if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
        if (stderrFd !== undefined) fs.closeSync(stderrFd);
        reject(error);
        return;
      }
      let stageTimedOut = false;
      let overflowReason = '';
      let sinkFailed = false;
      let settled = false;
      let stopTimer;
      let reapTimer;
      let closeTimer;
      let pollTimer;
      const finish = (code, unreaped = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(stopTimer);
        clearTimeout(reapTimer);
        clearTimeout(closeTimer);
        clearTimeout(pollTimer);
        try {
          options.signal?.removeEventListener('abort', onAbort);
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (unreaped) { child.stdin?.destroy(); child.unref(); }
          for (const fd of [stdoutFd, stderrFd]) {
            try { fs.closeSync(fd); } catch { sinkFailed = true; }
          }
          stdoutFd = stderrFd = undefined;
          const usage = usageFromLog(log);
          let status = unreaped || overflowReason || sinkFailed ? 'error' :
            stageTimedOut || code === 124 || code === 137 ? 'timeout' :
              code === 0 && !promptWriteFailed && !spawnFailed ? 'ok' : 'error';
          let reason = unreaped ? 'unreaped' : overflowReason ||
            (sinkFailed ? 'sink_error' : stageTimedOut ? 'stage_deadline' :
              status === 'timeout' ? 'timeout' : spawnFailed ? 'spawn_error' :
                promptWriteFailed ? 'prompt_write_error' : status === 'error' ? `exit ${code}` : '');
          let candidates = [];
          if (status === 'ok') {
            try {
              if (fs.statSync(output).size > MAX_ANSWER_BYTES) {
                status = 'invalid_json';
                reason = 'answer_too_large';
              } else {
                const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
                if (!(rules ? validRulesOutput(parsed) : validOutput(parsed, slice))) { status = 'invalid_json'; reason = 'answer_invalid'; }
                // Rule findings use the advisory renderer's fields: the change is the input, the rule is the source.
                else candidates = rules ? parsed.findings.map(({ title, file, line, severity, rule_source, change, violation }) =>
                  ({ title, file, line, severity, input: change, violation, property_source: rule_source })) : parsed.candidates;
              }
            } catch { status = 'invalid_json'; reason = 'answer_invalid'; }
          }
          resolve({ file: slice.file, ...(rules ? { kind: 'rules' } : {}), status, reason: reason.slice(0, 200), candidates, usage });
        } catch {
          resolve({ file: slice.file, status: 'error', reason: 'unreaped', candidates: [], usage: {} });
        } finally {
          for (const fd of [stdoutFd, stderrFd]) {
            if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Already failing open. */ } }
          }
        }
      };
      const stop = () => {
        if (settled || stopTimer) return;
        try { signalWorkerTree(child, 'SIGTERM'); }
        catch { sinkFailed = true; }
        stopTimer = setTimeout(() => {
          try { signalWorkerTree(child, 'SIGKILL'); }
          catch { sinkFailed = true; }
          reapTimer = setTimeout(() => finish(null, true), REAP_TIMEOUT_MS);
        }, 1000);
      };
      const onAbort = () => { stageTimedOut = true; stop(); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const capture = (stream, fd, limit, capReason) => {
        if (!stream) { sinkFailed = true; return; }
        let bytes = 0;
        stream.on('data', (chunk) => {
          if (settled || sinkFailed) return;
          const remaining = limit - bytes;
          try { if (remaining > 0) fs.writeSync(fd, chunk.subarray(0, remaining)); }
          catch { sinkFailed = true; stop(); return; }
          bytes += chunk.length;
          if (bytes > limit && !overflowReason) { overflowReason = capReason; stop(); }
        });
        stream.on('error', () => { if (!settled) { sinkFailed = true; stop(); } });
      };
      capture(child.stdout, stdoutFd, MAX_STDOUT_BYTES, 'stream_cap');
      capture(child.stderr, stderrFd, MAX_STDERR_BYTES, 'stderr_cap');
      // A worker can exit before reading the prompt (for example, auth or CLI failure).
      // Its broken pipe is part of that worker's error, not a parent process failure.
      let promptWriteFailed = false;
      if (child.stdin) {
        child.stdin.on('error', () => { promptWriteFailed = true; });
        child.stdin.end(prompt);
      } else promptWriteFailed = true;
      child.once('exit', (code) => {
        if (settled) return;
        try {
          if (workerTreeAlive(child.pid)) stop();
          else closeTimer = setTimeout(() => finish(code, true), REAP_TIMEOUT_MS);
        } catch { sinkFailed = true; stop(); }
      });
      child.once('close', (code) => {
        const check = () => {
          if (settled) return;
          try {
            if (!workerTreeAlive(child.pid)) { finish(code); return; }
            stop();
            pollTimer = setTimeout(check, 50);
          } catch {
            sinkFailed = true;
            stop();
            try { signalWorkerTree(child, 'SIGKILL'); } catch { /* Already failing open. */ }
            finish(code, true);
          }
        };
        check();
      });
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function run(options) {
  const max = Number(options.max);
  if (!Number.isInteger(max) || max < 0 || max > MAX_WORKERS) throw new Error('focused-workers must be an integer from 0 to 4');
  const resultPath = path.join(options.outputDir, 'focused-workers.json');
  const patch = fs.readFileSync(path.join(options.outputDir, 'pr-diff.patch'), 'utf8');
  const slices = selectSlices(patch, max, (file) => {
    let fd;
    try {
      // Read regular files inside the checkout only; a PR symlink must not reach runner files.
      const root = fs.realpathSync(options.root);
      const real = fs.realpathSync(path.resolve(root, file));
      if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return '';
      fd = fs.openSync(real, 'r');
      const buffer = Buffer.alloc(2000);
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, 2000, 0)).toString('utf8');
    } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
  const jobs = options.rules ? [...slices, { index: slices.length, file: RULES_FILE, kind: 'rules', hunks: [] }] : slices;
  const failed = (job, reason) => ({ file: job.file, ...(job.kind ? { kind: job.kind } : {}), status: 'error', reason, candidates: [], usage: {} });
  let result;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.stageTimeoutMs ?? STAGE_TIMEOUT_MS);
  const onSignal = () => controller.abort();
  // A cancelled run can signal the driver more than once (its process group, then the
  // runner's exit trap); every signal must abort, not kill the driver before it reaps.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    result = Array(jobs.length);
    let next = 0;
    // The rules worker runs beside the slice workers, not queued behind them.
    await Promise.all(Array.from({ length: Math.min(MAX_WORKERS + 1, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++;
        try { result[index] = await runWorker(jobs[index], { ...options, signal: controller.signal }); }
        catch (error) {
          process.stderr.write(`focused worker ${index} failed open: ${error.message}\n`);
          result[index] = failed(jobs[index], 'setup_error');
        }
      }
    }));
  } catch (error) {
    result = jobs.map((job) => failed(job, 'stage_error'));
    process.stderr.write(`focused workers failed open: ${error.message}\n`);
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function main(argv) {
  if (argv[0] !== 'run') throw new Error('usage: focused-workers.cjs run <max> <base-sha> <home-root> <auth-source> <output-dir> <root> [timeout|gtimeout]');
  const [, max, baseSha, homeRoot, authSource, outputDir, root, timeoutCommand = 'timeout'] = argv;
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('base SHA must be a full SHA');
  if (!['timeout', 'gtimeout'].includes(timeoutCommand)) throw new Error('unsupported timeout command');
  return run({ max, baseSha, homeRoot, authSource: authSource === '-' ? '' : authSource, outputDir, root, timeoutCommand,
    providerBaseUrl: process.env.PROVIDER_BASE_URL || '', providerEnvKey: process.env.PROVIDER_ENV_KEY || '',
    rules: process.env.RULES_WORKER === 'true' });
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { excluded, parseDiff, selectSlices, validOutput, validRulesOutput, run, usageFromLog };
