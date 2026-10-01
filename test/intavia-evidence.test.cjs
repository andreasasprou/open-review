"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EVIDENCE_CHALLENGE_MARKER,
  EvidenceError,
  HUMAN_DECISION_MARKER,
  buildReviewTarget,
  canonicalJson,
  collectEvidenceBundle,
  loadCheckIdentity,
  collectLedgerEvidence,
  revalidateLedgerAuthority,
  collectPaginated,
  formatEvidenceChallengeComment,
  formatHumanDecisionComment,
  hasPreparedHistoricalReopen,
  hasUnreviewedHumanDecision,
  hasUnreviewedReviewRefresh,
  hashBytes,
  hashCanonical,
  hashReviewTarget,
  parseEvidenceChallengeComment,
  parseHumanDecisionComment,
  resolveCallerJobName,
  selectModelContext,
} = require("../engine/ledger/evidence.cjs");
const {
  ContractError,
  buildMechanicalCandidate,
  buildProjection,
  formatProjectionComment,
  parseProjectionComment,
  prepareReviewPriorProjection,
} = require("../engine/ledger/projection.cjs");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const HASH_E = "e".repeat(64);
const REPOSITORY_ID = 1001;


test("canonical JSON and ReviewTarget hashes are independent of object insertion order", () => {
  assert.equal(
    canonicalJson({ z: [3, { b: true, a: null }], a: "first" }),
    '{"a":"first","z":[3,{"a":null,"b":true}]}',
  );

  const target = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });

  assert.deepEqual(target, {
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  assert.equal(hashCanonical(target).length, 64);
  assert.throws(
    () => buildReviewTarget({ ...target, trusted_reviewer_ref: "main" }),
    /trusted_reviewer_ref/,
  );
});

test("ledger converts plain-object provider failures to Errors with code and message", async () => {
  await assert.rejects(collectPaginated({
    fetchPage: async () => { throw { code: "provider_failure", message: "provider refused request" }; },
    ceiling: 1, sleep: async () => {},
  }), (error) => {
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.code, "provider_failure");
    assert.match(error.cause.message, /provider refused request/);
    return true;
  });
});

test("bounded pagination retries pages, preserves order, and fails closed at ceilings", async () => {
  const sleeps = [];
  let secondPageAttempts = 0;
  const result = await collectPaginated({
    ceiling: 3,
    sleep: async (ms) => sleeps.push(ms),
    fetchPage: async ({ cursor }) => {
      if (cursor === null) {
        return { items: [{ id: 1 }, { id: 2 }], next_cursor: "two" };
      }
      secondPageAttempts += 1;
      if (secondPageAttempts === 1) {
        const error = new Error("secondary rate limit");
        error.retry_after_ms = 1_000;
        throw error;
      }
      return { items: [{ id: 3 }], next_cursor: null };
    },
  });

  assert.deepEqual(
    result.items.map(({ id }) => id),
    [1, 2, 3],
  );
  assert.deepEqual(sleeps, [1_000]);

  await assert.rejects(
    collectPaginated({
      ceiling: 2,
      fetchPage: async () => ({
        items: [{ id: 1 }, { id: 2 }, { id: 3 }],
        next_cursor: null,
      }),
    }),
    (error) =>
      error instanceof EvidenceError && error.code === "evidence_overflow",
  );
});

test("pagination rejects malformed cursors, overlong retry delays, and third failure", async () => {
  await assert.rejects(
    collectPaginated({
      ceiling: 10,
      fetchPage: async () => ({ items: [], next_cursor: "repeat" }),
    }),
    (error) =>
      error instanceof EvidenceError && error.code === "malformed_pagination",
  );

  await assert.rejects(
    collectPaginated({
      ceiling: 10,
      fetchPage: async () => {
        const error = new Error("slow down");
        error.retry_after_ms = 31_000;
        throw error;
      },
    }),
    (error) =>
      error instanceof EvidenceError && error.code === "evidence_unavailable",
  );

  let attempts = 0;
  await assert.rejects(
    collectPaginated({
      ceiling: 10,
      sleep: async () => {},
      fetchPage: async () => {
        attempts += 1;
        throw new Error("still unavailable");
      },
    }),
    (error) =>
      error instanceof EvidenceError && error.code === "evidence_unavailable",
  );
  assert.equal(attempts, 3);
});

test("model context keeps required evidence and reports bounded exclusions", () => {
  const selected = selectModelContext({
    entries: [
      { id: "ordinary-old", body: "x".repeat(9_000), required: false },
      { id: "decision", body: "keep me", required: true },
      { id: "ordinary-new", body: "also keep", required: false },
    ],
    max_entries: 2,
    max_body_bytes: 8_000,
    max_total_bytes: 96_000,
  });

  assert.deepEqual(
    selected.entries.map(({ id }) => id),
    ["decision", "ordinary-new"],
  );
  assert.deepEqual(selected.exclusions, [
    { id: "ordinary-old", reason: "body_too_large" },
  ]);

  assert.throws(
    () =>
      selectModelContext({
        entries: [{ id: "required", body: "x".repeat(9), required: true }],
        max_entries: 10,
        max_body_bytes: 8,
        max_total_bytes: 100,
      }),
    (error) =>
      error instanceof EvidenceError && error.code === "model_context_overflow",
  );
});

test("only a prepared historical reopen requires model review", () => {
  const current = {
    open_findings: [{ stable_id: "CURRENT-001" }],
  };

  assert.equal(
    hasPreparedHistoricalReopen({
      priorProjection: current,
      reviewPriorProjection: current,
    }),
    false,
  );
  assert.equal(
    hasPreparedHistoricalReopen({
      priorProjection: current,
      reviewPriorProjection: {
        open_findings: [
          ...current.open_findings,
          { stable_id: "HISTORICAL-002" },
        ],
      },
    }),
    true,
  );
});

test("a new or edited review refresh requires one model review", () => {
  const projectionCheck = {
    id: 20,
    started_at: "2026-07-27T10:04:00Z",
  };
  const editedRefresh = {
    id: 10,
    created_at: "2026-07-27T10:00:00Z",
    updated_at: "2026-07-27T10:05:00Z",
  };

  assert.equal(
    hasUnreviewedReviewRefresh({ latestReviewRefresh: editedRefresh }),
    true,
  );
  assert.equal(
    hasUnreviewedReviewRefresh({
      latestReviewRefresh: editedRefresh,
      latestProjectionCheck: projectionCheck,
    }),
    true,
  );
  assert.equal(
    hasUnreviewedReviewRefresh({
      latestReviewRefresh: {
        ...editedRefresh,
        updated_at: projectionCheck.started_at,
      },
      latestProjectionCheck: projectionCheck,
    }),
    true,
  );
  assert.equal(
    hasUnreviewedReviewRefresh({
      latestReviewRefresh: {
        ...editedRefresh,
        updated_at: "2026-07-27T10:03:00Z",
      },
      latestProjectionCheck: projectionCheck,
    }),
    false,
  );
  assert.equal(
    hasUnreviewedReviewRefresh({
      latestReviewRefresh: editedRefresh,
      latestProjectionCheck: {
        ...projectionCheck,
        started_at: "2026-07-27T10:06:00Z",
      },
    }),
    false,
  );
  assert.equal(
    hasUnreviewedReviewRefresh({ latestProjectionCheck: projectionCheck }),
    false,
  );
});

test("a human decision requires one model review after its latest projection", () => {
  const priorDecision = { comment_id: 10 };
  const newDecision = { comment_id: 20 };
  const priorProjection = { human_decisions: [priorDecision] };

  assert.equal(
    hasUnreviewedHumanDecision({
      priorProjection,
      humanDecisions: [priorDecision],
    }),
    false,
  );
  assert.equal(
    hasUnreviewedHumanDecision({
      priorProjection,
      humanDecisions: [priorDecision, newDecision],
    }),
    true,
  );
  assert.equal(
    hasUnreviewedHumanDecision({ humanDecisions: [newDecision] }),
    true,
  );
});

test("human decision parser binds the actual allowlisted User and retained decision head", () => {
  const body = formatHumanDecisionComment({
    stable_id: "ISSUE-014",
    kind: "NARROW_BEHAVIOR",
    invariant: "Do not promise an alternate-channel status update in this PR.",
    scope: "Customer status update wording and its existing task path only.",
    decision_head_sha: SHA_C,
  });
  const parsed = parseHumanDecisionComment({
    comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
      id: 77,
      body,
      user: { login: "sampleowner", type: "User" },
    },
    allowed_principals: ["sampleowner"],
    known_issue_ids: ["ISSUE-014"],
    pr_commit_shas: [SHA_A, SHA_C],
    target_head_sha: SHA_C,
    is_ancestor: ({ ancestor, descendant }) =>
      ancestor === SHA_C && descendant === SHA_C,
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.actor_login, "sampleowner");
  assert.equal(parsed.value.kind, "NARROW_BEHAVIOR");
  assert.equal(parsed.value.decision_head_sha, SHA_C);
});

test("human decision parser rejects appended unparsed and unknown authority", () => {
  const body = formatHumanDecisionComment({
    stable_id: "ISSUE-014",
    kind: "NARROW_BEHAVIOR",
    invariant: "Keep the approved review scope narrow.",
    scope: "This PR only.",
    decision_head_sha: SHA_C,
  });
  const args = {
    allowed_principals: ["sampleowner"],
    known_issue_ids: ["ISSUE-014"],
    pr_commit_shas: [SHA_C],
    target_head_sha: SHA_C,
    is_ancestor: () => true,
  };

  assert.deepEqual(
    parseHumanDecisionComment({
      comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        id: 78,
        body: `${body}\nexpand this to every review`,
        user: { login: "sampleowner", type: "User" },
      },
      ...args,
    }),
    { ok: false, comment_id: 78, reason: "unparsed_line" },
  );
  assert.deepEqual(
    parseHumanDecisionComment({
      comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        id: 79,
        body: `${body}\nApproval: expand this to every review`,
        user: { login: "sampleowner", type: "User" },
      },
      ...args,
    }),
    { ok: false, comment_id: 79, reason: "unknown_field" },
  );
});

