"use strict";

// Test double for the caught-error diagnostic recorder: keeps every record in
// memory so a test can assert what was recorded, and refuses to grow without
// bound.
const DEFAULT_RECORD_LIMIT = 1_000;

function createRecordingCaughtErrorDiagnosticRecorder(input) {
	const limit = input?.limit ?? DEFAULT_RECORD_LIMIT;
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error("Caught-error recording limit must be a positive integer.");
	}
	const records = [];
	return {
		records,
		recordCaughtError: (record) => {
			if (records.length >= limit) {
				throw new Error("Caught-error diagnostic recording fake overflowed.");
			}
			records.push(record);
		},
	};
}

module.exports = { createRecordingCaughtErrorDiagnosticRecorder };
