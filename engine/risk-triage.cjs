"use strict";

// Review level of a PR (decision risk-triage):
// - floor-high: the PR changes a sensitive path (focused-workers.cjs); no model call;
// - otherwise GPT-6.1 Sol at medium effort reads a capped summary of the PR and
//   answers high (model-high) or normal. Any request error, timeout or invalid
//   answer is model-high. PR text is attacker-controlled, so the model can only
//   raise a level: it never sees a floor-high PR.
// Every PR gets a model review: a level without one needs a merge gate that
// re-derives it, so it belongs to the consumer, not this engine.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { excluded, parseDiff, sensitivePaths } = require("./focused-workers.cjs");

const MODEL = "gpt-6.1-sol";
const REASONING_EFFORT = "medium";
// Bump with every prompt, schema or input-format change, and recalibrate
// (docs/evaluation-protocol.md, "Risk triage calibration").
const PROMPT_VERSION = "risk-triage-v2";
const PROMPT = fs.readFileSync(path.join(__dirname, "risk-triage-prompt.txt"), "utf8");
const TIMEOUT_MS = 60 * 1000;
// What each level runs. GPT-6 Astra reviews at most `roundCap.rounds` rounds
// of one PR; the local runner gives later rounds the cap's model and effort
// (decision astra-round-cap).
const LEVELS = {
  "floor-high": { parentModel: "gpt-6-astra", reasoning: null, workers: 2, rulesWorker: true, helpers: true,
    roundCap: { rounds: 2, parentModel: "gpt-6.1-sol", reasoning: "high" } },
  "model-high": { parentModel: "gpt-6.1-sol", reasoning: "high", workers: 0, rulesWorker: true, helpers: true, roundCap: null },
  normal: { parentModel: "gpt-6.1-sol", reasoning: "medium", workers: 0, rulesWorker: false, helpers: false, roundCap: null },
};
const RANK = { docs: 0, normal: 1, high: 2 };
const LIMITS = { title: 300, body: 2500, files: 150, excerpts: 9000, perFile: 1500, line: 160 };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["risk", "reasons", "confidence"],
  properties: {
    risk: { type: "string", enum: ["high", "normal", "docs"] },
    reasons: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

/** Version plus a digest of everything the model sees besides the PR, for calibration records. */
function promptIdentity() {
  const digest = createHash("sha256").update(JSON.stringify([PROMPT_VERSION, MODEL, REASONING_EFFORT, PROMPT, SCHEMA, LIMITS])).digest("hex");
  return { version: PROMPT_VERSION, model: MODEL, effort: REASONING_EFFORT, sha256: digest.slice(0, 12) };
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}… (${value.length - max} more characters)`;
}

/**
 * The user message: title, description, file list and changed-line excerpts,
 * all inside one untrusted block. `patch` is `git diff --no-renames` output, so
 * a rename lists its source path too.
 */
function triageInput({ title, body, patch }) {
  const files = String(patch ?? "").split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith("diff --git ")).flatMap((chunk) => {
    const [entry] = parseDiff(chunk);
    if (!entry) return [];
    const kind = excluded(entry.file);
    const status = entry.deleted ? "D" : /^new file mode /m.test(chunk) ? "A" : "M";
    const lines = chunk.split("\n").filter((line) => line.startsWith("@@") || ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")));
    return [{ ...entry, kind, status, lines }];
  });
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const core = files.filter((file) => !file.kind);
  const coreChurn = core.reduce((sum, file) => sum + file.added + file.removed, 0);
  const listed = files.slice(0, LIMITS.files).map((file) => `${file.status} ${file.file} +${file.added} -${file.removed}${file.kind ? ` [${file.kind}]` : ""}`);
  if (files.length > LIMITS.files) listed.push(`… and ${files.length - LIMITS.files} more files`);
  const byChurn = (a, b) => (b.added + b.removed) - (a.added + a.removed) || (a.file < b.file ? -1 : 1);
  const excerpts = [];
  let budget = LIMITS.excerpts;
  for (const file of [...core.sort(byChurn), ...files.filter((entry) => entry.kind === "doc").sort(byChurn)]) {
    if (budget <= 0) break;
    let text = `### ${file.file}\n`;
    let shown = 0;
    for (const line of file.lines) {
      const next = `${clip(line, LIMITS.line)}\n`;
      if (text.length + next.length > Math.min(LIMITS.perFile, budget)) break;
      text += next;
      shown += 1;
    }
    if (shown < file.lines.length) text += `… ${file.lines.length - shown} more changed lines\n`;
    excerpts.push(text);
    budget -= text.length;
  }
  const data = [
    `Title: ${clip(title, LIMITS.title)}`,
    `Description:\n${clip(body || "(empty)", LIMITS.body)}`,
    `Changed files: ${files.length} (+${added} -${removed}); outside tests, docs and generated files: ${core.length} files, ${coreChurn} changed lines.`,
    listed.join("\n"),
    `Diff excerpts (changed lines only, capped):\n${excerpts.join("\n")}`,
  ].join("\n\n");
  // The data cannot close its own block.
  return `<untrusted_pr>\n${data.replace(/<\/?untrusted_pr/gi, "<_untrusted_pr")}\n</untrusted_pr>`;
}