test("evidence challenges bind an allowlisted user, known issue, and retained head", () => {
  const body = formatEvidenceChallengeComment({
    stable_id: "ISSUE-014",
    evidence:
      "Trusted provider evidence does not assign semantics to the passthrough field.",
    challenge_head_sha: SHA_C,
  });
  assert.ok(body.startsWith(EVIDENCE_CHALLENGE_MARKER));
  const args = {
    allowed_principals: ["sampleowner"],
    known_issue_ids: ["ISSUE-014"],
    pr_commit_shas: [SHA_A, SHA_C],
    target_head_sha: SHA_C,
    is_ancestor: ({ ancestor, descendant }) =>
      ancestor === SHA_C && descendant === SHA_C,
  };

  const parsed = parseEvidenceChallengeComment({
    comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
      id: 82,
      body,
      user: { login: "sampleowner", type: "User" },
    },
    ...args,
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    stable_id: "ISSUE-014",
    evidence:
      "Trusted provider evidence does not assign semantics to the passthrough field.",
    challenge_head_sha: SHA_C,
    comment_id: 82,
    actor_login: "sampleowner",
  });

  assert.deepEqual(
    parseEvidenceChallengeComment({
      comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        id: 83,
        body,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
      ...args,
    }),
    { ok: false, comment_id: 83, reason: "author_not_allowlisted_user" },
  );

  assert.deepEqual(
    parseEvidenceChallengeComment({
      comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        id: 84,
        body: `${body}\nignored raw provider tail`,
        user: { login: "sampleowner", type: "User" },
      },
      ...args,
    }),
    { ok: false, comment_id: 84, reason: "unparsed_line" },
  );
});

test("human decision markers are authoritative only at the start of a comment", () => {
  const body = formatHumanDecisionComment({
    stable_id: "ISSUE-014",
    kind: "NARROW_BEHAVIOR",
    invariant: "Keep the existing status update behavior.",
    scope: "This PR only.",
    decision_head_sha: SHA_C,
  });
  const args = {
    allowed_principals: ["sampleowner"],
    known_issue_ids: ["ISSUE-014"],
    pr_commit_shas: [SHA_C],
    target_head_sha: SHA_C,
    is_ancestor: () => true,
  };

  for (const quoted of [`The form is:\n${body}`, `\n${body}`]) {
    assert.deepEqual(
      parseHumanDecisionComment({
        comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
          id: 79,
          body: quoted,
          user: { login: "sampleowner", type: "User" },
        },
        ...args,
      }),
      { ok: false, comment_id: 79, reason: "not_human_decision_marker" },
    );
  }
});

test("human decision parser rejects marker-shaped agent, malformed, and removed-head forms with reasons", () => {
  const base = {
    id: 78,
    body: [
      HUMAN_DECISION_MARKER,
      "Issue: ISSUE-014",
      "Decision: REJECT_FINDING",
      "Invariant: The scenario is unreachable.",
      "Scope: This PR only.",
      `Decision head: ${SHA_B}`,
    ].join("\n"),
    user: { login: "github-actions[bot]", type: "Bot" },
  };
  const args = {
    allowed_principals: ["sampleowner"],
    known_issue_ids: ["ISSUE-014"],
    pr_commit_shas: [SHA_C],
    target_head_sha: SHA_C,
    is_ancestor: () => false,
  };

  assert.deepEqual(parseHumanDecisionComment({ comment: base, ...args }), {
    ok: false,
    comment_id: 78,
    reason: "author_not_allowlisted_user",
  });

  const removed = parseHumanDecisionComment({
    comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z", ...base, user: { login: "sampleowner", type: "User" } },
    ...args,
  });
  assert.equal(removed.ok, false);
  assert.equal(removed.reason, "reject_finding_requires_evidence");
});

test("only the sample owner can approve framework evolution", () => {
  const body = formatHumanDecisionComment({
    stable_id: "ISSUE-014",
    kind: "EVOLVE_FRAMEWORK",
    invariant: "Use the approved status update seam across the framework.",
    scope: "The shared status update framework only.",
    decision_head_sha: SHA_C,
  });
  const args = {
    allowed_principals: ["sample-maintainer", "sample-contributor"],
    framework_principals: ["sample-maintainer"],
    known_issue_ids: ["ISSUE-014"],
    pr_commit_shas: [SHA_C],
    target_head_sha: SHA_C,
    is_ancestor: () => true,
  };

  assert.equal(
    parseHumanDecisionComment({
      comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        id: 80,
        body,
        user: { login: "sample-maintainer", type: "User" },
      },
      ...args,
    }).ok,
    true,
  );
  assert.deepEqual(
    parseHumanDecisionComment({
      comment: {
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:00:00Z",
        id: 81,
        body,
        user: { login: "sample-contributor", type: "User" },
      },
      ...args,
    }),
    {
      ok: false,
      comment_id: 81,
      reason: "framework_decision_requires_framework_owner",
    },
  );
});

async function emptyArrayPage() {
  return { data: [] };
}

