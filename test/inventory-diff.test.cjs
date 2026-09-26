"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inventory, render, unquoteGitPath } = require("../engine/inventory-diff.cjs");

const PATCH = `diff --git a/src/daemon.ts b/src/daemon.ts
--- a/src/daemon.ts
+++ b/src/daemon.ts
@@ -50,4 +50,8 @@ export function main() {
   const daemon = createDaemon()
+  function shutdown(): void {
+    void daemon.stop().then(() => process.exit(0))
+  }
+  process.once("SIGTERM", shutdown)
 }
diff --git a/apps/web/src/header.tsx b/apps/web/src/header.tsx
--- a/apps/web/src/header.tsx
+++ b/apps/web/src/header.tsx
@@ -30,3 +30,5 @@ export function Header() {
   const model = useModel()
+  if (cachedRestartRequired && readState !== "failed") {
+    return <RestartPrompt />
+  }
   // comment: if state and status
`;

test("inventory lists exit paths, floating promises, and multi-source conditionals with new-file lines", () => {
  const items = inventory(PATCH);
  const key = (item) => `${item.category} ${item.path}:${item.line}`;
  const keys = items.map(key);
  assert.ok(keys.includes("floating_promise src/daemon.ts:52"), keys.join(", "));
  assert.ok(keys.includes("exit_path src/daemon.ts:52"), keys.join(", "));
  assert.ok(keys.includes("exit_path src/daemon.ts:54"), keys.join(", "));
  assert.ok(keys.includes("status_conditional apps/web/src/header.tsx:31"), keys.join(", "));
  assert.ok(!keys.some((k) => k.includes("header.tsx:34")), "comment lines are skipped");
});

test("render says so when the diff has no inventory items", () => {
  assert.match(render(inventory("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+const a = 1\n")), /No inventory items/);
});

test("a guard formatted across lines is classified as one statement at its first line", () => {
  const patch = `diff --git a/src/h.tsx b/src/h.tsx
--- a/src/h.tsx
+++ b/src/h.tsx
@@ -10,2 +10,6 @@ f() {
+  if (
+    cachedRestartRequired &&
+    readState !== "failed"
+  ) {
+    return null
+  }
`;
  const keys = inventory(patch).map((item) => `${item.category} ${item.path}:${item.line}`);
  assert.deepEqual(keys, ["status_conditional src/h.tsx:10"]);
});

test("python test files and git-quoted paths are handled", () => {
  const patch = String.raw`diff --git a/test_x.py b/test_x.py
--- a/test_x.py
+++ b/test_x.py
@@ -1 +1,2 @@
+try:
+except Exception: raise
diff --git "a/src/\303\251.ts" "b/src/\303\251.ts"
--- "a/src/\303\251.ts"
+++ "b/src/\303\251.ts"
@@ -1 +1 @@
+process.exit(1)
`;
  const items = inventory(patch);
  assert.deepEqual(items.map((item) => item.path), ["src/é.ts"]);
  assert.equal(unquoteGitPath('"b/a\\tb.ts"'), "b/a\tb.ts");
});

test("exported contracts and union members are inventoried", () => {
  const patch = `diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,2 +1,5 @@
+export function useEligibility(input: Input): State {
+type State = { kind: "loading" }
+  | { kind: "unsupported" }
+export type { State }
 const x = 1
`;
  const keys = inventory(patch).filter((item) => item.category === "contract").map((item) => `${item.path}:${item.line}`);
  assert.deepEqual(keys, ["src/c.ts:1", "src/c.ts:3", "src/c.ts:4"]);
});

test("a new context read inside a hook is inventoried as a provider read", () => {
  const patch = `diff --git a/src/h.ts b/src/h.ts
--- a/src/h.ts
+++ b/src/h.ts
@@ -5,2 +5,3 @@ export function useThing() {
+  const recorder = useBrowserDiagnosticRecorderContext()
   return recorder
`;
  assert.deepEqual(inventory(patch).map((item) => `${item.category} ${item.path}:${item.line}`), ["provider_read src/h.ts:5"]);
});

test("union continuation members and React use(Context) reads are inventoried", () => {
  const patch = `diff --git a/src/u.ts b/src/u.ts
--- a/src/u.ts
+++ b/src/u.ts
@@ -3,2 +3,5 @@ export type Outcome =
   | { readonly kind: "ready" }
+  | { readonly kind: "unsupported" }
+  | "cancelled"
+  const ctx = use(RecorderContext)
`;
  const keys = inventory(patch).map((item) => `${item.category} ${item.path}:${item.line}`);
  assert.ok(keys.includes("contract src/u.ts:4"), keys.join(", "));
  assert.ok(keys.includes("contract src/u.ts:5"), keys.join(", "));
  assert.ok(keys.includes("provider_read src/u.ts:6"), keys.join(", "));
});
