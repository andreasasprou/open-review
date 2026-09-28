"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { hashReviewTarget } = require("../engine/ledger/evidence.cjs");
const { buildMechanicalCandidate, buildProjection, PROJECTION_MARKER } = require("../engine/ledger/projection.cjs");
const {
  buildSummaryBody,
  formatReviewSummary,
  postResults,
  publishInlineComments,
  SUMMARY_MARKER,
} = require("../engine/ledger/publisher.cjs");

test("a single-line inline comment treats null and absent start lines alike", async () => {
  const posted = [];
  const github = { rest: { pulls: { createReview: async (args) => {
    posted.push(args.comments[0]);
    return { data: { id: 5 } };
  } } } };
  const patch = "diff --git a/src/request.ts b/src/request.ts\n+++ b/src/request.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  for (const startLine of [null, undefined]) {
    const comment = { issue_id: "OR-1", file: "src/request.ts", line: 1,
      title: "Request lost", body: "The new write drops a request.", category: "Code", suggestion: null };
    if (startLine === null) comment.start_line = null;
    await publishInlineComments({ github, owner: "example-org", repo: "sample-app", prNumber: 42,
      target: target(), candidate: { inline_comments: [comment], open_findings: [{
        stable_id: "OR-1", severity: "P1" }] }, trustedPatch: patch,
      summaryCommentId: 4, log: () => {} });
  }
  assert.equal(posted.length, 2);
  for (const comment of posted) assert.equal(Object.hasOwn(comment, "start_line"), false);
});

const SHA = {
  base: "1".repeat(40),
  merge: "2".repeat(40),
  head: "3".repeat(40),
  reviewer: "4".repeat(40),
};

function target() {
  return {
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA.base,
    merge_base_sha: SHA.merge,
    head_sha: SHA.head,
    trusted_reviewer_ref: SHA.reviewer,
    evidence_bundle_sha256: "5".repeat(64),
    evidence_schema_version: 1,
  };
}

function checkIdentity() {
  return {
    workflow_path: ".github/workflows/code-review.yaml",
    workflow_ref:
      "example-org/sample-app/.github/workflows/code-review.yaml@refs/heads/main",
    trusted_workflow_sha: SHA.reviewer,
    workflow_run_id: "100",
    workflow_run_attempt: 2,
    workflow_job_id: 101,
    check_run_id: 102,
    check_suite_id: 103,
    app_slug: "github-actions",
    head_sha: SHA.head,
  };
}

function fakeGithub(calls, headRepository = "example-org/sample-app") {
  let commentId = 200;
  return {
    rest: {
      pulls: {
        get: async () => {
          calls.push("revalidate");
          return {
            data: {
              base: { ref: "main", sha: SHA.base },
              head: {
                sha: SHA.head,
                repo: { full_name: headRepository },
              },
            },
          };
        },
        createReview: async () => {
          calls.push("inline");
          return { data: { id: 300 } };
        },
      },
      issues: {
        createComment: async ({ body }) => {
          calls.push(
            body.startsWith(PROJECTION_MARKER) ? "projection" : "summary",
          );
          return { data: { id: commentId++ } };
        },
      },
    },
  };
}

test("correction 3: normal publication rejects an older run or attempt before either comment", async () => {
  const prior = buildProjection({ candidate: buildMechanicalCandidate({ priorProjection: null,
    target: target(), reason: "Previous review" }), target: target(),
    checkIdentity: { ...checkIdentity(), workflow_run_id: "200", workflow_run_attempt: 2 },
    summaryCommentId: 99 });
  for (const identity of [
    { workflow_run_id: "100", workflow_run_attempt: 3 },
    { workflow_run_id: "200", workflow_run_attempt: 2 },
    { workflow_run_id: "200", workflow_run_attempt: 1 },
  ]) {
    const calls = [];
    await assert.rejects(postResults({ github: fakeGithub(calls), owner: "example-org", repo: "sample-app",
      prNumber: 42, target: target(), priorProjection: prior,
      checkIdentity: { ...checkIdentity(), ...identity },
      evidence: { human_decisions: [], rejected_records: [] },
      mechanicalReason: "No new findings", skipInlineComments: true,
    }), /newer workflow run or attempt/);
    assert.deepEqual(calls, []);
  }
});

