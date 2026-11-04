#!/usr/bin/env node
"use strict";

// Calibrate the risk-triage prompt against a consumer's labelled PR manifest
// (decision risk-triage; docs/evaluation-protocol.md, "Risk triage calibration").
//
// usage: node eval/risk-triage-calibrate.cjs --manifest <path> --repo <git dir> --out <dir>
//          [--base-url <Responses base URL>] [--api-key-env <NAME>] [--concurrency <n>]
//          [--docs-only-paths "<globs>"] [--case <pr>]
//
// Run it where the manifest lives: per-PR results name consumer PRs and stay in
// --out, outside this repository. Only the printed aggregate goes into
// docs/decisions.md. Each case is triaged at its `head` against its `base`
// (git diff --no-renames); the title and description come from `gh api`.
//
// Manifest: {"repository": "owner/name", "cases": [{"pr": 12, "head": "<sha>",
// "base": "<sha>", "label": "...", "expect": "high"|"normal"|"docs"|null,
// "required": true|false, "sample": true|false}]}. `required` cases must end
// high; `sample` marks a random draw that measures the high share.
// --base-url and --api-key-env default to OPEN_REVIEW_PROVIDER_BASE_URL and
// OPEN_REVIEW_PROVIDER_ENV_KEY, as in engine/run-local.sh.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseDiff } = require("../engine/focused-workers.cjs");
const { promptIdentity, triageInput, triage, finalRisk } = require("../engine/risk-triage.cjs");

// GPT-6.1 Sol list price in credits per million tokens.
const RATES = { input: 50, cached: 2.5, output: 250 };
const DEFAULT_DOCS = "**/*.md **/*.mdx docs/**";

