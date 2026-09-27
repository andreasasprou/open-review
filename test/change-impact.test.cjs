"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { obligations, renderMarkdown, writeOutputs } = require("../engine/change-impact.cjs");

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  }
  execFileSync("git", ["-C", root, "add", "."]);
  return root;
}

function patch(relative, before, after, start = 1) {
  return `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n@@ -${start},${before.length} +${start},${after.length} @@\n${before.map((line) => `-${line}`).join("\n")}\n${after.map((line) => `+${line}`).join("\n")}\n`;
}

function one(t, files, diff, kind) {
  const root = fixture(t, files);
  const items = obligations(diff, root);
  assert.ok(items.some((item) => item.kind === kind), JSON.stringify(items));
  return { root, items, item: items.find((entry) => entry.kind === kind) };
}

test("status emission locates an unchanged pending-only reader", (t) => {
  const relative = "src/dentally/treatment.ts";
  const { item } = one(t, {
    [relative]: 'export function map(item) {\n  return { status: item.link ? "scheduled" : "pending" };\n}\n',
    "src/features/treatment-reader.ts": 'export const open = (items) => items.filter((item) => item.status === "pending");\n',
  }, patch(relative, ['  return { status: "pending" };'], ['  return { status: item.link ? "scheduled" : "pending" };'], 2), "status_value");
  assert.equal(item.anchor, "scheduled");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/features/treatment-reader.ts" && ref.line === 1 && !ref.changed));
});

test("discriminator change creates a variant obligation", (t) => {
  const relative = "src/commands.ts";
  const { item } = one(t, { [relative]: 'export const command = { kind: "request" };\n' }, patch(relative, ['export const command = { kind: "ask" };'], ['export const command = { kind: "request" };']), "discriminator");
  assert.equal(item.anchor, "request");
});

test("write shape searches backward for omitted linkage fields", (t) => {
  const relative = "src/booking-writer.ts";
  const { item } = one(t, {
    [relative]: 'export const save = (db, patientId) => db.bookAppointment({ patientId });\n',
    "src/plan-reader.ts": 'export const linked = (appointments, id) => appointments.filter((appointment) => appointment.planItemId === id);\n',
  }, patch(relative, ['export const save = (db, patientId) => db.bookAppointment({ patientId, planItemId });'], ['export const save = (db, patientId) => db.bookAppointment({ patientId });']), "write_shape");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/plan-reader.ts"));
  assert.ok(item.fields.includes("planItemId"), item.fields.join(","));
  assert.match(renderMarkdown([item]), /reader predicates on planItemId/);
});

test("adapter book call uses the appointment entity from its file path", (t) => {
  const relative = "src/pms-appointment-action-executor.ts";
  const { item } = one(t, {
    [relative]: "const booked = await action.adapter.book({ patientId });\n",
    "src/planned-reader.ts": "const linked = appointments.filter((appointment) => appointment.planItemId === id);\n",
  }, patch(relative, ["const booked = await action.adapter.book({ patientId, planItemId });"], ["const booked = await action.adapter.book({ patientId });"]), "write_shape");
  assert.equal(item.entity, "appointment");
  assert.ok(item.fields.includes("planItemId"));
});

test("unchanged write beside a changed booking path still gets a backward search", (t) => {
  const relative = "src/pms-appointment-action-executor.ts";
  const { item } = one(t, {
    [relative]: "const payload = { patientId };\nconst booked = await action.adapter.book(payload);\n",
    "src/planned-reader.ts": "const linked = appointments.filter((appointment) => appointment.planItemId === id);\n",
  }, `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n@@ -1,2 +1,2 @@\n-const payload = { patientId, planItemId };\n+const payload = { patientId };\n const booked = await action.adapter.book(payload);\n`, "write_shape");
  assert.equal(item.line, 1);
  assert.equal(item.writerLine, 2);
  assert.ok(item.fields.includes("planItemId"));
});

test("backward search names the treatment appointment linkage predicate", (t) => {
  const relative = "src/pms-appointment-action-executor.ts";
  const { item } = one(t, {
    [relative]: "const booked = await action.adapter.book({ patientId });\n",
    "src/treatment-plan-reader.ts": "if (item.treatment_appointment_id == null) continue;\n",
  }, patch(relative, ["const booked = await action.adapter.book({ patientId, itemId });"], ["const booked = await action.adapter.book({ patientId });"]), "write_shape");
  assert.ok(item.fields.includes("treatment_appointment_id"));
});

