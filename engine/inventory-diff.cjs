#!/usr/bin/env node
"use strict";
// Deterministic coverage inventory of a unified diff.
//
// Lists, per changed file, the added lines that carry constructs a reviewer
// must trace rather than pattern-match: process exit and shutdown paths,
// promise chains without a rejection handler, error handling, and
// conditionals that combine several status sources. The reviewer covers every
// item before free investigation; the parent uses the categories to decide
// which child investigation to spawn. Findings still have to pass the bar.
//
// usage: inventory-diff.cjs <pr-diff.patch>   (writes markdown to stdout)
const fs = require("node:fs");

const KEYWORDS = new Set(["if","else","return","const","let","var","function","true","false","null","undefined","new","typeof","instanceof","in","of","await","async","void","this","export","import","default","case","switch","while","for","do","break","continue","throw","try","catch","finally","class","extends","yield","delete"]);

const CATEGORIES = [
  {
    id: "contract",
    title: "Exported or shared contracts changed on this line (functions, hooks, types, unions, constants)",
    // Exported declarations, re-exports, and union continuation members added to an
    // existing multi-line union (`| "value"`, `| { readonly kind: "x" }`).
    test: (line) => /^\s*export\s+(default\s+)?(async\s+)?(function|const|let|class|type|interface|enum)\b/.test(line) || /^\s*export\s*\{/.test(line) || /^\s*\|\s*(["'][^"']+["']|\{\s*(readonly\s+)?(kind|status|type|state)\s*:\s*["'])/.test(line),
  },
  {
    id: "provider_read",
    title: "New context or provider-backed reads inside hooks and components (a contract change for every caller and test that renders them)",
    test: (line) => /\buse[A-Z]\w*Context\s*\(|\buseContext\s*\(|\b(React\.)?use\s*\(\s*[\w.]*Context\b|\buse[A-Z]\w*(Recorder|Provider|Client|Store)s?\s*\(\s*\)/.test(line),
  },
  {
    id: "exit_path",
    title: "Process exit, shutdown, and signal paths",
    test: (line) => /\bprocess\.(exit|kill|on|once)\b|\bSIG(TERM|INT|HUP|KILL)\b|\b(shutdown|dispose|teardown)\s*\(|\.(stop|close|abort)\(\)/.test(line),
  },
  {
    id: "floating_promise",
    title: "Promise chains without a rejection handler on the changed line",
    test: (line) => /\bvoid\s+[\w.]+\(|\.then\(/.test(line) && !/\.catch\(|\bawait\b|\btry\b/.test(line),
  },
  {
    id: "error_handling",
    title: "Catch blocks, rethrows, typed failure returns",
    test: (line) => /\bcatch\b|\bthrow\b|\.catch\(|\bunhandledRejection\b|\buncaughtException\b|kind:\s*["'](failed|error)/.test(line),
  },
  {
    id: "status_conditional",
    title: "Guards that combine two or more state sources",
    test: (line) => {
      const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
      const guard = /\bif\s*\(|\?[^.?]|&&|\|\|/.test(code);
      if (!guard) return false;
      const stateWords = new Set((code.match(/\b\w*(state|status|ready|pending|required|reconnect|reconcil|loading|cached|stale|active|value|error|failed)\w*\b/gi) ?? []).map((w) => w.toLowerCase()));
      if (stateWords.size >= 2) return true;
      // Two or more distinct sources joined by a boolean operator is a precedence decision even without state vocabulary.
      const joined = /&&|\|\|/.test(code);
      const identifiers = new Set((code.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).filter((w) => !KEYWORDS.has(w)));
      return joined && identifiers.size >= 3;
    },
  },
];

// Git quotes unusual paths as "b/\303\251.ts" (C-style escapes, octal bytes).
function unquoteGitPath(value) {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  const bytes = [];
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") { bytes.push(...Buffer.from(ch, "utf8")); continue; }
    const next = body[i + 1];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; continue; }
    const simple = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 }[next];
    bytes.push(simple ?? next.charCodeAt(0)); i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function parseAddedLines(patch) {
  const files = [];
  let current = null;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = { path: "", added: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+++ ")) {
      current.path = unquoteGitPath(raw.slice(4).trim()).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (raw.startsWith("+")) { current.added.push({ line: newLine, text: raw.slice(1) }); newLine += 1; continue; }
    if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    newLine += 1;
  }
  return files.filter((file) => file.path && file.path !== "/dev/null");
}

const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec|vitest-ui|stories)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;

const MAX_STATEMENT_LINES = 6;

// Join consecutive added lines into one logical statement while parentheses
// are open or a line ends or starts with a boolean/ternary operator, so a guard
// formatted across lines is classified as a whole. Attributed to its first line.
function statements(added) {
  const out = [];
  let current = null;
  // Parentheses and brackets keep a statement open; braces open blocks, which are not statements.
  const opens = (text) => (text.match(/[([]/g) ?? []).length - (text.match(/[)\]]/g) ?? []).length;
  const continues = (prev, next) => /(&&|\|\||\?|:|\(|,)\s*$/.test(prev) || /^\s*(&&|\|\||\?|:)/.test(next);
  for (const entry of added) {
    const trimmed = entry.text.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) { if (current) { out.push(current); current = null; } continue; }
    if (current && current.lines < MAX_STATEMENT_LINES && entry.line === current.last + 1 && (current.depth > 0 || continues(current.text, trimmed))) {
      current.text += " " + trimmed; current.depth += opens(trimmed); current.last = entry.line; current.lines += 1;
      continue;
    }
    if (current) out.push(current);
    current = { line: entry.line, last: entry.line, text: trimmed, depth: opens(trimmed), lines: 1 };
  }
  if (current) out.push(current);
  return out;
}

function inventory(patch) {
  const items = [];
  for (const file of parseAddedLines(patch)) {
    // Test files are proof, not the place a defect hides; keep the inventory
    // pointed at production paths.
    if (TEST_PATH.test(file.path)) continue;
    for (const statement of statements(file.added)) {
      for (const category of CATEGORIES) {
        if (category.test(statement.text)) items.push({ category: category.id, path: file.path, line: statement.line, text: statement.text.slice(0, 160) });
      }
    }
  }
  return items;
}

function render(items) {
  const out = ["# Coverage inventory (generated from the scoped diff)", ""];
  if (items.length === 0) {
    out.push("No inventory items: the diff adds no contract lines, exit paths, floating promises, error handling, or multi-source conditionals.");
    return out.join("\n") + "\n";
  }
  for (const category of CATEGORIES) {
    const rows = items.filter((item) => item.category === category.id);
    if (rows.length === 0) continue;
    out.push(`## ${category.id}: ${category.title} (${rows.length})`, "");
    for (const row of rows) out.push(`- \`${row.path}:${row.line}\` \`${row.text.replace(/`/g, "'")}\``);
    out.push("");
  }
  const counts = CATEGORIES.map((category) => `${category.id}=${items.filter((item) => item.category === category.id).length}`).join(" ");
  out.push(`Summary: ${counts}`);
  return out.join("\n") + "\n";
}

module.exports = { inventory, parseAddedLines, render, statements, unquoteGitPath, CATEGORIES };

if (require.main === module) {
  const [patchPath] = process.argv.slice(2);
  if (!patchPath) { console.error("usage: inventory-diff.cjs <pr-diff.patch>"); process.exit(2); }
  process.stdout.write(render(inventory(fs.readFileSync(patchPath, "utf8"))));
}
