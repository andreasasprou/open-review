// Vendored esbuild bundle of the caught-error diagnostics runtime. Its TypeScript
// sources are not part of this repository; change it deliberately and keep the
// exported surface (recordCaughtError, runReviewCli, ...) stable.
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// .github/scripts/codex-review/diagnostics-runtime.mjs
var diagnostics_runtime_exports = {};
__export(diagnostics_runtime_exports, {
  CaughtErrorDiagnosticFailure: () => CaughtErrorDiagnosticFailure,
  REVIEW_DIAGNOSTIC_EXIT_CODE: () => REVIEW_DIAGNOSTIC_EXIT_CODE,
  caughtErrorDiagnosticFailureParts: () => caughtErrorDiagnosticFailureParts,
  caughtErrorDiagnosticSequenceFailureParts: () => caughtErrorDiagnosticSequenceFailureParts,
  createCaughtErrorDiagnosticFailure: () => createCaughtErrorDiagnosticFailure,
  createCaughtErrorDiagnosticSequenceFailure: () => createCaughtErrorDiagnosticSequenceFailure,
  createStderrCaughtErrorDiagnostics: () => createStderrCaughtErrorDiagnostics,
  recordCaughtError: () => recordCaughtError,
  requireCaughtErrorDiagnosticRecorder: () => requireCaughtErrorDiagnosticRecorder,
  runReviewCli: () => runReviewCli
});
module.exports = __toCommonJS(diagnostics_runtime_exports);

// shared/primitives/invariant.ts
var InvariantViolationError = class extends Error {
  kind = "invariant_violation";
  name = "InvariantViolationError";
};
function invariantViolationError(input) {
  return new InvariantViolationError(input.message);
}

// shared/primitives/json.ts
function isFunctionValue(value) {
  return typeof value === "function";
}
function isObjectType(value) {
  return typeof value === "object";
}

// shared/diagnostics/caught-error-diagnostic.ts
var failureParts = /* @__PURE__ */ new WeakMap();
var sequenceFailureParts = /* @__PURE__ */ new WeakMap();
var CaughtErrorDiagnosticFailure = class extends Error {
  constructor(input) {
    super("Caught-error diagnostic delivery failed.");
    Object.defineProperties(this, {
      code: { value: "CAUGHT_ERROR_DIAGNOSTIC_FAILED" },
      disposition: { value: input.disposition },
      name: { value: "CaughtErrorDiagnosticFailure" },
      operation: { value: input.operation },
      stage: { value: input.stage }
    });
  }
};
function createCaughtErrorDiagnosticFailure(input) {
  const failure = new CaughtErrorDiagnosticFailure(input);
  failureParts.set(failure, [
    input.original,
    input.primaryFailure,
    input.fallbackFailure
  ]);
  return failure;
}
function caughtErrorDiagnosticFailureParts(failure) {
  const parts = failureParts.get(failure);
  if (parts === void 0) {
    throw invariantViolationError({
      message: "Caught-error diagnostic failure parts are unavailable."
    });
  }
  return parts;
}
function createCaughtErrorDiagnosticSequenceFailure(input) {
  const failure = new CaughtErrorDiagnosticFailure(input);
  sequenceFailureParts.set(failure, [
    input.earlierFailure,
    input.laterFailure
  ]);
  return failure;
}
function caughtErrorDiagnosticSequenceFailureParts(failure) {
  const parts = sequenceFailureParts.get(failure);
  if (parts === void 0) {
    throw invariantViolationError({
      message: "Caught-error diagnostic sequence failure parts are unavailable."
    });
  }
  return parts;
}
function recordCaughtError(input) {
  if (input.error instanceof CaughtErrorDiagnosticFailure) {
    throw input.error;
  }
  input.recorder.recordCaughtError({
    error: input.error,
    operation: input.operation,
    stage: input.stage,
    disposition: input.disposition,
    context: input.context
  });
}
function requireCaughtErrorDiagnosticRecorder(candidate) {
  if (candidate === null || !isObjectType(candidate) || !isFunctionValue(candidate.recordCaughtError)) {
    throw invariantViolationError({
      message: "Caught-error diagnostic recorder is required."
    });
  }
  return candidate;
}
function diagnosticThrownValueKind(error) {
  return Object(error) === error ? "object_throw" : "non_object_throw";
}