function fakeGithub({
  moveOnFinalRead = false,
  baseSha = SHA_A,
  issueComments = [],
  reviews = [],
  reviewComments = [],
  reviewThreads = [],
  hostedProvenance = false,
  checkRuns = null,
  workflowRun = null,
  workflowJobs = null,
  workflowLog = null,
  commitShas = [SHA_C],
} = {}) {
  let pullReads = 0;
  const projectionRecords = issueComments.flatMap((comment) => {
    if (comment.user?.login !== "github-actions[bot]") return [];
    try {
      const body = String(comment.body || "");
      const projection = body.startsWith("<!-- codex-review:projection:v4 -->")
        ? parseProjectionComment({ body })
        : JSON.parse(body.match(/```json\s*\n([^]*?)\n```/)?.[1] || "null");
      return projection?.check_identity
        ? [{ commentId: comment.id, projection }]
        : [];
    } catch {
      return [];
    }
  });
  const hostedProjectionRecords = hostedProvenance ? projectionRecords : [];
  const hostedCheckRuns =
    checkRuns ??
    hostedProjectionRecords.map(({ projection }) => ({
      id: projection.check_identity.check_run_id,
      head_sha: projection.review_target.head_sha,
      check_suite: { id: projection.check_identity.check_suite_id },
      app: { slug: "github-actions" },
      name: "Review result", status: "completed", completed_at: "2026-09-26T12:00:00Z",
      conclusion: projection.conclusion === "pass" ? "success" : "failure",
    }));
  const hostedWorkflowRuns = workflowRun
    ? [workflowRun]
    : hostedProjectionRecords.map(({ projection }) => ({
        id: Number(projection.check_identity.workflow_run_id),
        event: "pull_request_target",
        status: "completed",
        path: ".github/workflows/code-review.yaml",
        head_sha: projection.review_target.head_sha,
        run_attempt: projection.check_identity.workflow_run_attempt,
        check_suite_id: projection.check_identity.check_suite_id,
        repository: { id: REPOSITORY_ID, full_name: "example-org/sample-app" },
        pull_requests: [
          {
            number: 42,
            head: { repo: { id: REPOSITORY_ID, name: "sample-app" } },
            base: { repo: { id: REPOSITORY_ID, name: "sample-app" } },
          },
        ],
      }));
  const hostedWorkflowJobs =
    workflowJobs ??
    hostedProjectionRecords.map(({ projection }) => ({
      id: projection.check_identity.workflow_job_id,
      name: "Review result", status: "completed",
      run_id: Number(projection.check_identity.workflow_run_id),
      run_attempt: projection.check_identity.workflow_run_attempt,
      head_sha: projection.review_target.head_sha,
      check_run_url: `https://api.github.com/repos/example-org/sample-app/check-runs/${projection.check_identity.check_run_id}`,
    }));
  return {
    rest: {
      pulls: {
        get: async () => {
          pullReads += 1;
          return {
            data: {
              title: "Review contract",
              body: "Keep review authority narrow.",
              user: { login: "sampleowner", type: "User" },
              base: {
                ref: "main",
                sha: moveOnFinalRead && pullReads > 1 ? SHA_B : baseSha,
              },
              head: { sha: SHA_C },
            },
          };
        },
        listReviews: async () => ({ data: reviews }),
        listReviewComments: async () => ({ data: reviewComments }),
      },
      issues: {
        listComments: async () => ({
          data: issueComments.map((comment) => ({
            created_at: "2026-07-27T10:00:00Z",
            updated_at: "2026-07-27T10:00:00Z",
            ...comment,
          })),
        }),
      },
      checks: {
        listForRef: async () => ({
          data: {
            total_count: hostedCheckRuns.length,
            check_runs: hostedCheckRuns,
          },
        }),
      },
      actions: {
        getWorkflowRunAttempt: async ({
          run_id: runId,
          attempt_number: attemptNumber,
        }) => ({
          data: hostedWorkflowRuns.find(
            ({ id, run_attempt: runAttempt }) =>
              id === Number(runId) && runAttempt === attemptNumber,
          ),
        }),
        listJobsForWorkflowRunAttempt: async ({ run_id: runId }) => ({
          data: {
            total_count: hostedWorkflowJobs.length,
            jobs: hostedWorkflowJobs.filter(
              ({ run_id: candidateRunId }) => candidateRunId === Number(runId),
            ),
          },
        }),
      },
      repos: { listCommitStatusesForRef: emptyArrayPage },
    },
    listCommitPage: async () => ({
      nodes: commitShas.map((sha) => ({
        commit: {
          oid: sha,
          committedDate: "2026-07-27T09:00:00Z",
          messageHeadline: "Implement review core",
        },
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
    listReviewThreadPage: async () => ({
      nodes: reviewThreads,
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
    loadWorkflowRunLog: async ({ runId, attemptNumber }) => {
      if (typeof workflowLog === "function")
        return workflowLog({ runId, attemptNumber });
      if (workflowLog !== null) return workflowLog;
      return hostedProjectionRecords
        .filter(
          ({ projection }) =>
            Number(projection.check_identity.workflow_run_id) === runId &&
            projection.check_identity.workflow_run_attempt === attemptNumber,
        )
        .flatMap(({ commentId, projection }) => [
          `TRUSTED_WORKFLOW_SHA: ${projection.check_identity.trusted_workflow_sha}`,
          projection.schema_version === 4
            ? `[codex-review] Published additive projection comment ${commentId} with projection SHA-256 ${projection.projection_sha256}.`
            : `[codex-review] Published additive projection comment ${commentId}.`,
        ])
        .join("\n");
    },
  };
}

function findingForTarget({ target, decisionRef = null }) {
  return {
    stable_id: "ISSUE-LEGACY-001",
    severity: "P1",
    disposition: "FIX_IN_PR",
    autonomous_eligibility: decisionRef ? "NO" : "YES",
    title: "Legacy provider result can be reported as successful",
    failure_scenario:
      "The provider rejects the write but the customer receives a success confirmation.",
    approved_invariant: decisionRef
      ? "Report the provider result truthfully within the existing tool boundary."
      : "A rejected provider action must return a truthful failure.",
    where: "src/platform/provider-tool.cjs:42",
    evidence:
      "The tool converts a rejected provider result into a success response.",
    first_evidence_sha: target.head_sha,
    last_evaluated_target: hashReviewTarget(target),
    affected_lifecycle_planes: ["tools_live_state", "provider_action"],
    decision_ref: decisionRef,
    follow_up: null,
  };
}

function currentFindingForTarget({ target, stableId, decisionRef = null }) {
  return {
    ...findingForTarget({ target, decisionRef }),
    stable_id: stableId,
    reachability: "normal_path",
    likelihood: "medium",
    likely_consequence: "The provider result is reported incorrectly.",
    worst_credible_consequence:
      "The customer relies on a provider change that was not persisted.",
    recoverability: "operational_intervention",
    proof_strength: "deterministic_static_proof",
    attribution: "introduced",
    risk_rationale:
      "The normal provider path can misreport an external write result.",
  };
}

function formatCurrentProjectionComment({ target, findings, humanDecisions = [] }) {
  const identity = v4ProjectionForTarget({ target }).check_identity;
  return formatProjectionComment({ projection: buildProjection({
    candidate: { open_findings: findings, closed_findings: [], prior_issue_evaluations: [] },
    target, humanDecisions, checkIdentity: identity, summaryCommentId: 99,
  }) });
}

function v4ProjectionForTarget({
  target,
  workflowRunId = "12345",
  workflowJobId = 10,
  checkRunId = 11,
  checkSuiteId = 12,
  summaryCommentId = 99,
}) {
  return buildProjection({
    candidate: buildMechanicalCandidate({
      priorProjection: null,
      target,
      reason: "No behavior changed.",
    }),
    target,
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: target.trusted_reviewer_ref,
      workflow_run_id: workflowRunId,
      workflow_run_attempt: 1,
      workflow_job_id: workflowJobId,
      check_run_id: checkRunId,
      check_suite_id: checkSuiteId,
      app_slug: "github-actions",
      head_sha: target.head_sha,
    },
    summaryCommentId,
  });
}

function v4ProjectionWithClosedDecision({ target, decision }) {
  const closedFinding = currentFindingForTarget({
    target,
    stableId: decision.stable_id,
    decisionRef: `github-comment:${decision.comment_id}`,
  });
  return buildProjection({
    candidate: {
      open_findings: [],
      prior_issue_evaluations: [
        {
          stable_id: decision.stable_id,
          result: "resolved_on_target",
          evidence: "The reviewed target removed the original failure.",
          finding: closedFinding,
        },
      ],
      closed_findings: [
        {
          finding: closedFinding,
          closure: {
            result: "resolved_on_target",
            evidence: "The reviewed target removed the original failure.",
          },
        },
      ],
    },
    target,
    humanDecisions: [decision],
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: SHA_D,
      workflow_run_id: "12345",
      workflow_run_attempt: 1,
      workflow_job_id: 10,
      check_run_id: 11,
      check_suite_id: 12,
      app_slug: "github-actions",
      head_sha: target.head_sha,
    },
    summaryCommentId: 99,
  });
}

test("collectEvidenceBundle returns one deterministic fail-closed hosted/local contract", async () => {
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub(),
    git: { mergeBase: async () => SHA_B },
    clock: () => "2026-07-27T10:00:00Z",
    changedPaths: ["src/app/orders/status-update.ts"],
    additionalArtifacts: { "pr-diff.patch": "diff --git a/x b/x\n" },
    sleep: async () => {},
  });

  assert.equal(bundle.target.base_sha, SHA_A);
  assert.equal(bundle.target.merge_base_sha, SHA_B);
  assert.equal(bundle.target.trusted_reviewer_ref, SHA_D);
  assert.equal(bundle.target.evidence_schema_version, 2);
  assert.equal(bundle.evidence.schema_version, 2);
  assert.deepEqual(bundle.evidence.evidence_challenges, []);
  assert.equal(bundle.reviewTargetHash, hashCanonical(bundle.target));
  assert.equal(bundle.reviewPriorProjection, null);
  assert.equal(bundle.modelReviewRequired, false);
  assert.deepEqual(
    JSON.parse(bundle.files["pr-evidence.json"]).reserved_finding_ids,
    [],
  );
  assert.deepEqual(Object.keys(bundle.files).toSorted(), [
    "manifest.json",
    "pr-diff.patch",
    "pr-evidence.json",
    "trusted-thread-context.md",
  ]);
  for (const artifact of bundle.manifest.artifact_hashes) {
    assert.equal(
      hashBytes(Buffer.from(bundle.files[artifact.name], "utf8")),
      artifact.sha256,
    );
  }
  assert.match(
    bundle.files["trusted-thread-context.md"],
    /Non-authoritative discussion context/,
  );
});

test("prior projection collection ignores obsolete shapes and keeps the newest valid projection", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const candidate = buildMechanicalCandidate({
    priorProjection: null,
    target: reviewTarget,
    reason: "No voice-agent behavior changed.",
  });
  candidate.open_findings = [
    {
      stable_id: "ISSUE-014",
      severity: "P2",
      reachability: "normal_path",
      likelihood: "medium",
      likely_consequence:
        "The provider response is interpreted with unsupported semantics.",
      worst_credible_consequence:
        "The workflow reports an incorrect provider confirmation.",
      recoverability: "operational_intervention",
      proof_strength: "deterministic_static_proof",
      attribution: "introduced",
      risk_rationale:
        "The normal-path provider interpretation requires evidence before merge.",
      disposition: "FIX_IN_PR",
      autonomous_eligibility: "YES",
      title: "Unsupported provider-field interpretation",
      failure_scenario:
        "An undocumented provider field is treated as authoritative.",
      approved_invariant: "Only evidenced provider fields decide confirmation.",
      where: "src/platform/provider.ts:42",
      evidence: "The parser reads an undocumented passthrough field.",
      first_evidence_sha: SHA_C,
      last_evaluated_target: hashReviewTarget(reviewTarget),
      affected_lifecycle_planes: ["provider_action"],
      decision_ref: null,
      follow_up: null,
    },
  ];
  const projection = buildProjection({
    candidate,
    target: reviewTarget,
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: SHA_D,
      workflow_run_id: "12345",
      workflow_run_attempt: 1,
      workflow_job_id: 10,
      check_run_id: 11,
      check_suite_id: 12,
      app_slug: "github-actions",
      head_sha: SHA_C,
    },
    summaryCommentId: 99,
  });
  const obsolete = [
    "<!-- codex-review:projection:v2 -->",
    "```json",
    '{"schema_version":2}',
    "```",
  ].join("\n");
  const validLegacy = obsolete;
  const bot = { login: "github-actions[bot]", type: "Bot" };
  const challengeBody = formatEvidenceChallengeComment({
    stable_id: "ISSUE-014",
    evidence: "No trusted endpoint evidence assigns that field semantics.",
    challenge_head_sha: SHA_C,
  });
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        { id: 1, body: validLegacy, user: bot },
        { id: 20, body: formatProjectionComment({ projection }), user: bot },
        { id: 3, body: obsolete, user: bot },
        {
          id: 4,
          body: challengeBody,
          user: { login: "sample-maintainer", type: "User" },
        },
        {
          id: 5,
          body: `${challengeBody}\nignored raw provider tail`,
          user: { login: "sample-maintainer", type: "User" },
        },
      ],
    }),
    git: { mergeBase: async () => SHA_B },
    clock: () => "2026-07-27T10:00:00Z",
    allowedDecisionPrincipals: ["sample-maintainer", "sample-contributor"],
    frameworkDecisionPrincipals: ["sample-maintainer"],
    sleep: async () => {},
  });

  assert.equal(bundle.priorProjection.projection_id, projection.projection_id);
  assert.deepEqual(bundle.reviewPriorProjection, {
    open_findings: projection.open_findings,
  });
  assert.equal(bundle.modelReviewRequired, true);
  assert.deepEqual(
    bundle.evidence.prior_projections.map(({ comment_id }) => comment_id),
    [20],
  );
  assert.deepEqual(bundle.evidence.rejected_records, [
    { ok: false, comment_id: 5, reason: "unparsed_line" },
  ]);
  assert.deepEqual(bundle.evidence.evidence_challenges, [
    {
      stable_id: "ISSUE-014",
      evidence: "No trusted endpoint evidence assigns that field semantics.",
      challenge_head_sha: SHA_C,
      comment_id: 4,
      actor_login: "sample-maintainer",
    },
  ]);
  assert.match(
    bundle.trustedThreadContext,
    /Authenticated evidence challenges/,
  );
  assert.doesNotMatch(bundle.trustedThreadContext, /ignored raw provider tail/);

  const pendingModelEvidence = JSON.parse(bundle.files["pr-evidence.json"]);
  assert.equal(pendingModelEvidence.evidence_challenges.length, 1);
  assert.deepEqual(pendingModelEvidence.consumed_evidence_challenge_refs, []);

  const consumedProjection = buildProjection({
    candidate: {
      ...candidate,
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-014",
          result: "still_open",
          challenge_ref: "github-comment:4",
          finding: candidate.open_findings[0],
        },
      ],
      consumed_evidence_challenge_refs: ["github-comment:4"],
    },
    target: reviewTarget,
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: SHA_D,
      workflow_run_id: "12346",
      workflow_run_attempt: 1,
      workflow_job_id: 20,
      check_run_id: 21,
      check_suite_id: 22,
      app_slug: "github-actions",
      head_sha: SHA_C,
    },
    summaryCommentId: 199,
  });
  const latestProjection = buildProjection({
    candidate: {
      ...candidate,
      consumed_evidence_challenge_refs: ["github-comment:4"],
    },
    target: reviewTarget,
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: SHA_D,
      workflow_run_id: "12347",
      workflow_run_attempt: 1,
      workflow_job_id: 30,
      check_run_id: 31,
      check_suite_id: 32,
      app_slug: "github-actions",
      head_sha: SHA_C,
    },
    summaryCommentId: 299,
  });
  const consumedBundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        {
          id: 20,
          body: formatProjectionComment({ projection: consumedProjection }),
          user: bot,
        },
        {
          id: 30,
          body: formatProjectionComment({ projection: latestProjection }),
          user: bot,
        },
        {
          id: 4,
          body: challengeBody,
          user: { login: "sample-maintainer", type: "User" },
        },
      ],
    }),
    git: { mergeBase: async () => SHA_B },
    clock: () => "2026-07-27T11:00:00Z",
    allowedDecisionPrincipals: ["sample-maintainer", "sample-contributor"],
    frameworkDecisionPrincipals: ["sample-maintainer"],
    sleep: async () => {},
  });
  const consumedModelEvidence = JSON.parse(
    consumedBundle.files["pr-evidence.json"],
  );

  assert.equal(consumedBundle.evidence.evidence_challenges.length, 1);
  assert.deepEqual(consumedModelEvidence.evidence_challenges, []);
  assert.deepEqual(consumedModelEvidence.consumed_evidence_challenge_refs, [
    "github-comment:4",
  ]);
  assert.doesNotMatch(
    consumedBundle.trustedThreadContext,
    /No trusted endpoint evidence assigns that field semantics/,
  );
});