test("shared vendor response schema tracks all schema consumers", (t) => {
  const relative = "src/vendor/gohighlevel-response-schemas.ts";
  const { item } = one(t, {
    [relative]: 'export const ghlContactSchema = z.object({\n  dateOfBirth: optionalString,\n});\n',
    "src/vendor/search.ts": 'export const search = (raw) => ghlContactSchema.parse(raw);\n',
    "src/vendor/get.ts": 'export const get = (raw) => ghlContactSchema.safeParse(raw);\n',
  }, patch(relative, [], ['  dateOfBirth: optionalString,'], 2), "shared_schema");
  assert.equal(item.anchor, "dateOfBirth");
  assert.deepEqual(item.counterparts.map((ref) => ref.path), ["src/vendor/get.ts", "src/vendor/search.ts"]);
});

test("external page envelope union is an acceptance obligation", (t) => {
  const relative = "src/vendor/dentally-types.ts";
  const { item } = one(t, {
    [relative]: 'export const dentallyPaginationMetaSchema = z.union([\n  z.object({ total: z.number(), page: z.number() }),\n  z.object({ total: z.number(), total_pages: z.number() }),\n]);\n',
    "src/vendor/appointment-client.ts": 'export const parse = (raw) => dentallyPaginationMetaSchema.parse(raw.meta);\n',
  }, patch(relative, [], ['export const dentallyPaginationMetaSchema = z.union(['], 1), "external_parse");
  assert.equal(item.anchor, "dentallyPaginationMetaSchema");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/vendor/appointment-client.ts"));
});

test("exact pagination total check is an external parse obligation", (t) => {
  const relative = "src/vendor/dentally-client.ts";
  const { item } = one(t, {
    [relative]: 'if (allItems.length !== reportedTotal) throw invalidResponse();\n',
    "src/vendor/orders.ts": 'export const orders = (client) => client.getAllPages("orders");\n',
  }, patch(relative, ['if (allItems.length < reportedTotal) throw invalidResponse();'], ['if (allItems.length !== reportedTotal) throw invalidResponse();']), "external_parse");
  assert.equal(item.anchor, "reportedTotal");
});

test("tool instruction kind is checked against the accepted command schema", (t) => {
  const relative = "src/tool-result.ts";
  const { item } = one(t, {
    [relative]: 'agentInstruction: "Call the tool with kind request next.",\n',
    "src/tool-payload.ts": 'export const payloadSchema = z.discriminatedUnion("kind", [confirmationSchema]);\n',
  }, patch(relative, [], ['agentInstruction: "Call the tool with kind request next.",']), "tool_instruction");
  assert.equal(item.anchor, "request");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/tool-payload.ts"));
});

test("Pulumi lifecycle options create obligations", (t) => {
  const relative = "infra/stack.ts";
  const { items } = one(t, { [relative]: 'new aws.ecs.TaskDefinition("task", args, { dependsOn: [policy], retainOnDelete: true });\n' }, patch(relative, [], ['new aws.ecs.TaskDefinition("task", args, { dependsOn: [policy], retainOnDelete: true });']), "infra_lifecycle");
  assert.ok(items.some((item) => item.anchor === "dependsOn"));
});

test("removing a Pulumi lifecycle option still creates an obligation", (t) => {
  const relative = "infra/stack.ts";
  const root = fixture(t, { [relative]: 'new aws.ecs.TaskDefinition("task", args);\n' });
  const diff = `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n@@ -1,2 +1 @@\n-skipDestroy: true,\n new aws.ecs.TaskDefinition("task", args);\n`;
  const item = obligations(diff, root).find((entry) => entry.kind === "infra_lifecycle");
  assert.equal(item.anchor, "skipDestroy");
  assert.match(renderMarkdown([item]), /skipDestroy: true, → removed/);
});