// shared/diagnostics/node/caught-error-process-recorder.ts
var MAX_CAUGHT_ERROR_LINE_BYTES = 2e3;
var SAFE_CONTEXT_VALUE = /^[A-Za-z0-9._:-]{1,128}$/u;
var PROCESS_EVENT_PREFIX = `caught_${String(process.pid)}_${String(Date.now())}_`;
var processEventSequence = 0;
function createStderrCaughtErrorDiagnosticRecorder(input) {
  return {
    recordCaughtError: (caught) => {
      const recorded = recordThroughProcessOutput({
        caught,
        eventId: nextProcessEventId(),
        writeLine: (line) => input.output.writeStderrLine(line)
      });
      if (recorded.kind === "recorded") return;
      throw createCaughtErrorDiagnosticSequenceFailure({
        earlierFailure: caught.error,
        laterFailure: recorded.failure,
        operation: caught.operation,
        stage: caught.stage,
        disposition: caught.disposition
      });
    }
  };
}
function nextProcessEventId() {
  processEventSequence += 1;
  return `${PROCESS_EVENT_PREFIX}${String(processEventSequence)}`;
}
function recordThroughProcessOutput(input) {
  const authoritative = authoritativeCaughtError(input);
  const line = boundedCaughtLine({
    context: authoritative.context,
    contextRemovalOrder: [
      "correlationId",
      "turnId",
      "sessionId",
      "runtimeId",
      "workspaceId",
      "orgId"
    ],
    record: authoritative.line
  });
  if (line.kind === "failed") {
    return { kind: "failed", eventId: input.eventId, failure: line.failure };
  }
  const outcome = input.writeLine(line.line);
  if (outcome.kind === "failed") {
    return { kind: "failed", eventId: input.eventId, failure: outcome.failure };
  }
  return {
    kind: "recorded",
    eventId: input.eventId,
    record: authoritative.forward
  };
}
function authoritativeCaughtError(input) {
  const level = input.caught.disposition === "propagate" ? "error" : "warn";
  const context = safeAuthoritativeContext(input.caught.context);
  const data = {
    event_id: input.eventId,
    source_error_kind: diagnosticThrownValueKind(input.caught.error),
    operation: input.caught.operation,
    stage: input.caught.stage,
    disposition: input.caught.disposition
  };
  return {
    context,
    line: {
      level,
      name: "error.caught",
      message: "Caught error.",
      ...data,
      context
    },
    forward: {
      level,
      name: "error.caught",
      message: "Caught error.",
      context,
      data,
      error: input.caught.error
    }
  };
}
function boundedCaughtLine(input) {
  for (const key of [void 0, ...input.contextRemovalOrder]) {
    if (key !== void 0) delete input.context[key];
    const line = `${JSON.stringify(input.record)}
`;
    if (Buffer.byteLength(line, "utf8") <= MAX_CAUGHT_ERROR_LINE_BYTES) {
      return { kind: "encoded", line };
    }
  }
  return {
    kind: "failed",
    failure: new Error("Caught-error diagnostic record exceeded its size limit.")
  };
}
function safeAuthoritativeContext(context) {
  return safeContext({
    correlationId: context.correlationId,
    orgId: context.orgId,
    runtimeId: context.runtimeId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    workspaceId: context.workspaceId
  });
}
function safeContext(values) {
  return Object.fromEntries(Object.entries(values).filter(
    (entry) => entry[1] !== void 0 && SAFE_CONTEXT_VALUE.test(entry[1])
  ));
}