function options(argv) {
  const out = { baseUrl: process.env.OPEN_REVIEW_PROVIDER_BASE_URL || "", apiKeyEnv: process.env.OPEN_REVIEW_PROVIDER_ENV_KEY || "",
    concurrency: 4, docs: DEFAULT_DOCS, only: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--manifest") out.manifest = value;
    else if (flag === "--repo") out.repo = value;
    else if (flag === "--out") out.out = value;
    else if (flag === "--base-url") out.baseUrl = value;
    else if (flag === "--api-key-env") out.apiKeyEnv = value;
    else if (flag === "--concurrency") out.concurrency = Number(value);
    else if (flag === "--docs-only-paths") out.docs = value;
    else if (flag === "--case") out.only = Number(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!out.manifest || !out.repo || !out.out || !out.baseUrl) throw new Error("--manifest, --repo, --out and --base-url are required");
  return out;
}

function glob(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function credits(usage) {
  if (!usage) return 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return ((usage.input_tokens - cached) * RATES.input + cached * RATES.cached + usage.output_tokens * RATES.output) / 1e6;
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function runCase(entry, repository, opts, docsPatterns) {
  const cache = path.join(opts.out, `pr-${entry.pr}.json`);
  if (!fs.existsSync(cache)) {
    const meta = execFileSync("gh", ["api", `repos/${repository}/pulls/${entry.pr}`, "--jq", "{title, body}"], { encoding: "utf8" });
    fs.writeFileSync(cache, meta);
  }
  const { title, body } = JSON.parse(fs.readFileSync(cache, "utf8"));
  const patch = execFileSync("git", ["-C", opts.repo, "-c", "core.quotePath=false", "diff", "--no-renames", "--no-color", "--no-ext-diff", entry.base, entry.head],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const paths = parseDiff(patch).map((file) => file.file);
  const docsOnly = paths.length > 0 && paths.every((file) => docsPatterns.some((pattern) => pattern.test(file)));
  const input = triageInput({ title, body, patch });
  const apiKey = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] ?? "" : "";
  const outcome = await triage({ baseUrl: opts.baseUrl, apiKey, input });
  const final = finalRisk({ result: outcome.result, paths, docsOnly });
  return {
    pr: entry.pr, label: entry.label, expect: entry.expect ?? null, required: Boolean(entry.required), sample: Boolean(entry.sample),
    floor: final.floor, model: final.model, final: final.risk, docsOnly, files: paths.length,
    confidence: outcome.result?.confidence ?? null, reasons: outcome.result?.reasons ?? [],
    error: outcome.error ?? null, detail: outcome.detail ?? null, usage: outcome.usage, credits: credits(outcome.usage),
    ms: outcome.ms, inputChars: input.length,
  };
}

function report(rows, identity) {
  const pct = (part, whole) => whole ? `${part}/${whole} (${Math.round((100 * part) / whole)}%)` : "0/0";
  const isHigh = (key) => (row) => row[key] === "high";
  const lines = [`prompt ${identity.version} sha ${identity.sha256}, ${identity.model} ${identity.effort}; ${rows.length} cases`];
  const required = rows.filter((row) => row.required);
  for (const key of ["final", "floor", "model"]) {
    lines.push(`required high recall (${key}): ${pct(required.filter(isHigh(key)).length, required.length)}`);
  }
  lines.push(`required misses (final): ${required.filter((row) => row.final !== "high").map((row) => row.pr).join(", ") || "none"}`);
  lines.push(`required, floor not high, model not high: ${required.filter((row) => row.floor !== "high" && row.model !== "high").map((row) => row.pr).join(", ") || "none"}`);
  for (const label of [...new Set(rows.map((row) => row.label))].sort()) {
    const group = rows.filter((row) => row.label === label);
    const tally = (key) => ["high", "normal", "docs"].map((tier) => `${tier} ${group.filter((row) => row[key] === tier).length}`).join(", ");
    lines.push(`${label} (${group.length}): final ${tally("final")} | model ${tally("model")}`);
  }
  const sample = rows.filter((row) => row.sample);
  for (const key of ["final", "floor", "model"]) lines.push(`sample high share (${key}): ${pct(sample.filter(isHigh(key)).length, sample.length)}`);
  const errors = rows.filter((row) => row.error);
  lines.push(`errors: ${errors.length} (${[...new Set(errors.map((row) => row.error))].join(", ") || "none"})`);
  const ok = rows.filter((row) => row.usage);
  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const tokens = (pick) => Math.round(sum(ok.map(pick)) / Math.max(ok.length, 1));
  lines.push(`tokens per call (mean): input ${tokens((row) => row.usage.input_tokens)}, cached ${tokens((row) => row.usage.input_tokens_details?.cached_tokens ?? 0)}, output ${tokens((row) => row.usage.output_tokens)} (reasoning ${tokens((row) => row.usage.output_tokens_details?.reasoning_tokens ?? 0)})`);
  const cost = ok.map((row) => row.credits);
  const meanCost = sum(cost) / Math.max(cost.length, 1);
  const floorShare = sample.filter(isHigh("floor")).length / Math.max(sample.length, 1);
  lines.push(`credits per call: mean ${meanCost.toFixed(3)}, p50 ${quantile(cost, 0.5)?.toFixed(3)}, p90 ${quantile(cost, 0.9)?.toFixed(3)}; per PR when the call is skipped on a high floor: ${(meanCost * (1 - floorShare)).toFixed(3)}`);
  const ms = rows.map((row) => row.ms);
  lines.push(`latency s: p50 ${(quantile(ms, 0.5) / 1000).toFixed(1)}, p90 ${(quantile(ms, 0.9) / 1000).toFixed(1)}, max ${(Math.max(...ms) / 1000).toFixed(1)}`);
  return lines.join("\n");
}

async function main() {
  const opts = options(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(opts.manifest, "utf8"));
  if (!/^[\w.-]+\/[\w.-]+$/.test(manifest.repository || "")) throw new Error("manifest.repository must be owner/name");
  fs.mkdirSync(opts.out, { recursive: true });
  const docsPatterns = opts.docs.split(/[\s,]+/).filter(Boolean).map(glob);
  const cases = manifest.cases.filter((entry) => opts.only === null || entry.pr === opts.only);
  const identity = promptIdentity();
  const results = path.join(opts.out, "results.jsonl");
  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const entry = cases[next++];
      let row;
      try {
        row = await runCase(entry, manifest.repository, opts, docsPatterns);
      } catch (error) {
        // A case we could not even build is a harness failure, not a triage result.
        process.stderr.write(`case ${entry.pr}: ${error.message.split("\n")[0]}\n`);
        continue;
      }
      rows.push(row);
      fs.appendFileSync(results, `${JSON.stringify({ ...row, prompt: identity })}\n`);
      process.stderr.write(`${rows.length}/${cases.length} ${row.pr} floor=${row.floor} model=${row.model} final=${row.final}${row.error ? ` error=${row.error}` : ""}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  if (rows.length < cases.length) process.exitCode = 1;
  const text = report(rows, identity);
  fs.writeFileSync(path.join(opts.out, "report.txt"), `${text}\n`);
  process.stdout.write(`${text}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
module.exports = { credits, report };
