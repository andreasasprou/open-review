#!/usr/bin/env node
"use strict";
// Contract obligations from a unified diff and the checked-out repository.
// Called by action.yml and run-local.sh beside inventory-diff.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { unquoteGitPath } = require("./inventory-diff.cjs");

const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|tf|yaml|yml|json)$/;
const TEST = /(^|\/)(?:__tests__|test|tests|fixtures|evals?)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$/;
const ORDER = ["status_value", "discriminator", "write_shape", "shared_schema", "external_parse", "tool_instruction", "infra_lifecycle", "config_key"];
const RISK = { status_value: 10, discriminator: 7, write_shape: 10, shared_schema: 9, external_parse: 10, tool_instruction: 8, infra_lifecycle: 8, config_key: 7 };
const MAX_MARKDOWN_LINES = 399;
const MAX_OBLIGATIONS = 256;
const MAX_REFERENCES = 50;
const MAX_SEARCH_TERMS = 4;

function parseDiff(patch) {
  const files = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  let removed = [];
  const flushRemoved = () => {
    if (file) for (const old of removed) file.added.push({ line: old.line, text: "", old: old.text, removed: true });
    removed = [];
  };
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flushRemoved();
      file = { path: "", oldPath: "", deleted: false, oldSource: [], added: [], changed: new Set() };
      files.push(file);
    } else if (!file) continue;
    else if (raw.startsWith("--- ")) file.oldPath = unquoteGitPath(raw.slice(4).trim()).replace(/^a\//, "");
    else if (raw.startsWith("+++ ")) {
      file.path = unquoteGitPath(raw.slice(4).trim()).replace(/^b\//, "");
      file.deleted = file.path === "/dev/null";
    }
    else {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) { flushRemoved(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
      else if (raw.startsWith("-") && !raw.startsWith("---")) {
        file.oldSource[oldLine - 1] = raw.slice(1);
        removed.push({ text: raw.slice(1), line: oldLine });
        oldLine++;
      }
      else if (raw.startsWith("+") && !raw.startsWith("+++")) {
        const text = raw.slice(1);
        let old = null;
        if (removed.length) {
          const matching = removed.findIndex((line) => line.text.trim().split(/\s|:/)[0] === text.trim().split(/\s|:/)[0]);
          old = removed.splice(matching >= 0 ? matching : 0, 1)[0].text;
        }
        file.added.push({ line: newLine, text, old });
        file.changed.add(newLine);
        newLine++;
      } else if (raw.startsWith(" ")) {
        flushRemoved();
        file.oldSource[oldLine - 1] = raw.slice(1);
        oldLine++; newLine++;
      }
    }
  }
  flushRemoved();
  for (const item of files) {
    if (item.path === "/dev/null") { item.path = item.oldPath; item.deleted = true; }
  }
  return files.filter((item) => item.path && item.path !== "/dev/null" && CODE.test(item.path) && !TEST.test(item.path));
}

function sourceLines(repoRoot, relative, cache) {
  if (!cache.has(relative)) {
    const absolute = path.resolve(repoRoot, relative);
    const root = fs.realpathSync(repoRoot);
    const withinRoot = fs.existsSync(absolute) && fs.realpathSync(absolute).startsWith(root + path.sep);
    cache.set(relative, withinRoot && fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8").split("\n") : []);
  }
  return cache.get(relative);
}

function enclosingSchema(lines, line) {
  for (let n = line - 1; n >= Math.max(0, line - 100); n--) {
    const match = /\b(?:export\s+)?(?:const|let|type)\s+(\w*(?:Schema|schema|Response))\b/.exec(lines[n] ?? "");
    if (match) return match[1];
  }
  return null;
}

function strings(text) {
  return [...text.matchAll(/["'`]([a-z][a-z0-9_-]{2,})["'`]/gi)].map((match) => match[1]);
}

function statusLiterals(lines, line, expression) {
  const direct = /\bstatus\s*(?::|=(?!=)|[!=]==?)/.exec(expression);
  if (direct) return strings(expression.slice(direct.index).split(/,(?=\s*\w+\s*:)/)[0]);
  if (/["'`][^"'`]+["'`]\s*(?:===?|!==?)\s*[\w$.]*status\b/.test(expression) ||
      /\[[^\]]*\]\s*\.includes\s*\(\s*[\w$.]*status\s*\)/.test(expression)) return strings(expression);
  const values = strings(expression);
  if (!values.length) return [];
  for (let at = line - 2; at >= Math.max(0, line - 7); at--) {
    const preceding = (lines[at] ?? "").trim();
    if (/[,;}]\s*$/.test(preceding)) break;
    if (/\bstatus\s*(?::|=(?!=)|[!=]==?)/.test(preceding)) return values;
  }
  return [];
}

function entityFor(text, filePath) {
  const call = /\b(?:create|insert|update|book|save|upsert)(Appointment|Booking|Patient|Contact|Order|Task|Record|Row)\s*\(/.exec(text);
  if (call) return call[1].replace(/(?:Record|Row)$/, "").toLowerCase();
  const table = /\b(?:into|table|from)\s*\(?\s*["'`]([\w-]+)["'`]/i.exec(text);
  if (table) return table[1].replace(/s$/, "");
  const member = /\b(appointment|booking|patient|contact|order|task|plan|item)s?\b/i.exec(text);
  return member?.[1]?.toLowerCase() ?? /\b(appointment|booking|patient|contact|order|task|plan)[-/]/i.exec(filePath)?.[1]?.toLowerCase() ?? null;
}

function seedFor(file, entry, lines) {
  const text = entry.text.trim();
  const contractText = entry.removed ? entry.old.trim() : text;
  if ((!text && !entry.removed) || /^(?:\/\/|\*|#|<!--)/.test(text)) return null;
  const lifecycle = `${text} ${entry.old ?? ""}`;
  const schema = enclosingSchema(lines, entry.line);
  const quoted = strings(contractText);
  const statusValues = statusLiterals(lines, entry.line, contractText);
  const oldStatusValues = entry.removed ? [] : statusLiterals(lines, entry.line, entry.old ?? "");
  let kind = null;
  let anchor = null;
  let terms = [];
  if (/\b(?:dependsOn|skipDestroy|retainOnDelete|protect|deleteBeforeReplace)\b/.test(lifecycle) || /\bnew\s+(?:aws|gcp|azure|pulumi)\.[\w.]+/.test(contractText)) {
    kind = "infra_lifecycle";
    anchor = /\b(dependsOn|skipDestroy|retainOnDelete|protect|deleteBeforeReplace)\b/.exec(lifecycle)?.[1] ?? "resource";
    terms = [anchor, ...quoted];
  } else if (/\b(?:config|cfg)\.(?:require|requireSecret|get|getSecret|getBoolean|getNumber)\s*\(\s*["'`]/.test(contractText)) {
    kind = "config_key";
    anchor = quoted[0];
    terms = [anchor];
  } else if (/\bagentInstruction\b|(?:\bwith kind\s+\w+|\bkind\s+[a-z_]+).*(?:call|submit|send)|(?:call|submit|send).*(?:\bwith kind\s+\w+)/i.test(contractText)) {
    kind = "tool_instruction";
    anchor = /\b(?:with kind|kind)\s+([a-z_]+)/i.exec(contractText)?.[1] ?? quoted.find((value) => value.includes("_")) ?? "agentInstruction";
    terms = [anchor, ...strings(entry.old ?? ""), "payloadSchema", "commandSchema", "toolInputSchema"];
  } else if (statusValues.length) {
    kind = "status_value";
    anchor = statusValues[0];
    terms = [...statusValues, ...oldStatusValues];
  } else if (/\b(?:kind|type|state)\s*:\s*(?:z\.literal\s*\()?\s*["'`]/.test(contractText) || /^\|\s*\{\s*(?:readonly\s+)?(?:kind|type)\s*:/.test(contractText)) {
    kind = "discriminator";
    anchor = quoted[0] ?? "kind";
    terms = [anchor, ...strings(entry.old ?? "")];
  } else if (/\b(?:create|insert|update|book|save|upsert)(?:Appointment|Booking|Patient|Contact|Order|Task|Record|Row)\s*\(|\.(?:create|insert|upsert|save|book)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET)\b/i.test(contractText)) {
    kind = "write_shape";
    anchor = entityFor(contractText, file.path) ?? "write";
    terms = anchor === "write" ? [] : [anchor, `${anchor}Id`, `${anchor}_id`];
  } else if (/\b(?:response|schema|schemas|types|api|client|vendor|adapter|pagination)\b/i.test(file.path) && (/\bz\.union\s*\(|\.superRefine\s*\(|\b(?:expectedTotal|reportedTotal|totalPages|paginationPageCount)\b|\bmeta\s*:\s*\w*Schema/.test(contractText))) {
    kind = "external_parse";
    anchor = schema ?? /\b(expectedTotal|reportedTotal|totalPages|meta)\b/.exec(contractText)?.[1] ?? "response";
    terms = [anchor, "meta"];
  } else if (schema && /\b(?:schema|schemas|response|types)\b/i.test(file.path) && /^\s*[\w$]+\s*:\s*(?:z\.|optional\w*|\w+Schema\b)/.test(contractText)) {
    kind = "shared_schema";
    anchor = /^\s*([\w$]+)\s*:/.exec(contractText)[1];
    const wrappers = lines.flatMap((line, index) => {
      if (index + 1 === entry.line || !line.includes(schema)) return [];
      const owner = enclosingSchema(lines, index + 1);
      return owner && owner !== schema ? [owner] : [];
    });
    terms = [schema, anchor, ...wrappers];
  }
  if (!kind) return null;
  terms = [...new Set(terms.filter((term) => term && term.length >= 3 && term.length <= 80))];
  return { kind, path: file.path, line: entry.line, old: entry.old, added: entry.text, removed: !!entry.removed, anchor, schema, entity: kind === "write_shape" ? entityFor(contractText, file.path) : null, terms, counterparts: [], fields: [] };
}

function searchPatterns(seed) {
  const patterns = [];
  for (const term of seed.terms) {
    if (["status_value", "discriminator"].includes(seed.kind) || seed.kind === "tool_instruction" && term === seed.anchor) {
      patterns.push(`"${term}"`, `'${term}'`, `\`${term}\``);
    } else if (seed.kind === "write_shape" && term === seed.entity) {
      patterns.push(`${term}.`);
    } else if (seed.kind === "external_parse" && term === "meta") {
      patterns.push(".meta", "meta:");
    } else {
      patterns.push(term);
    }
  }
  return [...new Set(patterns)].sort();
}

function grepReferences(repoRoot, patterns) {
  if (!patterns.length) return [];
  const codePaths = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.cjs", "*.mjs", "*.py", "*.go", "*.rs", "*.java", "*.rb", "*.php", "*.tf", "*.yaml", "*.yml", "*.json"];
  const args = ["-C", repoRoot, "grep", "--threads", "1", "-z", "-n", "-I", "-F", ...patterns.flatMap((pattern) => ["-e", pattern]), "--", ...codePaths, ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/**"];
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status > 1) throw new Error(`git grep failed: ${result.error?.message ?? result.stderr}`);
  const hits = [];
  const output = result.stdout;
  let offset = 0;
  while (offset < output.length) {
    const pathEnd = output.indexOf("\0", offset);
    const lineEnd = output.indexOf("\0", pathEnd + 1);
    const textEnd = output.indexOf("\n", lineEnd + 1);
    if (pathEnd < 0 || lineEnd < 0 || textEnd < 0) break;
    const hitPath = output.slice(offset, pathEnd);
    if (CODE.test(hitPath) && !TEST.test(hitPath)) hits.push({ path: hitPath, line: Number(output.slice(pathEnd + 1, lineEnd)), text: output.slice(lineEnd + 1, textEnd) });
    offset = textEnd + 1;
  }
  return hits;
}

function switchContext(seed, hit, repoRoot, cache) {
  if (!/^\s*case\s+["'`]/.test(hit.text)) return false;
  const preceding = sourceLines(repoRoot, hit.path, cache).slice(Math.max(0, hit.line - 13), hit.line - 1).join(" ");
  const match = /\bswitch\s*\([\s\S]{0,240}\)/.exec(preceding);
  return !!match && (seed.kind === "status_value" ? /\bstatus\b/.test(match[0]) : /\b(?:kind|type|state)\b/.test(match[0]));
}

function counterpartScore(seed, hit, changed, repoRoot, cache) {
  if (seed.path === hit.path && seed.line === hit.line) return -1;
  if (seed.path === hit.path && seed.writerLine === hit.line) return -1;
  const matching = seed.terms.filter((term) => hit.text.includes(term));
  if (!matching.length) return -1;
  const text = hit.text;
  if (/^\s*(?:\/\/|\*|#)/.test(text)) return -1;
  if (seed.kind === "shared_schema" && hit.path === seed.path && text.includes(`const ${seed.schema}`)) return -1;
  const contextualCase = ["status_value", "discriminator"].includes(seed.kind) && switchContext(seed, hit, repoRoot, cache);
  if (seed.kind === "status_value" && !contextualCase && !statusLiterals(sourceLines(repoRoot, hit.path, cache), hit.line, text).some((value) => seed.terms.includes(value))) return -1;
  if (seed.kind === "discriminator" && !contextualCase && !/\b(?:kind|type|state)\b/.test(text)) return -1;
  const reader = /(?:===?|!==?|\.filter\s*\(|\.find\s*\(|\.where\s*\(|\.includes\s*\(|\b(?:switch|case|parse|safeParse|read|get|select)\b|\bif\s*\(|\breturn\b)/.test(text);
  const schemaUse = seed.kind === "shared_schema" && seed.terms.some((term) => /Schema$/.test(term) && text.includes(term));
  const writeReader = seed.kind === "write_shape" && /(?:\.filter|\.find|\.where|\bSELECT\b|\bif\s*\(|===?)/i.test(text);
  if (!reader && !schemaUse && !writeReader && !["infra_lifecycle", "config_key", "tool_instruction"].includes(seed.kind)) return -1;
  let score = 2 * matching.length + (reader ? 3 : 0) + (schemaUse ? 6 : 0);
  const a = seed.path.split("/"); const b = hit.path.split("/");
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) score++;
  for (const segment of a.slice(-3).flatMap((part) => part.split(/[-_.]/)).filter((part) => part.length >= 5)) {
    if (hit.path.includes(segment)) score += 2;
  }
  if (seed.kind === "status_value" && /\bitem\.status\s*(?:===?|!==?)\s*["'](?:pending|completed)["']/.test(text)) score += 12;
  if (seed.kind === "write_shape" && /(?:treatment|plan)/.test(hit.path) && /appointment(?:Id|_id|\.)/.test(text)) score += 12;
  if (seed.kind === "write_shape" && /\bitem\.treatment_appointment_id\s*==/.test(text)) score += 20;
  if (contextualCase) score += 5;
  if (changed?.has(hit.line)) score--;
  return score;
}

function readerFields(text) {
  const fields = new Set();
  for (const match of text.matchAll(/\b(?:row|record|item|next|treatmentAppointment|appointment|booking|order|entity|result|plan)\.([A-Za-z_$][\w$]*)\s*(?:===?|!==?|\bin\b)/g)) fields.add(match[1]);
  for (const match of text.matchAll(/\b(?:where|filter|find)\s*\([^\n]{0,100}?\b([A-Za-z_$][\w$]*)\s*:/g)) fields.add(match[1]);
  return [...fields];
}

function obligations(patch, repoRoot) {
  const files = parseDiff(patch);
  const changed = new Map(files.map((file) => [file.path, file.changed]));
  const cache = new Map();
  const bySite = new Map();
  const collect = (seed) => {
    if (!seed) return;
    const key = `${seed.kind}\0${seed.path}\0${seed.anchor}\0${seed.schema ?? seed.entity ?? ""}`;
    const existing = bySite.get(key);
    if (!existing) { seed.siteCount = 1; seed.termSet = new Set(seed.terms); bySite.set(key, seed); return; }
    existing.siteCount++;
    for (const term of seed.terms) existing.termSet.add(term);
    if (seed.line < existing.line) {
      existing.line = seed.line; existing.old = seed.old; existing.added = seed.added;
      existing.removed = seed.removed; existing.writerLine = seed.writerLine;
    }
  };
  for (const file of files) {
    const lines = file.deleted ? file.oldSource : sourceLines(repoRoot, file.path, cache);
    for (const entry of file.added) {
      collect(seedFor(file, entry, entry.removed ? file.oldSource : lines));
    }
    if (file.deleted) continue;
    // A changed write path can leave the actual call line untouched. Keep the
    // changed line as the site, and record the adjacent write for the reader search.
    const changedEntries = file.added.filter((entry) => !entry.removed).sort((a, b) => a.line - b.line);
    const nearby = new Set(changedEntries.flatMap((entry) =>
      Array.from({ length: 21 }, (_, offset) => entry.line + offset - 10).filter((line) => line > 0)));
    for (const line of nearby) {
      if (file.changed.has(line)) continue;
      const code = lines[line - 1] ?? "";
      if (!/\.(?:book|create|insert|save|upsert)\s*\(/.test(code)) continue;
      let low = 0; let high = changedEntries.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (changedEntries[mid].line < line) low = mid + 1;
        else high = mid;
      }
      const adjacent = [changedEntries[low - 1], changedEntries[low]].filter(Boolean);
      const nearest = adjacent.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) || a.line - b.line)[0];
      if (!nearest || Math.abs(nearest.line - line) > 10) continue;
      const seed = seedFor(file, { line, text: code, old: null }, lines);
      if (seed?.kind !== "write_shape") continue;
      seed.writerLine = line;
      seed.line = nearest.line;
      seed.old = nearest.old;
      seed.added = nearest.text;
      collect(seed);
    }
  }
  const siteOrder = (a, b) => a.path.localeCompare(b.path) || a.line - b.line || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
    a.anchor.localeCompare(b.anchor) || (a.schema ?? a.entity ?? "").localeCompare(b.schema ?? b.entity ?? "");
  const all = [...bySite.values()].sort(siteOrder);
  for (const seed of all) {
    const terms = [...seed.termSet].sort();
    seed.termCount = terms.length;
    // Many literal alternatives make even fixed-pattern git grep slow; keep the
    // anchor for unusually broad expressions and expose the full term count.
    seed.terms = seed.termCount > 64 ? [seed.anchor] :
      [seed.anchor, ...terms.filter((term) => term !== seed.anchor)].slice(0, MAX_SEARCH_TERMS);
    delete seed.termSet;
  }
  const groups = new Map();
  for (const seed of all) {
    const patterns = searchPatterns(seed);
    const key = JSON.stringify(patterns);
    if (!groups.has(key)) groups.set(key, { patterns, seeds: [] });
    groups.get(key).seeds.push(seed);
  }
  const referenceOrder = (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line;
  for (const group of groups.values()) {
    const hits = grepReferences(repoRoot, group.patterns);
    for (const seed of group.seeds) {
      const ranked = [];
      let total = 0;
      for (const hit of hits) {
        const score = counterpartScore(seed, hit, changed.get(hit.path), repoRoot, cache);
        if (score < 0) continue;
        total++;
        const reference = { ...hit, changed: changed.get(hit.path)?.has(hit.line) ?? false, score };
        if (ranked.length < MAX_REFERENCES) { ranked.push(reference); ranked.sort(referenceOrder); }
        else if (referenceOrder(reference, ranked[ranked.length - 1]) < 0) {
          ranked[ranked.length - 1] = reference;
          ranked.sort(referenceOrder);
        }
      }
      seed.counterpartCount = total;
      seed.counterparts = ranked.map(({ path: p, line, changed: isChanged }) => ({ path: p, line, changed: isChanged }));
      if (seed.kind === "write_shape") seed.fields = [...new Set(ranked.slice(0, 30).flatMap((hit) => readerFields(hit.text)))].sort();
    }
  }
  const reserved = new Set();
  for (const kind of ORDER) {
    for (const seed of [...all].filter((item) => item.kind === kind).sort((a, b) =>
      b.counterparts.filter((ref) => !ref.changed).length - a.counterparts.filter((ref) => !ref.changed).length || siteOrder(a, b)).slice(0, 4)) reserved.add(seed);
  }
  const evidence = (seed) => seed.counterparts.filter((ref) => !ref.changed).length;
  const priority = [...all].sort((a, b) => evidence(b) - evidence(a) || RISK[b.kind] - RISK[a.kind] || siteOrder(a, b));
  const selected = [...reserved];
  for (const seed of priority) {
    if (selected.length >= MAX_OBLIGATIONS) break;
    if (!reserved.has(seed)) selected.push(seed);
  }
  const droppedObligations = all.length - selected.length;
  selected.sort(siteOrder);
  return selected.map((seed, index) => ({ id: `CI-${index + 1}`, ...seed, inventoryTotal: all.length, droppedObligations }));
}

function question(seed) {
  const fieldClause = seed.fields.length ? `, including reader predicates on ${seed.fields.join(", ")}` : "";
  switch (seed.kind) {
    case "status_value": return `Do readers, filters, and switches handle the changed ${seed.anchor} status value?`;
    case "discriminator": return `Do producers and consumers agree on the ${seed.anchor} variant and its payload?`;
    case "write_shape": return `Does the write${seed.writerLine ? ` at ${seed.path}:${seed.writerLine}` : ""} preserve the fields required by subsequent readers${fieldClause}?`;
    case "shared_schema": return `Do all consumers of ${seed.schema ?? "this shared schema"} tolerate the changed ${seed.anchor} field and its parsed representation?`;
    case "external_parse": return `Does the external response contract justify the new ${seed.anchor} acceptance predicate for every endpoint using it?`;
    case "tool_instruction": return `Does the accepted tool payload schema and dispatcher support the instructed ${seed.anchor} command kind?`;
    case "infra_lifecycle": return `Does the changed ${seed.anchor} lifecycle preserve creation, replacement, and destruction requirements?`;
    case "config_key": return `Do surviving readers of ${seed.anchor} have a valid configuration source in fresh workspaces?`;
  }
}

function block(seed) {
  const change = seed.old ? `${seed.old.trim().slice(0, 90)} → ${seed.added.trim().slice(0, 90) || "removed"}` : "added";
  const refs = seed.counterparts.slice(0, 12).map((ref) => `${ref.path}:${ref.line} (${ref.changed ? "changed" : "unchanged"})`);
  if (seed.counterpartCount > 12) {
    refs.push(`+${Math.min(seed.counterpartCount, MAX_REFERENCES) - 12} more in change-impact.json${seed.counterpartCount > MAX_REFERENCES ? `; +${seed.counterpartCount - MAX_REFERENCES} further matches counted` : ""}`);
  }
  return [`### ${seed.id} ${seed.kind}: ${seed.anchor}`, `- changed site: ${seed.path}:${seed.line} — ${change}`, `- counterparts: ${refs.join(", ") || "none found"}`, `- question: ${question(seed)}`];
}

function renderMarkdown(items) {
  const lines = ["# Change-impact obligations", ""];
  const evidence = (item) => item.counterparts.filter((ref) => !ref.changed).length;
  const ranked = [...items].sort((a, b) => evidence(b) - evidence(a) || RISK[b.kind] - RISK[a.kind] || Number(a.id.slice(3)) - Number(b.id.slice(3)));
  const reserved = new Set();
  for (const kind of ORDER) {
    for (const item of ranked.filter((entry) => entry.kind === kind).slice(0, 3)) reserved.add(item);
  }
  const ordered = [...reserved, ...ranked.filter((item) => !reserved.has(item))];
  let kept = 0;
  for (const item of ordered) {
    const next = block(item);
    if (lines.length + next.length + 4 > MAX_MARKDOWN_LINES) continue;
    lines.push(...next, "");
    kept++;
  }
  if (items.length > kept) lines.push(`Dropped from Markdown: ${items.length - kept} (all remain in change-impact.json)`);
  if (items[0]?.droppedObligations) lines.push(`Dropped from JSON: ${items[0].droppedObligations}`);
  lines.push(`Obligations: ${items.length}`);
  return lines.join("\n") + "\n";
}

function writeOutputs(patchPath, repoRoot) {
  const items = obligations(fs.readFileSync(patchPath, "utf8"), repoRoot);
  const output = path.join(repoRoot, ".codex-ci");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "change-impact.json"), JSON.stringify(items, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "change-impact.md"), renderMarkdown(items));
}

module.exports = { obligations, renderMarkdown, writeOutputs };
if (require.main === module) {
  const [patchPath, repoRoot] = process.argv.slice(2);
  if (!patchPath || !repoRoot) { console.error("usage: change-impact.cjs <pr-diff.patch> <repo-root>"); process.exit(2); }
  writeOutputs(patchPath, repoRoot);
}