test("fresh workspace config read creates an obligation", (t) => {
  const relative = "infra/config.ts";
  const { item } = one(t, { [relative]: 'export const bundle = config.require("atomicTlsBundleArn");\n' }, patch(relative, [], ['export const bundle = config.require("atomicTlsBundleArn");']), "config_key");
  assert.equal(item.anchor, "atomicTlsBundleArn");
});

test("clean diff writes zero obligations and deterministic outputs", (t) => {
  const root = fixture(t, { "src/value.ts": "export const value = 2;\n" });
  const diff = patch("src/value.ts", ["export const value = 1;"], ["export const value = 2;"]);
  const patchPath = path.join(root, "clean.patch");
  fs.writeFileSync(patchPath, diff);
  assert.deepEqual(obligations(diff, root), []);
  writeOutputs(patchPath, root);
  const first = fs.readFileSync(path.join(root, ".codex-ci/change-impact.md"), "utf8");
  writeOutputs(patchPath, root);
  assert.equal(fs.readFileSync(path.join(root, ".codex-ci/change-impact.md"), "utf8"), first);
  assert.match(first, /Obligations: 0\n$/);
});

test("ordering is independent of diff file order and Markdown is bounded", (t) => {
  const files = {
    "src/z.ts": 'export const z = { kind: "ready" };\n',
    "src/a.ts": 'export const a = { kind: "done" };\n',
  };
  const root = fixture(t, files);
  const a = patch("src/a.ts", [], ['export const a = { kind: "done" };']);
  const z = patch("src/z.ts", [], ['export const z = { kind: "ready" };']);
  assert.deepEqual(obligations(z + a, root), obligations(a + z, root));
  const items = Array.from({ length: 150 }, (_, n) => ({ ...obligations(a, root)[0], id: `CI-${n + 1}` }));
  const markdown = renderMarkdown(items);
  assert.ok(markdown.split("\n").length <= 400, "including trailing empty line");
  assert.match(markdown, /Dropped from Markdown: /);
  assert.match(markdown, /Obligations: 150\n$/);
});

test("replacement-only status change finds a pending-only reader", (t) => {
  const relative = "src/producer.ts";
  const { item } = one(t, {
    [relative]: 'export const result = { status: "scheduled" };\n',
    "src/reader.ts": 'export const open = (item) => item.status === "pending";\n',
  }, patch(relative, ['export const result = { status: "pending" };'], ['export const result = { status: "scheduled" };']), "status_value");
  assert.ok(item.terms.includes("pending"));
  assert.ok(item.counterparts.some((ref) => ref.path === "src/reader.ts"));
});

test("purely removed schema, status and config contracts keep surviving readers", (t) => {
  const files = {
    "src/customer-schema.ts": 'export const customerSchema = z.object({\n});\n',
    "src/producer.ts": 'export const result = {};\n',
    "src/config.ts": 'export const config = new Config();\n',
    "src/reader.ts": 'export const read = (row) => row.customerId && row.status === "pending";\nexport const key = config.require("atomicTlsBundleArn");\n',
  };
  const root = fixture(t, files);
  const diff = `diff --git a/src/customer-schema.ts b/src/customer-schema.ts\n--- a/src/customer-schema.ts\n+++ b/src/customer-schema.ts\n@@ -1,3 +1,2 @@\n export const customerSchema = z.object({\n-  customerId: z.string(),\n });\n` +
    `diff --git a/src/producer.ts b/src/producer.ts\n--- a/src/producer.ts\n+++ b/src/producer.ts\n@@ -1,2 +1 @@\n-export const result = { status: "pending" };\n export const result = {};\n` +
    `diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1,2 +1 @@\n-const bundle = config.require("atomicTlsBundleArn");\n export const config = new Config();\n`;
  const items = obligations(diff, root);
  for (const kind of ["shared_schema", "status_value", "config_key"]) {
    const item = items.find((entry) => entry.kind === kind);
    assert.ok(item, `${kind}: ${JSON.stringify(items)}`);
    assert.ok(item.counterparts.some((ref) => ref.path === "src/reader.ts"), kind);
  }
});