test("a valid v4 projection binds its comment ID and hash to the hosted run log", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const projection = v4ProjectionForTarget({ target: reviewTarget });
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        {
          id: 100,
          body: formatProjectionComment({ projection }),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
      ],
    }),
    git: { mergeBase: async () => SHA_B },
    sleep: async () => {},
  });

  assert.equal(
    bundle.priorProjection.projection_sha256,
    projection.projection_sha256,
  );
});

test("a canonical v4 projection does not depend on superseded workflow logs", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const supersededProjection = v4ProjectionForTarget({ target: reviewTarget });
  const canonicalProjection = v4ProjectionForTarget({
    target: reviewTarget,
    workflowRunId: "22345",
    workflowJobId: 20,
    checkRunId: 21,
    checkSuiteId: 22,
    summaryCommentId: 199,
  });
  const requestedRunIds = [];
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        {
          id: 100,
          body: formatProjectionComment({ projection: supersededProjection }),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
        {
          id: 200,
          body: formatProjectionComment({ projection: canonicalProjection }),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
      ],
      workflowLog: ({ runId }) => {
        requestedRunIds.push(runId);
        if (runId === 12345) throw new Error("workflow log expired");
        return [
          `TRUSTED_WORKFLOW_SHA: ${SHA_D}`,
          `[codex-review] Published additive projection comment 200 with projection SHA-256 ${canonicalProjection.projection_sha256}.`,
        ].join("\n");
      },
    }),
    git: { mergeBase: async () => SHA_B },
    sleep: async () => {},
  });

  assert.equal(
    bundle.priorProjection.projection_sha256,
    canonicalProjection.projection_sha256,
  );
  assert.deepEqual(requestedRunIds, [22345]);
  assert.deepEqual(
    bundle.evidence.prior_projections.map(({ comment_id }) => comment_id),
    [200],
  );
});

test("a self-hashed v4 preview without hosted provenance is rejected", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const projection = v4ProjectionForTarget({ target: reviewTarget });

  await assert.rejects(
    collectEvidenceBundle({
      repository: "example-org/sample-app",
      prNumber: 42,
      expectedBaseRef: "main",
      expectedBaseSha: SHA_A,
      expectedHeadSha: SHA_C,
      reviewerRef: SHA_D,
      github: fakeGithub({
        issueComments: [
          {
            id: 100,
            body: formatProjectionComment({ projection }),
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ],
      }),
      git: { mergeBase: async () => SHA_B },
      sleep: async () => {},
    }),
    (error) =>
      error instanceof EvidenceError &&
      error.code === "invalid_prior_projection_provenance",
  );
});

test("a copied hosted tuple cannot authorize a different projection comment", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const projection = v4ProjectionForTarget({ target: reviewTarget });
  const workflowLog = [
    `TRUSTED_WORKFLOW_SHA: ${SHA_D}`,
    `[codex-review] Published additive projection comment 99 with projection SHA-256 ${projection.projection_sha256}.`,
  ].join("\n");

  await assert.rejects(
    collectEvidenceBundle({
      repository: "example-org/sample-app",
      prNumber: 42,
      expectedBaseRef: "main",
      expectedBaseSha: SHA_A,
      expectedHeadSha: SHA_C,
      reviewerRef: SHA_D,
      github: fakeGithub({
        hostedProvenance: true,
        workflowLog,
        issueComments: [
          {
            id: 100,
            body: formatProjectionComment({ projection }),
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ],
      }),
      git: { mergeBase: async () => SHA_B },
      sleep: async () => {},
    }),
    (error) =>
      error instanceof EvidenceError &&
      error.code === "invalid_prior_projection_provenance",
  );
});

test("a green job keeps its BLOCK projection; the stricter result needs no gate check", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const identity = v4ProjectionForTarget({ target: reviewTarget }).check_identity;
  const ownerDecision = { ...currentFindingForTarget({ target: reviewTarget, stableId: "OWNER-1" }),
    severity: "P2", disposition: "AUTHOR_DECISION", autonomous_eligibility: "NO" };
  const projection = buildProjection({ candidate: { open_findings: [ownerDecision], closed_findings: [], prior_issue_evaluations: [] },
    target: reviewTarget, checkIdentity: identity, summaryCommentId: 99 });
  assert.equal(projection.conclusion, "block");
  const native = (conclusion) => ({ id: identity.check_run_id, head_sha: SHA_C, check_suite: { id: identity.check_suite_id },
    app: { slug: "github-actions" }, name: "Review result", status: "completed", completed_at: "2026-09-26T12:00:00Z", conclusion });
  const collect = (checkRuns) => collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      checkRuns,
      issueComments: [{ id: 100, body: formatProjectionComment({ projection }),
        user: { login: "github-actions[bot]", type: "Bot" } }],
    }),
    git: { mergeBase: async () => SHA_B },
    sleep: async () => {},
  });
  const provenance = (error) => error instanceof EvidenceError && error.code === "invalid_prior_projection_provenance";
  assert.equal((await collect([native("success")])).priorProjection.projection_id, projection.projection_id);
  assert.equal((await collect([native("failure")])).priorProjection.projection_id, projection.projection_id);
  for (const conclusion of ["neutral", "skipped", "timed_out", "action_required"])
    await assert.rejects(collect([native(conclusion)]), provenance);
  // The unsafe direction still fails closed: a PASS projection from a job that did not succeed.
  const passing = v4ProjectionForTarget({ target: reviewTarget });
  assert.equal(passing.conclusion, "pass");
  const collectPassing = (checkRuns) => collectEvidenceBundle({
    repository: "example-org/sample-app", prNumber: 42, expectedBaseRef: "main", expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C, reviewerRef: SHA_D,
    github: fakeGithub({ hostedProvenance: true, checkRuns, issueComments: [{ id: 100,
      body: formatProjectionComment({ projection: passing }), user: { login: "github-actions[bot]", type: "Bot" } }] }),
    git: { mergeBase: async () => SHA_B }, sleep: async () => {},
  });
  await assert.rejects(collectPassing([native("failure")]), provenance);
});

test("a job cancelled after it published keeps its projection only when its own review check carries the gate", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const projection = v4ProjectionForTarget({ target: reviewTarget });
  const identity = projection.check_identity;
  const pass = projection.conclusion === "pass";
  const native = (conclusion) => ({ id: identity.check_run_id, head_sha: SHA_C, check_suite: { id: identity.check_suite_id },
    app: { slug: "github-actions" }, name: "Review result", status: "completed", completed_at: "2026-09-26T12:00:00Z", conclusion });
  const gate = (overrides = {}) => ({ id: identity.check_run_id + 1, head_sha: SHA_C, check_suite: { id: identity.check_suite_id },
    app: { slug: "github-actions" }, name: "Open Review", status: "completed", completed_at: "2026-09-26T12:00:00Z",
    conclusion: pass ? "success" : "failure", output: { title: `Codex Review Pass 1: ${pass ? "PASS" : "BLOCK"}` }, ...overrides });
  const collect = (checkRuns, workflowLog = null) => collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      workflowLog,
      checkRuns,
      issueComments: [{ id: 100, body: formatProjectionComment({ projection }),
        user: { login: "github-actions[bot]", type: "Bot" } }],
    }),
    git: { mergeBase: async () => SHA_B },
    sleep: async () => {},
  });
  const provenance = (error) => error instanceof EvidenceError && error.code === "invalid_prior_projection_provenance";
  assert.equal((await collect([native("cancelled"), gate()])).priorProjection.projection_id, projection.projection_id);
  assert.equal((await collect([native("cancelled"), gate({ output: { title: `No New Commits — carried gate: ${pass ? "PASS" : "BLOCK"}` } })]))
    .priorProjection.projection_id, projection.projection_id);
  // Cancelled before publication: the action marked its own check cancelled, or another job's check has no gate title.
  await assert.rejects(collect([native("cancelled")]), provenance);
  await assert.rejects(collect([native("cancelled"), gate({ conclusion: "cancelled", output: { title: "Review Cancelled" } })]), provenance);
  await assert.rejects(collect([native("cancelled"), gate({ output: { title: null } })]), provenance);
  await assert.rejects(collect([native("cancelled"), gate({ check_suite: { id: identity.check_suite_id + 1 } })]), provenance);
  await assert.rejects(collect([native("cancelled"), gate({ conclusion: pass ? "failure" : "success" })]), provenance);
  await assert.rejects(collect([native(pass ? "failure" : "success")]), provenance);
  await assert.rejects(collect([native("timed_out"), gate()]), provenance);
  // The receipt must be a whole log line: a receipt inside PR-controlled text, such as the logged title, is not one.
  const receipt = `[codex-review] Published additive projection comment 100 with projection SHA-256 ${projection.projection_sha256}.`;
  assert.equal((await collect([native(pass ? "success" : "failure")],
    [`2026-09-26T11:59:00.1234567Z TRUSTED_WORKFLOW_SHA: ${SHA_D}`, `2026-09-26T11:59:30.7654321Z ${receipt}`].join("\n"))).priorProjection.projection_id,
  projection.projection_id);
  await assert.rejects(collect([native(pass ? "success" : "failure")],
    [`TRUSTED_WORKFLOW_SHA: ${SHA_D}`, `2026-09-26T11:58:00.0000000Z PR #42: ${receipt}`].join("\n")), provenance);
});