function requestBody(input) {
  return {
    model: MODEL,
    instructions: PROMPT,
    input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
    reasoning: { effort: REASONING_EFFORT },
    text: { format: { type: "json_schema", name: "risk_triage", strict: true, schema: SCHEMA } },
    store: false,
    stream: true,
  };
}

/** The model's answer, or null unless it is exactly the schema. */
function parseTriage(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join() !== "confidence,reasons,risk") return null;
  // Exactly one of the strings: a non-string key would coerce (["high"] is "high").
  if (typeof value.risk !== "string" || !Object.hasOwn(RANK, value.risk)) return null;
  if (!Array.isArray(value.reasons) || value.reasons.length < 1 || value.reasons.length > 3 ||
    value.reasons.some((reason) => typeof reason !== "string" || reason.length === 0 || reason.length > 500)) return null;
  if (typeof value.confidence !== "number" || !(value.confidence >= 0 && value.confidence <= 1)) return null;
  return value;
}

/**
 * The tier the engine acts on. `result` is the parsed answer or null after any
 * failure; `paths` includes rename sources; `docsOnly` is the consumer's
 * deterministic docs-only rule.
 */
function finalRisk({ result, paths, docsOnly }) {
  const floorPaths = sensitivePaths(paths);
  const floor = floorPaths.length > 0 ? "high" : docsOnly ? "docs" : "normal";
  const model = result ? result.risk : "high";
  return { risk: RANK[model] >= RANK[floor] ? model : floor, floor, model: result ? result.risk : null, floorPaths };
}

function completedResponse(sse) {
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || !line.includes('"response.completed"')) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.completed") return event.response;
  }
  return null;
}

/**
 * One triage call to a Responses endpoint (`<baseUrl>/responses`). Returns
 * { result, usage, ms } or { result: null, error, detail, usage, ms }; never throws.
 */
async function triage({ baseUrl, apiKey = "", input, timeoutMs = TIMEOUT_MS, fetchImpl = fetch }) {
  const started = Date.now();
  const failure = (error, detail = "", usage = null) => ({ result: null, error, detail: clip(detail, 500), usage, ms: Date.now() - started });
  try {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/responses`, {
      method: "POST", headers, body: JSON.stringify(requestBody(input)), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) return failure("http_error", `HTTP ${response.status}: ${text}`);
    const completed = completedResponse(text);
    if (!completed) return failure("incomplete_response", text.slice(-500));
    const answer = (completed.output || []).filter((item) => item.type === "message")
      .flatMap((item) => item.content || []).map((part) => part.text || "").join("");
    const result = parseTriage(answer);
    return result ? { result, usage: completed.usage ?? null, ms: Date.now() - started } : failure("invalid_output", answer, completed.usage ?? null);
  } catch (error) {
    return failure(error?.name === "TimeoutError" ? "timeout" : "request_error", String(error?.message ?? error));
  }
}

/** Every path the PR changes, rename sources included, decoded losslessly (NUL-delimited). */
function changedPaths(root, mergeBase, head) {
  return execFileSync("git", ["-C", root, "diff", "--name-only", "-z", "--no-renames", mergeBase, head],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
}

/** The review level and what it runs; calls the triage model only when the paths do not decide. */
async function reviewLevel({ root, mergeBase, head, title, body, baseUrl, apiKey, rulesPath = "", triageImpl = triage }) {
  const floorPaths = sensitivePaths(changedPaths(root, mergeBase, head), rulesPath ? [rulesPath] : []);
  if (floorPaths.length > 0) return { level: "floor-high", floorPaths, ...LEVELS["floor-high"], triage: null };
  const patch = execFileSync("git", ["-C", root, "-c", "core.quotePath=false", "diff", "--no-renames", "--no-color", "--no-ext-diff", mergeBase, head],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const outcome = baseUrl
    ? await triageImpl({ baseUrl, apiKey, input: triageInput({ title, body, patch }) })
    : { result: null, error: "no_provider", detail: "no provider base URL for the triage call", usage: null, ms: 0 };
  // "docs" on a PR outside the docs-only paths is normal.
  const level = outcome.result && outcome.result.risk !== "high" ? "normal" : "model-high";
  return { level, floorPaths, ...LEVELS[level],
    triage: { version: PROMPT_VERSION, risk: outcome.result?.risk ?? null, reasons: outcome.result?.reasons ?? [],
      error: outcome.error ?? null, detail: outcome.detail ?? null, ms: outcome.ms } };
}

async function main(argv) {
  const [command, root, mergeBase, head, title, bodyFile, rulesPath = ""] = argv;
  if (command !== "level" || ![root, mergeBase, head, title, bodyFile].every((value) => typeof value === "string" && value !== "")) {
    throw new Error("usage: risk-triage.cjs level <root> <merge-base> <head> <title> <body-file> [<rules-path>]");
  }
  const keyName = process.env.PROVIDER_ENV_KEY || "";
  const result = await reviewLevel({ root, mergeBase, head, title, body: fs.readFileSync(bodyFile, "utf8"), rulesPath,
    baseUrl: process.env.PROVIDER_BASE_URL || "", apiKey: keyName ? process.env[keyName] || "" : "" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { MODEL, REASONING_EFFORT, PROMPT_VERSION, LEVELS, promptIdentity, triageInput, requestBody, parseTriage,
  finalRisk, triage, reviewLevel };