test("correction 3: trusted manual fork review publishes while automatic fork review is rejected", async () => {
  const calls = [];
  const args = { github: fakeGithub(calls, "contributor/sample-app"), owner: "example-org", repo: "sample-app",
    prNumber: 42, target: target(), checkIdentity: checkIdentity(),
    evidence: { human_decisions: [], rejected_records: [] },
    mechanicalReason: "No new findings", skipInlineComments: true };
  await assert.rejects(postResults({ ...args, eventName: "pull_request_target" }), /PR target moved/);
  assert.deepEqual(calls.filter((call) => call === "summary" || call === "projection"), []);
  await postResults({ ...args, eventName: "workflow_dispatch" });
  assert.deepEqual(calls.filter((call) => call === "summary" || call === "projection"), ["summary", "projection"]);
});

test("publication rechecks authority before summary and projection", async () => {
  const calls = [];
  let checks = 0;
  await assert.rejects(postResults({ github: fakeGithub(calls), owner: "example-org", repo: "sample-app",
    prNumber: 42, target: target(), checkIdentity: checkIdentity(),
    evidence: { human_decisions: [], rejected_records: [] },
    mechanicalReason: "No new findings.", skipInlineComments: true,
    revalidateAuthority: async () => { if (++checks === 2) throw new Error("Authority changed"); },
  }), /Authority changed/);
  assert.equal(checks, 2);
  assert.deepEqual(calls.filter((call) => call === "summary" || call === "projection"), ["summary"]);
});

test("publishes one additive summary then one independently valid projection", async () => {
  const calls = [];
  const result = await postResults({
    github: fakeGithub(calls),
    owner: "example-org",
    repo: "sample-app",
    prNumber: 42,
    target: target(),
    evidence: {
      human_decisions: [],
      rejected_records: [
        { comment_id: 99, reason: "decision_head_not_in_pr_history" },
      ],
      surface_classification: { needs_vision_assessment: false },
    },
    checkIdentity: checkIdentity(),
    outputDir: ".",
    mechanicalReason: "Completed ExecPlan documentation only.",
  });

  assert.deepEqual(calls, [
    "revalidate",
    "summary",
    "revalidate",
    "projection",
  ]);
  assert.equal(result.shouldFail, false);
  assert.equal(result.projection.summary_comment_id, result.summaryCommentId);
  assert.equal(
    result.projection.review_target_hash,
    hashReviewTarget(target()),
  );
  assert.equal(result.projection.check_identity.check_run_id, 102);
});

test("publishes against the supplied trusted patch before asking the native job to fail", async () => {
  const calls = [];
  const reviewTarget = target();
  const modelOutput = {
    review_markdown: `${SUMMARY_MARKER}\nVerdict: BLOCK`,
    inline_comments: [
      {
        issue_id: "framework-owner-drift",
        file: "src/agent.ts",
        line: 1,
        start_line: null,
        title: "Shared behavior has no owner",
        body: "This changed line introduces the unowned behavior.",
        category: "design",
        suggestion: null,
      },
    ],
    prior_issue_evaluations: [],
    new_findings: [
      {
        stable_id: "framework-owner-drift",
        severity: "P1",
        reachability: "normal_path",
        likelihood: "high",
        likely_consequence: "Workflow nodes compile conflicting behavior.",
        worst_credible_consequence:
          "A customer receives the wrong routing behavior.",
        recoverability: "operational_intervention",
        proof_strength: "deterministic_static_proof",
        attribution: "introduced",
        risk_rationale:
          "The unapproved normal-path behavior needs a human decision before merge.",
        disposition: "AUTHOR_DECISION",
        autonomous_eligibility: "NO",
        title: "Shared behavior has no approved owner",
        failure_scenario:
          "The same order handler behavior is compiled differently across workflow nodes.",
        approved_invariant:
          "One approved capability owns the behavior across affected nodes.",
        where: "src/agent.ts:1 → src/workflow.ts:12",
        evidence:
          "The changed agent defines routing behavior that the workflow consumer does not share.",
        first_evidence_sha: SHA.head,
        last_evaluated_target: hashReviewTarget(reviewTarget),
        affected_lifecycle_planes: ["prompt_workflow"],
        decision_ref: null,
        follow_up: null,
      },
    ],
  };

  const result = await postResults({
    github: fakeGithub(calls),
    owner: "example-org",
    repo: "sample-app",
    prNumber: 42,
    target: reviewTarget,
    evidence: {
      human_decisions: [],
      rejected_records: [],
      surface_classification: { needs_vision_assessment: true },
    },
    checkIdentity: checkIdentity(),
    modelOutput,
    trustedPatch: [
      "diff --git a/src/agent.ts b/src/agent.ts",
      "--- /dev/null",
      "+++ b/src/agent.ts",
      "@@ -0,0 +1 @@",
      "+unsafe",
    ].join("\n"),
  });

  assert.equal(result.shouldFail, true);
  assert.equal(result.projection.watcher_action, "pause_for_human");
  assert.deepEqual(calls, [
    "revalidate",
    "summary",
    "revalidate",
    "projection",
    "inline",
  ]);
});