test("whole-file schema deletion produces a consumer obligation", (t) => {
  const root = fixture(t, { "src/consumer.ts": "export const read = (raw) => customerSchema.parse(raw);\n" });
  const diff = 'diff --git a/src/customer-schema.ts b/src/customer-schema.ts\n--- a/src/customer-schema.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-export const customerSchema = z.object({\n-  customerId: z.string(),\n-});\n';
  const item = obligations(diff, root).find((entry) => entry.kind === "shared_schema");
  assert.equal(item.path, "src/customer-schema.ts");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/consumer.ts"));
});

test("deleting a schema block from a retained file uses its old context", (t) => {
  const relative = "src/customer-schemas.ts";
  const root = fixture(t, {
    [relative]: "export const otherSchema = z.object({});\n",
    "src/consumer.ts": "export const read = (raw) => customerSchema.parse(raw);\n",
  });
  const diff = `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n@@ -1,4 +1 @@\n-export const customerSchema = z.object({\n-  customerId: z.string(),\n-});\n export const otherSchema = z.object({});\n`;
  const item = obligations(diff, root).find((entry) => entry.kind === "shared_schema");
  assert.equal(item.schema, "customerSchema");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/consumer.ts"));
});

test("same field in two schemas keeps distinct contracts", (t) => {
  const relative = "src/customer-schemas.ts";
  const root = fixture(t, { [relative]: "export const stringSchema = z.object({\n  customerId: z.string(),\n});\nexport const numberSchema = z.object({\n  customerId: z.number(),\n});\n" });
  const diff = `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n@@ -1,6 +1,6 @@\n export const stringSchema = z.object({\n-  customerId: z.number(),\n+  customerId: z.string(),\n });\n export const numberSchema = z.object({\n-  customerId: z.string(),\n+  customerId: z.number(),\n });\n`;
  const items = obligations(diff, root).filter((entry) => entry.kind === "shared_schema" && entry.anchor === "customerId");
  assert.deepEqual(items.map((entry) => entry.schema), ["stringSchema", "numberSchema"]);
});

test("a nearby status line does not turn a source literal into a status obligation", (t) => {
  const relative = "src/result.ts";
  const root = fixture(t, { [relative]: 'const result = {\n  status: "pending",\n  source: "caller_id",\n};\n' });
  const diff = `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n@@ -1,3 +1,4 @@\n const result = {\n   status: "pending",\n+  source: "caller_id",\n };\n`;
  assert.ok(!obligations(diff, root).some((item) => item.kind === "status_value"));
});

test("multiline status switch accepts its case as a reader", (t) => {
  const relative = "src/producer.ts";
  const { item } = one(t, {
    [relative]: 'export const result = { status: "scheduled" };\n',
    "src/reader.ts": 'switch (\n  item.status\n) {\n  case "pending":\n    return true;\n}\n',
  }, patch(relative, ['export const result = { status: "pending" };'], ['export const result = { status: "scheduled" };']), "status_value");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/reader.ts" && ref.line === 4));
});

test("reversed equality, array membership, and backtick status readers survive", (t) => {
  const relative = "src/producer.ts";
  const { item } = one(t, {
    [relative]: 'export const result = { status: "scheduled" };\n',
    "src/reader.ts": 'export const reversed = (item) => "scheduled" === item.status;\nexport const member = (item) => ["pending", "scheduled"].includes(item.status);\nexport const template = (item) => item.status === `scheduled`;\n',
  }, patch(relative, ['export const result = { status: "pending" };'], ['export const result = { status: "scheduled" };']), "status_value");
  assert.deepEqual(item.counterparts.filter((ref) => ref.path === "src/reader.ts").map((ref) => ref.line).sort(), [1, 2, 3]);
});

test("short discriminator finds a real kind consumer", (t) => {
  const relative = "src/producer.ts";
  const { item } = one(t, {
    [relative]: 'export const command = { kind: "request" };\n',
    "src/reader.ts": 'export const accepts = (command) => command.kind === "request";\n',
  }, patch(relative, ['export const command = { kind: "ask" };'], ['export const command = { kind: "request" };']), "discriminator");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/reader.ts"));
});

test("short write entity finds a reader predicate", (t) => {
  const relative = "src/order-writer.ts";
  const { item } = one(t, {
    [relative]: 'export const write = (db) => db.createOrder({ id: 1 });\n',
    "src/order-reader.ts": 'export const linked = (orders, id) => orders.filter((order) => order.customerId === id);\n',
  }, patch(relative, ['export const write = (db) => db.createOrder({ id: 1, customerId: 2 });'], ['export const write = (db) => db.createOrder({ id: 1 });']), "write_shape");
  assert.ok(item.counterparts.some((ref) => ref.path === "src/order-reader.ts"));
  assert.ok(item.fields.includes("customerId"));
});