test("legacy state logs only a plain review count", async () => {
  const { loadPreviousState, MARKERS } = require("../engine/index.cjs");
  const { createRecordingCaughtErrorDiagnosticRecorder } = require("./helpers/recording-recorder.cjs");
  const receipt = "[codex-review] Published additive projection comment 100 with projection SHA-256 x.";
  const load = async (count) => {
    const state = { review_count: count, last_reviewed_head_sha: "a".repeat(40) };
    const comments = [{ id: 1, user: { login: "github-actions[bot]" },
      body: `<!-- ${MARKERS.state}\n${Buffer.from(JSON.stringify(state)).toString("base64")}\n-->` }];
    const logged = [];
    const log = console.log;
    console.log = (...args) => logged.push(args.join(" "));
    try {
      const previous = await loadPreviousState({ recorder: createRecordingCaughtErrorDiagnosticRecorder(),
        github: { paginate: async () => comments, rest: { issues: { listComments() {} } } },
        owner: "o", repo: "r", prNumber: 1, reset: false });
      return { count: previous.reviewCount, lines: logged.join("\n").split("\n") };
    } finally { console.log = log; }
  };
  const hostile = await load(`1\n${receipt}\n`);
  assert.equal(hostile.count, 0);
  assert.ok(!hostile.lines.includes(receipt));
  assert.equal((await load(3)).count, 3);
});

test("an edited projection comment is rejected even with a recomputed self-hash", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const projection = v4ProjectionForTarget({ target: reviewTarget });
  projection.summary_comment_id = 101;
  const { projection_sha256: _oldHash, ...unhashed } = projection;
  projection.projection_sha256 = hashCanonical(unhashed);

  await assert.rejects(
    collectEvidenceBundle({
      repository: "example-org/sample-app",
      prNumber: 42,
      expectedBaseRef: "main",
      expectedBaseSha: SHA_A,
      expectedHeadSha: SHA_C,
      reviewerRef: SHA_D,
      github: fakeGithub({
        hostedProvenance: true,
        issueComments: [
          {
            id: 100,
            body: formatProjectionComment({ projection }),
            created_at: "2026-07-27T10:00:00Z",
            updated_at: "2026-07-27T10:05:00Z",
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ],
      }),
      git: { mergeBase: async () => SHA_B },
      sleep: async () => {},
    }),
    (error) =>
      error instanceof EvidenceError &&
      error.code === "invalid_prior_projection_provenance",
  );
});




test("a v4 run revalidates a retained decision for a closed migration finding", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const decision = {
    stable_id: "ISSUE-LEGACY-CLOSED",
    kind: "REJECT_FINDING",
    invariant: "The unsupported migration finding remains closed.",
    scope: "The migrated finding only.",
    evidence: "Trusted evidence disproved the original premise.",
    tracker: null,
    owner_or_triage: null,
    decision_head_sha: SHA_C,
    comment_id: 501,
    actor_login: "sample-maintainer",
  };
  const projection = buildProjection({
    candidate: (() => {
      const closedFinding = currentFindingForTarget({
        target: reviewTarget,
        stableId: decision.stable_id,
        decisionRef: "github-comment:501",
      });
      return {
        open_findings: [],
        prior_issue_evaluations: [
          {
            stable_id: decision.stable_id,
            result: "resolved_on_target",
            evidence: "The reviewed migration target has no matching failure.",
            finding: closedFinding,
          },
        ],
        closed_findings: [
          {
            finding: closedFinding,
            closure: {
              result: "resolved_on_target",
              evidence:
                "The reviewed migration target has no matching failure.",
            },
          },
        ],
      };
    })(),
    target: reviewTarget,
    humanDecisions: [decision],
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: SHA_D,
      workflow_run_id: "12345",
      workflow_run_attempt: 1,
      workflow_job_id: 10,
      check_run_id: 11,
      check_suite_id: 12,
      app_slug: "github-actions",
      head_sha: SHA_C,
    },
    summaryCommentId: 99,
  });
  const decisionBody = formatHumanDecisionComment({
    stable_id: decision.stable_id,
    kind: decision.kind,
    invariant: decision.invariant,
    scope: decision.scope,
    evidence: decision.evidence,
    decision_head_sha: decision.decision_head_sha,
  });
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        {
          id: 100,
          body: formatProjectionComment({ projection }),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
        {
          id: 501,
          body: decisionBody,
          user: { login: "sample-maintainer", type: "User" },
        },
      ],
    }),
    git: {
      mergeBase: async ({ base_sha: baseSha, head_sha: headSha }) =>
        baseSha === SHA_C && headSha === SHA_C ? SHA_C : SHA_B,
    },
    clock: () => "2026-08-02T12:00:00Z",
    allowedDecisionPrincipals: ["sample-maintainer"],
    sleep: async () => {},
  });

  assert.equal(bundle.priorProjection.schema_version, 4);
  assert.deepEqual(bundle.priorProjection.open_findings, []);
  assert.deepEqual(bundle.humanDecisions, [decision]);
  assert.deepEqual(bundle.rejectedRecords, []);
  assert.deepEqual(
    JSON.parse(bundle.files["pr-evidence.json"]).reserved_finding_ids,
    [decision.stable_id],
  );
});

test("a retained decision stays valid after its decision head enters the current base", async () => {
  const priorTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_B,
    merge_base_sha: SHA_B,
    head_sha: SHA_A,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const decision = {
    stable_id: "ISSUE-BASE-ADVANCED",
    kind: "EVOLVE_FRAMEWORK",
    invariant: "Keep the approved review boundary after the base advances.",
    scope: "The trusted review evidence collector only.",
    evidence: null,
    tracker: null,
    owner_or_triage: null,
    decision_head_sha: SHA_A,
    comment_id: 501,
    actor_login: "sample-maintainer",
  };
  const projection = v4ProjectionWithClosedDecision({
    target: priorTarget,
    decision,
  });
  const decisionBody = formatHumanDecisionComment({
    stable_id: decision.stable_id,
    kind: decision.kind,
    invariant: decision.invariant,
    scope: decision.scope,
    decision_head_sha: decision.decision_head_sha,
  });
  const collect = ({
    body = decisionBody,
    mergeBase,
    commitShas,
    baseSha = SHA_A,
  } = {}) =>
    collectEvidenceBundle({
      repository: "example-org/sample-app",
      prNumber: 42,
      expectedBaseRef: "main",
      expectedBaseSha: baseSha,
      expectedHeadSha: SHA_C,
      reviewerRef: SHA_D,
      github: fakeGithub({
        hostedProvenance: true,
        baseSha,
        commitShas,
        issueComments: [
          {
            id: 100,
            body: formatProjectionComment({ projection }),
            user: { login: "github-actions[bot]", type: "Bot" },
          },
          {
            id: decision.comment_id,
            body,
            user: { login: "sample-maintainer", type: "User" },
          },
        ],
      }),
      git: {
        mergeBase:
          mergeBase ??
          (async ({ base_sha: baseCommit, head_sha: headCommit }) =>
            baseCommit === SHA_A && [SHA_A, SHA_C].includes(headCommit)
              ? SHA_A
              : SHA_B),
      },
      clock: () => "2026-08-27T20:00:00Z",
      allowedDecisionPrincipals: ["sample-maintainer"],
      sleep: async () => {},
    });

  const bundle = await collect();
  assert.deepEqual(bundle.humanDecisions, [decision]);
  assert.deepEqual(bundle.rejectedRecords, []);

  const retained = await collect({ body: `${decisionBody}\n` });
  assert.deepEqual(retained.humanDecisions, [decision]);
  assert.deepEqual(retained.rejectedRecords, []);

  await assert.rejects(
    collect({
      body: formatHumanDecisionComment({
        stable_id: decision.stable_id,
        kind: decision.kind,
        invariant: "Changed after the retained projection.",
        scope: decision.scope,
        decision_head_sha: decision.decision_head_sha,
      }),
    }),
    (error) =>
      error instanceof EvidenceError &&
      error.code === "authoritative_record_changed" &&
      /501/.test(error.message),
  );

  await assert.rejects(
    collect({ body: `${decisionBody}\nApproval: expand the scope` }),
    (error) =>
      error instanceof EvidenceError &&
      error.code === "authoritative_record_changed" &&
      /501/.test(error.message),
  );

  await assert.rejects(
    collect({
      commitShas: [SHA_A, SHA_C],
      mergeBase: async ({ base_sha: baseSha, head_sha: headSha }) =>
        baseSha === SHA_A && headSha === SHA_A ? SHA_A : SHA_B,
    }),
    (error) =>
      error instanceof EvidenceError &&
      error.code === "authoritative_record_changed" &&
      /501/.test(error.message),
  );

  await assert.rejects(
    collect({
      baseSha: SHA_B,
      mergeBase: async ({ base_sha: baseCommit, head_sha: headCommit }) => {
        if (baseCommit === SHA_A && headCommit === SHA_C) return SHA_A;
        return SHA_B;
      },
    }),
    (error) =>
      error instanceof EvidenceError &&
      error.code === "authoritative_record_changed" &&
      /501/.test(error.message),
  );
});