// shared/diagnostics/node/structured-process-fd-writer.ts
var import_node_fs = require("node:fs");
var MAX_STRUCTURED_PROCESS_LINE_BYTES = 4095;
function structuredProcessStdoutLineWriter(output) {
  return (line) => {
    const outcome = output.writeStdoutLine(line);
    if (outcome.kind === "failed") throw outcome.failure;
  };
}
function attemptLineWrite(input) {
  if (input.endpoint.poisoned) {
    return failedWrite("Structured process output framing is unavailable.");
  }
  const encoded = Buffer.from(input.line, "utf8");
  if (!singleBoundedLine({ encoded })) {
    return failedWrite("Structured process output line is invalid.");
  }
  try {
    const written = input.write({ fd: input.endpoint.fd, value: encoded });
    if (written === encoded.byteLength) return { kind: "written" };
    if (written > 0 || input.zeroWritePoisons === true) {
      input.endpoint.poisoned = true;
    }
    return failedWrite("Structured process output write was incomplete.");
  } catch (error) {
    return { kind: "failed", failure: error };
  }
}
function singleBoundedLine(input) {
  if (input.encoded.byteLength === 0 || input.encoded.byteLength > MAX_STRUCTURED_PROCESS_LINE_BYTES || input.encoded.at(-1) !== 10) return false;
  return !input.encoded.subarray(0, -1).includes(10);
}
function failedWrite(message) {
  return { kind: "failed", failure: new Error(message) };
}
function reopenableForWrite(stat) {
  const euid = process.geteuid?.();
  return euid === void 0 || euid === 0 || stat.uid === euid && (stat.mode & 128) !== 0;
}
function createStructuredStderrWriter() {
  const stderr = (0, import_node_fs.fstatSync)(2);
  const useStream = process.platform === "darwin" || stderr.isSocket() || stderr.isFile() || !reopenableForWrite(stderr);
  const endpoint = {
    fd: useStream ? 2 : (0, import_node_fs.openSync)("/proc/self/fd/2", import_node_fs.constants.O_WRONLY | import_node_fs.constants.O_NONBLOCK | import_node_fs.constants.O_APPEND),
    poisoned: false
  };
  const writeLine = (line) => attemptLineWrite({
    endpoint,
    line,
    write: ({ fd, value }) => useStream ? process.stderr.write(value) ? value.byteLength : 0 : (0, import_node_fs.writeSync)(fd, value),
    zeroWritePoisons: useStream
  });
  let closed = false;
  return {
    writeStdoutLine: writeLine,
    writeStderrLine: writeLine,
    close: () => {
      if (closed) return;
      closed = true;
      endpoint.poisoned = true;
      if (!useStream) (0, import_node_fs.closeSync)(endpoint.fd);
    }
  };
}

// shared/diagnostics/node/stderr-caught-error-diagnostics.ts
function createStderrCaughtErrorDiagnostics() {
  const output = createStructuredStderrWriter();
  return {
    recorder: createStderrCaughtErrorDiagnosticRecorder({ output }),
    writeLine: structuredProcessStdoutLineWriter(output),
    close: output.close
  };
}

// .github/scripts/codex-review/diagnostics-runtime.mjs
var REVIEW_DIAGNOSTIC_EXIT_CODE = 78;
async function runReviewCli(run) {
  const [started] = await Promise.allSettled([Promise.resolve().then(createStderrCaughtErrorDiagnostics)]);
  if (started.status === "rejected") {
    process.exitCode = REVIEW_DIAGNOSTIC_EXIT_CODE;
    return;
  }
  const diagnostics = started.value;
  const recorder = requireCaughtErrorDiagnosticRecorder(diagnostics.recorder);
  const [result] = await Promise.allSettled([Promise.resolve().then(() => run(recorder)).catch((error) => {
    recordCaughtError({ recorder, error, operation: "review.cli", stage: "execute", disposition: "propagate", context: {} });
    throw error;
  })]);
  const [closed] = await Promise.allSettled([Promise.resolve().then(diagnostics.close).catch((error) => {
    recordCaughtError({ recorder, error, operation: "review.cli", stage: "close", disposition: "propagate", context: {} });
    throw error;
  })]);
  const failures = [result, closed].flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
  if (failures.length === 0) return;
  let failure = failures[0];
  if (failures.length > 1) {
    failure = failures.some((error) => error instanceof CaughtErrorDiagnosticFailure) ? createCaughtErrorDiagnosticSequenceFailure({
      earlierFailure: failures[0],
      laterFailure: failures[1],
      operation: "review.cli",
      stage: "settlement",
      disposition: "propagate"
    }) : new AggregateError(failures, "Review operations failed.");
  }
  process.exitCode = failure instanceof CaughtErrorDiagnosticFailure ? REVIEW_DIAGNOSTIC_EXIT_CODE : 1;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CaughtErrorDiagnosticFailure,
  REVIEW_DIAGNOSTIC_EXIT_CODE,
  caughtErrorDiagnosticFailureParts,
  caughtErrorDiagnosticSequenceFailureParts,
  createCaughtErrorDiagnosticFailure,
  createCaughtErrorDiagnosticSequenceFailure,
  createStderrCaughtErrorDiagnostics,
  recordCaughtError,
  requireCaughtErrorDiagnosticRecorder,
  runReviewCli
});