test("git grep zero delimiters preserve Unicode and space in a counterpart path", (t) => {
  const relative = "src/producer.ts";
  const target = "src/é spaced.ts";
  const { item } = one(t, {
    [relative]: 'export const result = { status: "scheduled" };\n',
    [target]: 'export const open = (item) => item.status === "pending";\n',
  }, patch(relative, ['export const result = { status: "pending" };'], ['export const result = { status: "scheduled" };']), "status_value");
  assert.ok(item.counterparts.some((ref) => ref.path === target));
});

test("count budgets bound a 20k-by-20k status inventory", (t) => {
  const producer = Array.from({ length: 20000 }, (_, index) => `status: ready ? "scheduled" : "state${index}",`).join("\n") + "\n";
  const reader = Array.from({ length: 20000 }, () => 'if (item.status === "scheduled") return true;').join("\n") + "\n";
  const root = fixture(t, { "src/producer.ts": producer, "src/reader.ts": reader });
  const diff = patch("src/producer.ts", [], producer.trimEnd().split("\n"));
  const patchPath = path.join(root, "large.patch");
  fs.writeFileSync(patchPath, diff);
  const started = performance.now();
  writeOutputs(patchPath, root);
  const elapsedMs = performance.now() - started;
  const jsonPath = path.join(root, ".codex-ci/change-impact.json");
  const items = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.ok(elapsedMs < 10000, `${elapsedMs} ms`);
  assert.ok(fs.statSync(jsonPath).size < 2 * 1024 * 1024);
  assert.equal(items.length, 1);
  assert.equal(items[0].siteCount, 20000);
  assert.equal(items[0].termCount, 20001);
  assert.ok(items[0].terms.length <= 4);
  assert.ok(items[0].counterpartCount >= 20000);
  assert.equal(items[0].counterparts.length, 50);
});

test("JSON obligation cap records the dropped count", (t) => {
  const relative = "src/producer.ts";
  const lines = Array.from({ length: 270 }, (_, index) => `status: "state${index}",`);
  const root = fixture(t, { [relative]: lines.join("\n") + "\n" });
  const items = obligations(patch(relative, [], lines), root);
  assert.equal(items.length, 256);
  assert.equal(items[0].inventoryTotal, 270);
  assert.equal(items[0].droppedObligations, 14);
  assert.match(renderMarkdown(items), /Dropped from JSON: 14/);
});

test("the sole status with an unchanged reader survives the JSON cap", (t) => {
  const relative = "src/producer.ts";
  const lines = Array.from({ length: 257 }, (_, index) => `status: "state${index}",`);
  const root = fixture(t, { [relative]: lines.join("\n") + "\n", "src/reader.ts": 'export const needed = (item) => item.status === "state256";\n' });
  const items = obligations(patch(relative, [], lines), root);
  assert.equal(items.length, 256);
  const retained = items.find((item) => item.anchor === "state256");
  assert.ok(retained);
  assert.ok(retained.counterparts.some((ref) => ref.path === "src/reader.ts" && !ref.changed));
});

test("Markdown reserves space for every represented kind", () => {
  const kinds = ["status_value", "discriminator", "write_shape", "shared_schema", "external_parse", "tool_instruction", "infra_lifecycle", "config_key"];
  const items = Array.from({ length: 130 }, (_, index) => ({
    id: `CI-${index + 1}`, kind: kinds[index % kinds.length], anchor: "sample", path: "src/sample.ts", line: index + 1,
    old: null, added: 'status: "sample"', fields: [], schema: "sampleSchema", counterparts: [{ path: "src/reader.ts", line: 1, changed: false }], counterpartCount: 1,
  }));
  const markdown = renderMarkdown(items);
  assert.ok(markdown.split("\n").length <= 400, "including trailing empty line");
  for (const kind of kinds) assert.match(markdown, new RegExp(`^### CI-\\d+ ${kind}:`, "m"));
});