test("a new decision cannot use a commit that exists only in the current base", async () => {
  const priorTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_B,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const stableId = "ISSUE-UNRETAINED-BASE-DECISION";
  const decisionBody = formatHumanDecisionComment({
    stable_id: stableId,
    kind: "NARROW_BEHAVIOR",
    invariant: "This new decision must remain rejected.",
    scope: "The current review only.",
    decision_head_sha: SHA_A,
  });
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        {
          id: 100,
          body: formatCurrentProjectionComment({
            target: priorTarget,
            findings: [currentFindingForTarget({ target: priorTarget, stableId })],
          }),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
        {
          id: 501,
          body: decisionBody,
          user: { login: "sample-maintainer", type: "User" },
        },
      ],
    }),
    git: { mergeBase: async () => SHA_A },
    clock: () => "2026-08-27T20:00:00Z",
    allowedDecisionPrincipals: ["sample-maintainer"],
    sleep: async () => {},
  });

  assert.deepEqual(bundle.humanDecisions, []);
  assert.deepEqual(bundle.rejectedRecords, [
    {
      ok: false,
      comment_id: 501,
      reason: "decision_head_not_in_pr_history",
    },
  ]);
});

test("a later v4 run accepts a decision for a closed decisionless finding", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const stableId = "ISSUE-LEGACY-DECISIONLESS";
  const closedFinding = currentFindingForTarget({
    target: reviewTarget,
    stableId,
  });
  const projection = buildProjection({
    candidate: {
      open_findings: [],
      prior_issue_evaluations: [
        {
          stable_id: stableId,
          result: "resolved_on_target",
          evidence: "The reviewed target removed the original failure.",
          finding: closedFinding,
        },
      ],
      closed_findings: [
        {
          finding: closedFinding,
          closure: {
            result: "resolved_on_target",
            evidence: "The reviewed target removed the original failure.",
          },
        },
      ],
    },
    target: reviewTarget,
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: SHA_D,
      workflow_run_id: "12345",
      workflow_run_attempt: 1,
      workflow_job_id: 10,
      check_run_id: 11,
      check_suite_id: 12,
      app_slug: "github-actions",
      head_sha: SHA_C,
    },
    summaryCommentId: 99,
  });
  const decisionBody = formatHumanDecisionComment({
    stable_id: stableId,
    kind: "REDESIGN_IN_PR",
    invariant: "Keep the corrected provider path within the approved seam.",
    scope: "The closed migration finding only.",
    decision_head_sha: SHA_C,
  });
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        {
          id: 100,
          body: formatProjectionComment({ projection }),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
        {
          id: 502,
          body: decisionBody,
          user: { login: "sample-maintainer", type: "User" },
        },
      ],
    }),
    git: { mergeBase: async () => SHA_B },
    clock: () => "2026-08-02T12:30:00Z",
    allowedDecisionPrincipals: ["sample-maintainer"],
    sleep: async () => {},
  });

  assert.equal(bundle.humanDecisions[0].stable_id, stableId);
  assert.equal(bundle.humanDecisions[0].kind, "REDESIGN_IN_PR");
  assert.equal(
    bundle.reviewPriorProjection.open_findings[0].stable_id,
    stableId,
  );
  assert.equal(
    bundle.reviewPriorProjection.open_findings[0].decision_ref,
    "github-comment:502",
  );
  assert.equal(bundle.modelReviewRequired, true);
  assert.deepEqual(bundle.rejectedRecords, []);
});


test("the sample contributor cannot supersede a sample owner framework decision with another decision kind", async () => {
  const reviewTarget = buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA_A,
    merge_base_sha: SHA_B,
    head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D,
    evidence_bundle_sha256: HASH_E,
    evidence_schema_version: 1,
  });
  const stableId = "ISSUE-014";
  const projection = buildProjection({
    candidate: {
      prior_issue_evaluations: [],
      open_findings: [
        {
          stable_id: stableId,
          severity: "P1",
          reachability: "normal_path",
          likelihood: "high",
          likely_consequence: "The shared status update behavior has no owner.",
          worst_credible_consequence:
            "Customers receive conflicting status update behavior.",
          recoverability: "operational_intervention",
          proof_strength: "deterministic_static_proof",
          attribution: "introduced",
          risk_rationale:
            "The framework choice needs a human decision before merge.",
          disposition: "AUTHOR_DECISION",
          autonomous_eligibility: "NO",
          title: "Choose the status update framework behavior",
          failure_scenario: "The shared status update behavior is not approved.",
          approved_invariant: "Only the sample owner approves framework evolution.",
          where: "The shared status update framework.",
          evidence: "The proposed change affects every status update customer.",
          first_evidence_sha: SHA_C,
          last_evaluated_target: hashReviewTarget(reviewTarget),
          affected_lifecycle_planes: ["proof"],
          decision_ref: null,
          follow_up: null,
        },
      ],
    },
    target: reviewTarget,
    checkIdentity: {
      workflow_path: ".github/workflows/code-review.yaml",
      workflow_ref: "refs/heads/main",
      trusted_workflow_sha: SHA_D,
      workflow_run_id: "12345",
      workflow_run_attempt: 1,
      workflow_job_id: 10,
      check_run_id: 11,
      check_suite_id: 12,
      app_slug: "github-actions",
      head_sha: SHA_C,
    },
    summaryCommentId: 99,
  });
  const decisionFields = {
    stable_id: stableId,
    invariant: "Only the sample owner approves framework evolution.",
    scope: "The shared status update framework only.",
    decision_head_sha: SHA_C,
  };
  const retainedContributorDecision = {
    ...decisionFields,
    kind: "NARROW_BEHAVIOR",
    evidence: null,
    tracker: null,
    owner_or_triage: null,
    comment_id: 2,
    actor_login: "sample-contributor",
  };
  projection.human_decisions = [retainedContributorDecision];
  const { projection_sha256: _oldHash, ...unhashedProjection } = projection;
  projection.projection_sha256 = hashCanonical(unhashedProjection);
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      hostedProvenance: true,
      issueComments: [
        {
          id: 1,
          body: formatProjectionComment({ projection }),
          user: { login: "github-actions[bot]", type: "Bot" },
        },
        {
          id: 2,
          body: formatHumanDecisionComment({
            ...decisionFields,
            kind: "NARROW_BEHAVIOR",
          }),
          user: { login: "sample-contributor", type: "User" },
        },
        {
          id: 3,
          body: formatHumanDecisionComment({
            ...decisionFields,
            kind: "EVOLVE_FRAMEWORK",
          }),
          user: { login: "sample-maintainer", type: "User" },
        },
        {
          id: 4,
          body: formatHumanDecisionComment({
            ...decisionFields,
            kind: "REJECT_FINDING",
            evidence: "the sample contributor believes the change is unnecessary.",
          }),
          user: { login: "sample-contributor", type: "User" },
        },
      ],
    }),
    git: {
      mergeBase: async ({ base_sha: baseSha, head_sha: headSha }) =>
        baseSha === SHA_C && headSha === SHA_C ? SHA_C : SHA_B,
    },
    clock: () => "2026-07-27T10:00:00Z",
    allowedDecisionPrincipals: ["sample-maintainer", "sample-contributor"],
    frameworkDecisionPrincipals: ["sample-maintainer"],
    sleep: async () => {},
  });

  assert.deepEqual(
    bundle.humanDecisions.map(({ comment_id }) => comment_id),
    [2, 3],
  );
  assert.deepEqual(bundle.rejectedRecords.at(-1), {
    ok: false,
    comment_id: 4,
    reason: "framework_issue_requires_framework_owner",
  });
});