test("renders a short action summary and collapses supporting context", () => {
  const candidate = {
    review_markdown: [
      "## Verdict: BLOCK",
      "",
      "### Scope",
      "A long scope explanation.",
      "",
      "### Dependency Map",
      "A long dependency explanation.",
    ].join("\n"),
    open_findings: [
      {
        stable_id: "framework-owner-drift",
        severity: "P1",
        reachability: "normal_path",
        likelihood: "high",
        likely_consequence: "Workflow nodes compile conflicting behavior.",
        worst_credible_consequence:
          "A customer receives the wrong routing behavior.",
        recoverability: "operational_intervention",
        proof_strength: "deterministic_static_proof",
        attribution: "introduced",
        risk_rationale:
          "The unapproved normal-path behavior needs a human decision before merge.",
        disposition: "AUTHOR_DECISION",
        autonomous_eligibility: "NO",
        title: "Shared behavior has no approved owner",
        failure_scenario:
          "Two workflow nodes compile different order handler behavior.",
        approved_invariant:
          "One approved capability owns the behavior across every node.",
        where: "src/agent.ts:1 → src/workflow.ts:12",
        evidence:
          "The two current workflow nodes compile different routing instructions.",
        affected_lifecycle_planes: ["prompt_workflow"],
        follow_up: null,
      },
    ],
    prior_issue_evaluations: [
      {
        stable_id: "old-doc-gap",
        result: "resolved_on_target",
        evidence: "The current guide now states the invariant.",
      },
      {
        stable_id: "rejected-old-finding",
        result: "superseded_by_human_decision",
        decision_ref: "github-comment:502",
        evidence: "The approved decision rejects the frozen scenario.",
      },
    ],
  };

  const summary = formatReviewSummary(candidate, {
    target: target(),
    humanDecisions: [
      { stable_id: "rejected-old-finding", comment_id: 502 },
      { stable_id: "rejected-old-finding", comment_id: 500 },
    ],
  });
  assert.match(summary, /^## Product or architecture decision needed/);
  assert.match(summary, new RegExp(`Review target · <code>${SHA.head}</code>`));
  assert.match(summary, new RegExp(`${SHA.base}`));
  assert.match(summary, new RegExp(`${SHA.reviewer}`));
  assert.match(summary, /1 finding needs human direction before merge/);
  assert.match(
    summary,
    /\| P1 \| Shared behavior has no approved owner \| Choose the product or architecture direction \|/,
  );
  assert.match(
    summary,
    /<summary><strong>P1 · Shared behavior has no approved owner<\/strong>/,
  );
  assert.match(summary, /\*\*Reachability:\*\* `normal_path`/);
  assert.match(summary, /\*\*Likely consequence:\*\* Workflow nodes/);
  assert.match(summary, /\*\*Risk decision:\*\* The unapproved/);
  assert.match(summary, /1 prior finding was resolved on this head/);
  assert.match(summary, /1 prior finding was superseded by a human decision/);
  assert.match(summary, /decision comment `502` controls and supersedes `500`/);
  assert.match(summary, /<summary>Prior findings \(2\)<\/summary>/);
  assert.match(summary, /<summary>Reviewer context<\/summary>/);
  assert.match(summary, /### Dependency Map/);
  assert.match(summary, /\*\*Where:\*\* src\/agent\\\.ts&#58;1/);
  assert.match(summary, /\*\*Current evidence:\*\* The two current/);

  const confined = formatReviewSummary({
    ...candidate,
    review_markdown: "</details>\n## Review passed",
  });
  assert.doesNotMatch(confined, /<\/details>\n## Review passed/);
  assert.match(confined, /&lt;\/details&gt;\n## Review passed/);

  const confinedFinding = formatReviewSummary({
    ...candidate,
    open_findings: [
      {
        ...candidate.open_findings[0],
        title: "</summary> [Review passed](https://example.com)",
        failure_scenario: "## Review passed",
        approved_invariant: "Notify @sampleowner.",
        where: "src/agent.ts:1 </details>",
        evidence: "Current proof <strong>must stay text</strong>.",
      },
    ],
  });
  assert.match(confinedFinding, /&lt;\/summary&gt;/);
  assert.doesNotMatch(confinedFinding, /\[Review passed\]\(https:\/\//);
  assert.match(confinedFinding, /https&#58;\/\/example\\\.com/);
  assert.match(confinedFinding, /\\#\\# Review passed/);
  assert.match(confinedFinding, /&#64;sampleowner/);
  assert.match(confinedFinding, /src\/agent\\\.ts&#58;1 &lt;\/details&gt;/);
  assert.match(
    confinedFinding,
    /Current proof &lt;strong&gt;must stay text&lt;\/strong&gt;\\\./,
  );

  const body = buildSummaryBody({
    candidate,
    target: target(),
    rejectedRecords: [{ comment_id: 99, reason: "invalid marker" }],
  });
  assert.match(body, new RegExp(`^${SUMMARY_MARKER}`));
  assert.match(
    body,
    /<summary>Rejected authoritative records \(1\)<\/summary>/,
  );

  const bounded = buildSummaryBody({
    candidate: { ...candidate, review_markdown: "x".repeat(60_000) },
    target: target(),
  });
  assert.doesNotMatch(bounded, /<summary>Reviewer context<\/summary>/);
});

test("human-owned summaries ask for the concrete unblocker, not another decision", () => {
  const summary = formatReviewSummary(
    {
      review_markdown: "",
      prior_issue_evaluations: [],
      open_findings: [
        {
          stable_id: "provider-proof",
          severity: "P1",
          reachability: "normal_path",
          likelihood: "unknown",
          likely_consequence: "The provider repair remains unverified.",
          worst_credible_consequence:
            "The changed provider request still fails in production.",
          recoverability: "unknown",
          proof_strength: "inferred",
          attribution: "introduced",
          risk_rationale:
            "The already-decided repair needs provider proof before merge.",
          disposition: "FIX_IN_PR",
          autonomous_eligibility: "NO",
          title: "Provider proof is missing",
          failure_scenario:
            "The repair cannot be verified without sandbox access.",
          approved_invariant: "Verify the provider response before merge.",
          where: "Provider sandbox verification",
          evidence: "No sandbox response was captured.",
          affected_lifecycle_planes: ["proof"],
          follow_up: null,
        },
      ],
    },
    { includeAnalysis: false },
  );

  assert.match(summary, /human action needed/);
  assert.match(summary, /action, permission, credential, or proof/);
  assert.doesNotMatch(summary, /implementation decision/);
});

test("unsigned follow-up summaries settle instead of asking for tracked work", () => {
  const summary = formatReviewSummary(
    {
      review_markdown: "",
      prior_issue_evaluations: [],
      open_findings: [
        {
          stable_id: "compound-review-edge",
          severity: "P2",
          reachability: "compound_path",
          likelihood: "low",
          likely_consequence: "A reviewer needs a routine corrective rerun.",
          worst_credible_consequence:
            "The PR remains paused until a maintainer reruns the review.",
          recoverability: "routine",
          proof_strength: "inferred",
          attribution: "introduced",
          risk_rationale:
            "The low-exposure path qualifies for a human-approved follow-up.",
          disposition: "FOLLOW_UP",
          autonomous_eligibility: "NO",
          title: "A compound review edge can pause publication",
          failure_scenario:
            "Several rare review states align and require a corrective rerun.",
          approved_invariant:
            "Track the compound path without blocking the approved normal path.",
          where: "Internal review workflow",
          evidence: "The path requires three independent conditions.",
          affected_lifecycle_planes: ["proof"],
          decision_ref: null,
          follow_up: null,
        },
      ],
    },
    { includeAnalysis: false },
  );

  assert.match(summary, /## Review passed/);
  assert.match(summary, /Optional follow-up; does not block merge/);
  assert.doesNotMatch(summary, /Decide whether to create a tracked follow-up/);
  assert.doesNotMatch(summary, /human direction before merge/);
});

test("mixed reviews never advertise autonomous mutation while the projection is paused", () => {
  const eligible = {
    stable_id: "eligible-fix",
    severity: "P1",
    reachability: "normal_path",
    likelihood: "medium",
    likely_consequence: "One invalid value reaches the existing handler.",
    worst_credible_consequence: "The request fails with a recoverable error.",
    recoverability: "routine",
    proof_strength: "deterministic_static_proof",
    attribution: "introduced",
    risk_rationale: "The local repair restores the approved validation rule.",
    disposition: "FIX_IN_PR",
    autonomous_eligibility: "YES",
    title: "A local check is missing",
    failure_scenario: "The local validation misses one invalid value.",
    approved_invariant: "The existing validation rejects invalid values.",
    where: "src/review.ts:10",
    evidence: "The current branch skips the existing validation call.",
    affected_lifecycle_planes: ["proof"],
    follow_up: null,
  };
  const human = {
    ...eligible,
    stable_id: "human-decision",
    disposition: "AUTHOR_DECISION",
    autonomous_eligibility: "NO",
    title: "The product behavior needs a decision",
  };
  const summary = formatReviewSummary({
    review_markdown: "",
    open_findings: [eligible, human],
    prior_issue_evaluations: [],
  });

  assert.match(summary, /Wait for the human decision/);
  assert.doesNotMatch(summary, /Agent can fix in this PR/);
});

test("retained findings publish once instead of overflowing projection capacity", async () => {
  const reviewTarget = target();
  const priorFindings = Array.from({ length: 4 }, (_, index) => ({
    stable_id: `large-${index}`,
    severity: "P2",
    reachability: "normal_path",
    likelihood: "medium",
    likely_consequence: "The changed validation misses an invalid value.",
    worst_credible_consequence: "The request fails and must be retried.",
    recoverability: "routine",
    proof_strength: "deterministic_static_proof",
    attribution: "introduced",
    risk_rationale: "The normal-path validation regression needs repair.",
    disposition: "FIX_IN_PR",
    autonomous_eligibility: "YES",
    title: `Large finding ${index}`,
    failure_scenario: `${index}:${"s".repeat(1_990)}`,
    approved_invariant: `${index}:${"i".repeat(1_990)}`,
    where: `${index}:${"w".repeat(1_990)}`,
    evidence: `${index}:${"e".repeat(3_990)}`,
    first_evidence_sha: SHA.head,
    last_evaluated_target: hashReviewTarget(reviewTarget),
    affected_lifecycle_planes: ["proof"],
    decision_ref: null,
    follow_up: null,
  }));
  const modelOutput = {
    review_markdown: "Current-target review.",
    inline_comments: [],
    prior_issue_evaluations: priorFindings.map((finding) => ({
      stable_id: finding.stable_id,
      result: "still_open",
      finding,
    })),
    new_findings: [],
  };
  const calls = [];

  const result = await postResults({
    github: fakeGithub(calls),
    owner: "example-org",
    repo: "sample-app",
    prNumber: 42,
    target: reviewTarget,
    priorProjection: { open_findings: priorFindings,
      check_identity: { workflow_run_id: "99", workflow_run_attempt: 1 } },
    evidence: {
      human_decisions: [],
      rejected_records: [],
      surface_classification: { needs_vision_assessment: false },
    },
    checkIdentity: checkIdentity(),
    modelOutput,
  });

  assert.deepEqual(calls, [
    "revalidate",
    "summary",
    "revalidate",
    "projection",
  ]);
  assert.equal(result.projection.open_findings.length, 4);
  assert.deepEqual(result.projection.prior_issue_evaluations, []);
});
