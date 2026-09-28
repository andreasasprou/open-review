"use strict";

function parseLocations(location) {
  // V4 `where` can name several file:line spans in prose.
  const text = String(location ?? "");
  const spans = [];
  let lastFile = null;
  const range = "\\d+(?:\\s*[-\\u2013\\u2014]\\s*\\d+)?";
  const file = String.raw`[\p{L}\p{N}_.\-/\[\]@+()]+(?: [\p{L}\p{N}_.\-/\[\]@+()]+)*`;
  const re = new RegExp("(?:(?:the )?(same file)|(" + file + ")):(" + range + "(?:\\s*,\\s*" + range + ")*)", "gu");
  for (const match of text.matchAll(re)) {
    const pathname = match[2] ?? lastFile;
    if (!pathname) continue;
    lastFile = pathname;
    for (const part of match[3].split(",")) {
      const [start, end] = part.split(/[-\u2013\u2014]/).map((value) => Number(value.trim()));
      spans.push({ file: pathname, start, end: Number.isFinite(end) ? end : start });
    }
  }
  return spans;
}

function spansForPath(location, knownPath) {
  const text = String(location ?? "");
  if (!knownPath) return [];
  const range = String.raw`\d+(?:\s*[-–—]\s*\d+)?`;
  const spanList = new RegExp(`^:(${range}(?:\\s*,\\s*${range})*)`, "u");
  const sameFile = new RegExp(`(?:the\\s+)?same file:(${range}(?:\\s*,\\s*${range})*)`, "gu");
  const spans = [];
  const add = (list) => {
    for (const part of list.split(",")) {
      const [start, end] = part.split(/[-–—]/u).map((value) => Number(value.trim()));
      spans.push({ file: knownPath, start, end: Number.isFinite(end) ? end : start });
    }
  };
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(knownPath, from);
    if (index < 0) break;
    from = index + knownPath.length;
    const before = text.slice(0, index);
    if (index && !/[\s`([{"';,:→]/u.test(text[index - 1])) continue;
    // Whitespace within a longer path is not a new path boundary.
    const fragment = before.slice(Math.max(...[';', ':', '`', '(', '[', '{', '\n', '→']
      .map((separator) => before.lastIndexOf(separator))) + 1);
    if (/[/\\]/u.test(fragment)) continue;
    const match = text.slice(from).match(spanList);
    if (!match) continue;
    add(match[1]);
    const end = from + match[0].length;
    let cursor = end;
    for (const same of text.slice(end).matchAll(sameFile)) {
      const next = end + same.index;
      const between = text.slice(cursor, next);
      if (/:\s*\d/u.test(between)) break;
      add(same[1]);
      cursor = next + same[0].length;
    }
  }
  return spans;
}

module.exports = { parseLocations, spansForPath };