test("model evidence redacts raw discussion bodies outside the bounded trusted context artifact", async () => {
  const issueBody = "excluded issue body";
  const untrustedBody = "untrusted issue body";
  const reviewBody = "excluded review body";
  const selectedBody = "selected review comment body";
  const threadOnlyBody = "thread-only untrusted body";
  const github = fakeGithub({
    issueComments: [
      {
        id: 1,
        body: issueBody,
        user: { login: "sampleowner", type: "User" },
      },
      {
        id: 2,
        body: untrustedBody,
        user: { login: "outsider", type: "User" },
      },
    ],
    reviews: [
      {
        id: 3,
        body: reviewBody,
        user: { login: "sampleowner", type: "User" },
      },
    ],
    reviewComments: [
      {
        id: 4,
        body: selectedBody,
        user: { login: "sampleowner", type: "User" },
      },
    ],
    reviewThreads: [
      {
        id: "thread-1",
        isResolved: false,
        isOutdated: false,
        path: "src/example.ts",
        comments: {
          nodes: [
            {
              databaseId: 4,
              body: selectedBody,
              author: { login: "sampleowner", __typename: "User" },
            },
            {
              databaseId: 5,
              body: threadOnlyBody,
              author: { login: "outsider", __typename: "User" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ],
  });
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github,
    git: { mergeBase: async () => SHA_B },
    clock: () => "2026-07-27T10:00:00Z",
    allowedDecisionPrincipals: ["sampleowner"],
    contextLimits: { max_entries: 1 },
    sleep: async () => {},
  });

  assert.match(bundle.trustedThreadContext, new RegExp(selectedBody));
  for (const body of [issueBody, untrustedBody, reviewBody, threadOnlyBody]) {
    assert.doesNotMatch(bundle.trustedThreadContext, new RegExp(body));
  }
  const persisted = bundle.files["pr-evidence.json"];
  for (const body of [
    issueBody,
    untrustedBody,
    reviewBody,
    selectedBody,
    threadOnlyBody,
  ]) {
    assert.doesNotMatch(persisted, new RegExp(body));
  }

  const modelEvidence = JSON.parse(persisted);
  assert.deepEqual(modelEvidence.issue_comments[0], {
    body_byte_length: Buffer.byteLength(issueBody),
    body_in_trusted_context: false,
    body_sha256: hashBytes(Buffer.from(issueBody)),
    created_at: "2026-07-27T10:00:00Z",
    id: 1,
    updated_at: "2026-07-27T10:00:00Z",
    user: { login: "sampleowner", type: "User" },
  });
  assert.equal(modelEvidence.review_comments[0].body_in_trusted_context, true);
  assert.equal(
    modelEvidence.review_threads[0].comments[1].body_sha256,
    hashBytes(Buffer.from(threadOnlyBody)),
  );
  assert.equal(bundle.evidence.issue_comments[0].body, issueBody);
});

test("the latest created or edited review refresh is required model context", async () => {
  const editedRefresh = "/code-review Edited current evidence summary.";
  const laterCreatedRefresh = "/code-review Older evidence summary.";
  const laterReview = "A later ordinary review comment.";
  const bundle = await collectEvidenceBundle({
    repository: "example-org/sample-app",
    prNumber: 42,
    expectedBaseRef: "main",
    expectedBaseSha: SHA_A,
    expectedHeadSha: SHA_C,
    reviewerRef: SHA_D,
    github: fakeGithub({
      issueComments: [
        {
          id: 1,
          body: editedRefresh,
          created_at: "2026-07-27T10:00:00Z",
          updated_at: "2026-07-27T10:05:00Z",
          user: { login: "sampleowner", type: "User" },
        },
        {
          id: 2,
          body: laterCreatedRefresh,
          created_at: "2026-07-27T10:02:00Z",
          updated_at: "2026-07-27T10:02:00Z",
          user: { login: "sampleowner", type: "User" },
        },
        {
          id: 3,
          body: "/code-review Untrusted evidence summary.",
          user: { login: "outsider", type: "User" },
        },
      ],
      reviewComments: [
        {
          id: 4,
          body: laterReview,
          user: { login: "sampleowner", type: "User" },
        },
      ],
    }),
    git: { mergeBase: async () => SHA_B },
    clock: () => "2026-07-27T10:00:00Z",
    allowedDecisionPrincipals: ["sampleowner"],
    contextLimits: { max_entries: 1 },
    sleep: async () => {},
  });

  assert.match(bundle.trustedThreadContext, new RegExp(editedRefresh));
  assert.doesNotMatch(
    bundle.trustedThreadContext,
    new RegExp(laterCreatedRefresh),
  );
  assert.doesNotMatch(bundle.trustedThreadContext, new RegExp(laterReview));
  const modelEvidence = JSON.parse(bundle.files["pr-evidence.json"]);
  assert.equal(modelEvidence.issue_comments[0].body_in_trusted_context, true);
  assert.equal(bundle.modelReviewRequired, true);
});

test("collectEvidenceBundle rejects base movement during final revalidation", async () => {
  await assert.rejects(
    collectEvidenceBundle({
      repository: "example-org/sample-app",
      prNumber: 42,
      expectedBaseRef: "main",
      expectedBaseSha: SHA_A,
      expectedHeadSha: SHA_C,
      reviewerRef: SHA_D,
      github: fakeGithub({ moveOnFinalRead: true }),
      git: { mergeBase: async () => SHA_B },
      clock: () => "2026-07-27T10:00:00Z",
      sleep: async () => {},
    }),
    (error) =>
      error instanceof EvidenceError && error.code === "review_target_moved",
  );
});

// Correction 2 regressions exercise the shared-action adapters and moved collector.
function correctionTarget() {
  return buildReviewTarget({ repository: "example-org/sample-app", pr_number: 42,
    base_ref: "main", base_sha: SHA_A, merge_base_sha: SHA_B, head_sha: SHA_C,
    trusted_reviewer_ref: SHA_D, evidence_bundle_sha256: HASH_E, evidence_schema_version: 2 });
}
function correctionComment(id, projection) {
  return { id, body: formatProjectionComment({ projection }),
    user: { login: "github-actions[bot]", type: "Bot" } };
}
function correctionCollect(github) {
  return collectEvidenceBundle({ repository: "example-org/sample-app", prNumber: 42,
    expectedBaseRef: "main", expectedBaseSha: SHA_A, expectedHeadSha: SHA_C,
    reviewerRef: SHA_D, github, git: { mergeBase: async () => SHA_C },
    allowedDecisionPrincipals: ["framework-owner", "ordinary-owner"],
    frameworkDecisionPrincipals: ["framework-owner"], sleep: async () => {} });
}

test("correction 5: hosted evidence retains authenticated projection history for substantive heads", async () => {
  const target = { ...correctionTarget(), merge_base_sha: SHA_C };
  const firstIdentity = v4ProjectionForTarget({ target, workflowRunId: "12345",
    workflowJobId: 10, checkRunId: 11, checkSuiteId: 12, summaryCommentId: 90 }).check_identity;
  const first = buildProjection({ candidate: { open_findings: [currentFindingForTarget({ target,
    stableId: "OR-1" })], closed_findings: [], prior_issue_evaluations: [] }, target,
    checkIdentity: firstIdentity, summaryCommentId: 90 });
  const secondIdentity = v4ProjectionForTarget({ target, workflowRunId: "12346",
    workflowJobId: 20, checkRunId: 21, checkSuiteId: 22, summaryCommentId: 91 }).check_identity;
  const second = buildProjection({ candidate: { open_findings: first.open_findings,
    closed_findings: [], prior_issue_evaluations: [{ stable_id: "OR-1", result: "still_open",
      finding: first.open_findings[0] }] }, target, checkIdentity: secondIdentity, summaryCommentId: 91 });
  const bundle = await correctionCollect(fakeGithub({ hostedProvenance: true,
    issueComments: [correctionComment(100, first), correctionComment(101, second)] }));
  assert.deepEqual(bundle.evidence.prior_projections.map(({ comment_id }) => comment_id), [100, 101]);
  assert.equal(bundle.priorProjection.projection_sha256, second.projection_sha256);
  const args = { github: fakeGithub({ hostedProvenance: true,
    issueComments: [correctionComment(100, first), correctionComment(101, second)] }),
    owner: "example-org", repo: "sample-app", prNumber: 42, headSha: SHA_C,
    expectedBaseRef: "main", expectedBaseSha: SHA_A, reviewerRef: SHA_D,
    git: { mergeBase: async () => SHA_C } };
  const snapshot = await collectLedgerEvidence(args);
  assert.deepEqual(snapshot.priorProjections.map(({ comment_id }) => comment_id), [100, 101]);
  await assert.rejects(revalidateLedgerAuthority({ snapshot, ...args,
    github: fakeGithub({ hostedProvenance: true, issueComments: [correctionComment(101, second)] }) }),
  /authority changed during review/);
});

test("correction 2: malformed latest v4 never rolls back to an earlier pass", async () => {
  const projection = v4ProjectionForTarget({ target: correctionTarget() });
  await assert.rejects(correctionCollect(fakeGithub({ hostedProvenance: true,
    issueComments: [correctionComment(100, projection), { id: 101,
      body: "<!-- codex-review:projection:v4 -->\ncorrupt", user: { login: "github-actions[bot]" } }] })),
  /Latest v4 projection.*integrity/);
});

test("correction 2: a late older workflow run or attempt cannot supersede newer authority", async () => {
  for (const sameRun of [false, true]) {
    const target = correctionTarget();
    const older = v4ProjectionForTarget({ target, workflowRunId: "12345" });
    let newer = v4ProjectionForTarget({ target, workflowRunId: sameRun ? "12345" : "12346" });
    if (sameRun) newer = buildProjection({ candidate: buildMechanicalCandidate({ priorProjection: null,
      target, reason: "No changes" }), target, checkIdentity: { ...newer.check_identity, workflow_run_attempt: 2 },
      summaryCommentId: 100 });
    await assert.rejects(correctionCollect(fakeGithub({ hostedProvenance: true,
      issueComments: [correctionComment(100, newer), correctionComment(101, older)] })), /out-of-order/);
  }
});

test("correction 2: retained framework ownership survives edited and deleted authority", async () => {
  const target = correctionTarget();
  const decision = { stable_id: "OR-FRAMEWORK", kind: "EVOLVE_FRAMEWORK", invariant: "Framework owner decides",
    scope: "Shared framework", evidence: null, tracker: null, owner_or_triage: null,
    decision_head_sha: SHA_C, comment_id: 80, actor_login: "framework-owner" };
  const projection = buildProjection({ candidate: { open_findings: [{
    ...currentFindingForTarget({ target, stableId: decision.stable_id }), autonomous_eligibility: "NO",
    decision_ref: "github-comment:80" }], closed_findings: [], prior_issue_evaluations: [] },
    target, humanDecisions: [decision], checkIdentity: v4ProjectionForTarget({ target }).check_identity,
    summaryCommentId: 90 });
  const replacement = { ...decision, kind: "DEFER_FOLLOW_UP", comment_id: 81,
    actor_login: "ordinary-owner", evidence: "Track this", tracker: "ENG-1", owner_or_triage: "ordinary-owner" };
  for (const deleted of [true, false]) {
    const comments = [correctionComment(100, projection), { id: 81,
      body: formatHumanDecisionComment(replacement), user: { login: "ordinary-owner", type: "User" } }];
    if (!deleted) comments.push({ id: 80, body: formatHumanDecisionComment(decision),
      created_at: "2026-07-27T10:00:00Z", updated_at: "2026-07-27T10:01:00Z",
      user: { login: "framework-owner", type: "User" } });
    await assert.rejects(correctionCollect(fakeGithub({ hostedProvenance: true, issueComments: comments })),
      /Retained owner decision 80/);
  }
});

function correctionNative({ event = "workflow_dispatch", headBranch = "main", jobs = null } = {}) {
  const run = { id: 12345, run_attempt: 1, event, path: ".github/workflows/code-review.yaml",
    head_sha: SHA_D, head_branch: headBranch, repository: { full_name: "example-org/sample-app" }, check_suite_id: 12 };
  const native = (id, name) => ({ id, run_id: 12345, run_attempt: 1, runner_name: "shared-runner",
    head_sha: SHA_D, status: "in_progress", name, check_run_url: `https://api.github.com/repos/example-org/sample-app/check-runs/${id}` });
  const github = { paginate: async () => jobs ? jobs(native) : [native(10, "Review result")],
    rest: { actions: { getWorkflowRunAttempt: async () => ({ data: run }), listJobsForWorkflowRunAttempt: () => {} },
      checks: { get: async ({ check_run_id }) => ({ data: { id: check_run_id, head_sha: SHA_D,
        check_suite: { id: 12 }, app: { slug: "github-actions" }, status: "in_progress", name: "Review result" } }) },
      repos: { getContent: async ({ ref }) => {
        assert.equal(ref, SHA_D);
        return { data: { encoding: "base64", content: Buffer.from("name: Review\njobs:\n  review:\n    name: Review result\n    runs-on: ubuntu-latest\n  sibling:\n    name: Sibling\n").toString("base64") } };
      } } } };
  const args = { github, owner: "example-org", repo: "sample-app", runId: 12345, runAttempt: 1,
    headSha: SHA_C, baseRef: "main", prNumber: 42, workflowRef: "example-org/sample-app/.github/workflows/code-review.yaml@refs/heads/main",
    trustedWorkflowSha: SHA_D, runnerName: "shared-runner", callerJob: "review" };
  return { github, args, run };
}

test("correction 2: dispatch provenance binds the actual workflow branch and revision", async () => {
  const { args, run } = correctionNative({ headBranch: "feature" });
  await assert.rejects(loadCheckIdentity(args), /trusted workflow revision/);
  run.head_branch = "main";
  run.head_sha = SHA_A;
  await assert.rejects(loadCheckIdentity(args), /native review job|trusted workflow revision/);
});

test("a pull_request_target run no longer bound to its pull request fails identity", async () => {
  const { args, run } = correctionNative({ event: "pull_request_target", headBranch: "feature" });
  args.headSha = SHA_D;
  run.pull_requests = [];
  await assert.rejects(loadCheckIdentity(args), /identity disagree/);
  run.pull_requests = [{ number: 42, head: { sha: SHA_D }, base: { ref: "main" } }];
  assert.equal((await loadCheckIdentity(args)).workflow_job_id, 10);
});

test("correction 2: native discovery rejects a lone sibling and selects the exact caller among two runners", async () => {
  await assert.rejects(loadCheckIdentity(correctionNative({ jobs: (native) => [native(11, "Sibling")] }).args),
    /exact native review job/);
  const { args } = correctionNative({ jobs: (native) => [native(11, "Sibling"), native(10, "Review result")] });
  assert.equal((await loadCheckIdentity(args)).workflow_job_id, 10);
});

test("correction 3: caller job resolver handles a matrix sibling, valid indent and quoted name comment", async () => {
  const workflow = ["name: Review", "jobs:", "    matrix-sibling:", "      strategy:",
    "        matrix:", "          node: [20, 22]",
    "      name: Sibling (node ${{ matrix.node }})", "    review:",
    '      name: "Review result" # trusted display name', "      runs-on: ubuntu-latest", ""].join("\n");
  const github = { rest: { repos: { getContent: async () => ({ data: { encoding: "base64",
    content: Buffer.from(workflow).toString("base64") } }) } } };
  const args = { github, owner: "example-org", repo: "sample-app", workflowRef:
    "example-org/sample-app/.github/workflows/code-review.yaml@refs/heads/main",
    trustedWorkflowSha: SHA_D, callerJob: "review" };
  assert.equal(await resolveCallerJobName(args), "Review result");
  await assert.rejects(resolveCallerJobName({ ...args, callerJob: "missing" }), /absent/);
  await assert.rejects(resolveCallerJobName({ ...args, callerJob: "matrix-sibling" }), /Matrix caller/);
  const duplicate = workflow.replace("Sibling (node ${{ matrix.node }})", "Review result");
  const duplicateGithub = { rest: { repos: { getContent: async () => ({ data: {
    encoding: "base64", content: Buffer.from(duplicate).toString("base64") } }) } } };
  await assert.rejects(resolveCallerJobName({ ...args, github: duplicateGithub }), /not unique/);
});

test("correction 5: quoted caller job names ignore punctuation in YAML comments", async () => {
  for (const [literal, expected] of [
    ['"Review result" # keep this!', "Review result"],
    ['"Review #1!" # keep this!', "Review #1!"],
  ]) {
    const workflow = `jobs:\n  review:\n    name: ${literal}\n    runs-on: ubuntu-latest\n`;
    const github = { rest: { repos: { getContent: async () => ({ data: { encoding: "base64",
      content: Buffer.from(workflow).toString("base64") } }) } } };
    assert.equal(await resolveCallerJobName({ github, owner: "example-org", repo: "sample-app",
      workflowRef: "example-org/sample-app/.github/workflows/code-review.yaml@refs/heads/main",
      trustedWorkflowSha: SHA_D, callerJob: "review" }), expected);
  }
});

test("correction 6: an apostrophe in a plain caller job name is not a YAML quote", async () => {
  const workflow = "jobs:\n  review:\n    name: Review team's work # note\n    runs-on: ubuntu-latest\n";
  const github = { rest: { repos: { getContent: async () => ({ data: { encoding: "base64",
    content: Buffer.from(workflow).toString("base64") } }) } } };
  assert.equal(await resolveCallerJobName({ github, owner: "example-org", repo: "sample-app",
    workflowRef: "example-org/sample-app/.github/workflows/code-review.yaml@refs/heads/main",
    trustedWorkflowSha: SHA_D, callerJob: "review" }), "Review team's work");
});

test("correction 3: every configured command alias can authenticate a challenge", async () => {
  const target = correctionTarget();
  const base = v4ProjectionForTarget({ target });
  const finding = currentFindingForTarget({ target, stableId: "ISSUE-014" });
  const projection = buildProjection({ candidate: { open_findings: [finding], closed_findings: [],
    prior_issue_evaluations: [] }, target, checkIdentity: base.check_identity, summaryCommentId: 99 });
  for (const alias of ["code-review", "codex-review", "polaris-review"]) {
    const body = `/${alias} [review-evidence-challenge:v1]\nIssue: ISSUE-014\nEvidence: The provider returns the row.\nChallenge head: ${SHA_C}`;
    const github = fakeGithub({ hostedProvenance: true, issueComments: [correctionComment(100, projection),
      { id: 101, body, user: { login: "ordinary-owner", type: "User" } }] });
    const bundle = await collectEvidenceBundle({ repository: "example-org/sample-app", prNumber: 42,
      expectedBaseRef: "main", expectedBaseSha: SHA_A, expectedHeadSha: SHA_C,
      reviewerRef: SHA_D, github, git: { mergeBase: async () => SHA_B },
      allowedDecisionPrincipals: ["ordinary-owner"],
      command: ["code-review", "codex-review", "polaris-review"], sleep: async () => {} });
    assert.equal(bundle.evidence.evidence_challenges.length, 1, alias);
    assert.equal(bundle.modelReviewRequired, true, alias);
  }
  const action = fs.readFileSync(path.join(__dirname, "..", "action.yml"), "utf8");
  assert.match(action, /command: list\(process\.env\.REVIEW_COMMAND\)/);
  assert.doesNotMatch(action, /command: .*REVIEW_COMMAND[^\n]*\[0\]/);
});

test("correction 2: publication revalidates the authority snapshot", async () => {
  const target = correctionTarget();
  const initial = v4ProjectionForTarget({ target });
  const newer = v4ProjectionForTarget({ target, workflowRunId: "12346" });
  const args = { github: fakeGithub({ hostedProvenance: true, issueComments: [correctionComment(100, initial)] }),
    owner: "example-org", repo: "sample-app", prNumber: 42, headSha: SHA_C,
    expectedBaseRef: "main", expectedBaseSha: SHA_A, reviewerRef: SHA_D,
    git: { mergeBase: async () => SHA_B } };
  const snapshot = await collectLedgerEvidence(args);
  args.github = fakeGithub({ hostedProvenance: true, issueComments: [correctionComment(101, newer)] });
  await assert.rejects(revalidateLedgerAuthority({ snapshot, ...args }), /authority changed during review/);
});

test("shared action authenticates direct events against their actual trusted check head", async () => {
  const target = correctionTarget();
  for (const event of ["issue_comment", "workflow_dispatch"]) {
    const base = v4ProjectionForTarget({ target });
    const projection = buildProjection({ candidate: buildMechanicalCandidate({ priorProjection: null,
      target, reason: "No changes" }), target, checkIdentity: { ...base.check_identity, head_sha: SHA_D },
      summaryCommentId: 90 });
    const github = fakeGithub({ hostedProvenance: true, issueComments: [correctionComment(100, projection)] });
    const run = (await github.rest.actions.getWorkflowRunAttempt({ run_id: 12345, attempt_number: 1 })).data;
    Object.assign(run, { event, head_sha: SHA_D, head_branch: "main", pull_requests: [] });
    for (const check of (await github.rest.checks.listForRef()).data.check_runs) check.head_sha = SHA_D;
    for (const job of (await github.rest.actions.listJobsForWorkflowRunAttempt({ run_id: 12345 })).data.jobs) job.head_sha = SHA_D;
    const originalLog = github.loadWorkflowRunLog;
    github.loadWorkflowRunLog = async (args) => `${await originalLog(args)}\nOPEN_REVIEW_TARGET: example-org/sample-app#42 ${SHA_C} main`;
    assert.equal((await correctionCollect(github)).priorProjection.check_identity.head_sha, SHA_D);
    run.head_branch = "feature";
    await assert.rejects(correctionCollect(github), /does not match its hosted/);
  }
});
