"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  constants: zlibConstants,
  deflateRawSync,
  inflateRawSync,
} = require("node:zlib");

const {
  ContractError,
  LEGACY_PROJECTION_PAYLOAD_LABEL,
  MAX_PROJECTION_COMMENT_BYTES,
  PROJECTION_MARKER,
  PROJECTION_PAYLOAD_LABEL,
  buildProjection,
  consumedChallengeRefs,
  deriveCandidateSettlement,
  formatProjectionComment,
  parseProjectionComment,
  prepareReviewPriorProjection,
  validateCandidate,
  verifyProjection,
} = require("../engine/ledger/projection.cjs");
const {
  buildReviewTarget,
  canonicalJson,
  hashCanonical,
  hashReviewTarget,
} = require("../engine/ledger/evidence.cjs");

const SHA = {
  base: "a".repeat(40),
  merge: "b".repeat(40),
  head: "c".repeat(40),
  reviewer: "d".repeat(40),
  evidence: "e".repeat(64),
};
// Keeps the entropy-heavy synthetic projection regression representative across supported
// Node/zlib versions without retaining customer review text.
const PROJECTION_FIXTURE_CLOSURE_EVIDENCE_BYTES = 1_000;

function sizedFixtureText(prefix, length) {
  return `${prefix}${"x".repeat(Math.max(0, length - prefix.length))}`;
}

function entropyText(label, length) {
  let value = label;
  for (let counter = 0; value.length < length; counter += 1) {
    value += hashCanonical({ counter, label });
  }
  return value.slice(0, length);
}

function target(overrides = {}) {
  return buildReviewTarget({
    repository: "example-org/sample-app",
    pr_number: 42,
    base_ref: "main",
    base_sha: SHA.base,
    merge_base_sha: SHA.merge,
    head_sha: SHA.head,
    trusted_reviewer_ref: SHA.reviewer,
    evidence_bundle_sha256: SHA.evidence,
    evidence_schema_version: 1,
    ...overrides,
  });
}

function finding(overrides = {}) {
  const reviewTarget = overrides.reviewTarget || target();
  const { reviewTarget: _reviewTarget, ...findingOverrides } = overrides;
  return {
    stable_id: "ISSUE-001",
    severity: "P1",
    reachability: "normal_path",
    likelihood: "high",
    likely_consequence: "The promised order status update is not sent.",
    worst_credible_consequence:
      "The customer waits for an update that never arrives.",
    recoverability: "operational_intervention",
    proof_strength: "deterministic_static_proof",
    attribution: "introduced",
    risk_rationale:
      "A supported order request breaks the approved update promise and must be repaired in this PR.",
    disposition: "FIX_IN_PR",
    autonomous_eligibility: "YES",
    title: "The order status update is not sent",
    failure_scenario: "A customer requests an order status update, but no task reaches the support queue.",
    approved_invariant:
      "The order handler must queue the promised status update.",
    where: "src/app/orders/status-update.ts:42 → src/tasks/status-update.ts:18",
    evidence:
      "The request flow promises an update, but completion creates no queue task.",
    first_evidence_sha: reviewTarget.head_sha,
    last_evaluated_target: hashReviewTarget(reviewTarget),
    affected_lifecycle_planes: ["prompt_workflow", "post_call_fulfillment"],
    decision_ref: null,
    follow_up: null,
    ...findingOverrides,
  };
}

function incompressibleFinding(index) {
  return finding({
    stable_id: `incompressible-${index}`,
    title: entropyText(`title-${index}`, 150),
    failure_scenario: entropyText(`scenario-${index}`, 1_990),
    approved_invariant: entropyText(`invariant-${index}`, 1_990),
    likely_consequence: entropyText(`likely-${index}`, 1_990),
    worst_credible_consequence: entropyText(`worst-${index}`, 1_990),
    risk_rationale: entropyText(`risk-${index}`, 1_990),
    where: entropyText(`where-${index}`, 1_990),
    evidence: entropyText(`evidence-${index}`, 3_990),
  });
}

function output(overrides = {}) {
  const value = {
    review_markdown: "Verdict: OK",
    inline_comments: [],
    prior_issue_evaluations: [],
    new_findings: [],
    ...overrides,
  };
  value.prior_issue_evaluations = value.prior_issue_evaluations.map(
    (evaluation) =>
      evaluation.result === "still_open" || evaluation.finding
        ? evaluation
        : { ...evaluation, finding: finding() },
  );
  return value;
}

function evidence({
  humanDecisions = [],
  required = true,
  priorProjections = [],
  evidenceChallenges = [],
} = {}) {
  return {
    human_decisions: humanDecisions,
    prior_projections: priorProjections,
    evidence_challenges: evidenceChallenges,
  };
}

function checkIdentity(reviewTarget) {
  return {
    workflow_path: ".github/workflows/code-review.yaml",
    workflow_ref: "refs/heads/main",
    trusted_workflow_sha: reviewTarget.trusted_reviewer_ref,
    workflow_run_id: "12345",
    workflow_run_attempt: 1,
    workflow_job_id: 10,
    check_run_id: 11,
    check_suite_id: 12,
    app_slug: "github-actions",
    head_sha: reviewTarget.head_sha,
  };
}

function project({
  candidate,
  reviewTarget = target(),
  prior = null,
  decisions = [],
}) {
  return buildProjection({
    candidate,
    target: reviewTarget,
    priorProjection: prior,
    humanDecisions: decisions,
    checkIdentity: checkIdentity(reviewTarget),
    summaryCommentId: 99,
  });
}

function rehashProjection(projection) {
  const base = structuredClone(projection);
  delete base.projection_sha256;
  return { ...base, projection_sha256: hashCanonical(base) };
}

function formatLegacyProjectionComment(projection) {
  const payload = deflateRawSync(Buffer.from(canonicalJson(projection)), {
    level: zlibConstants.Z_BEST_COMPRESSION,
  }).toString("base64");
  return [
    PROJECTION_MARKER,
    "<details>",
    "<summary>Codex Review Projection v4 (compressed; do not edit)</summary>",
    "",
    "```text",
    LEGACY_PROJECTION_PAYLOAD_LABEL,
    payload,
    "```",
    "</details>",
  ].join("\n");
}

function firstProjection() {
  const reviewTarget = target();
  const raw = output({ new_findings: [finding({ reviewTarget })] });
  const candidate = validateCandidate({
    rawOutput: raw,
    target: reviewTarget,
    priorProjection: null,
    evidence: evidence(),
  });
  return project({ candidate, reviewTarget });
}

test("projection is complete, independently hashed, and round-trips canonical additive comments", () => {
  const projection = firstProjection();
  assert.equal(
    projection.review_target_hash,
    hashReviewTarget(projection.review_target),
  );
  assert.equal(projection.conclusion, "block");
  assert.equal(projection.watcher_action, "autonomous_batch");
  assert.deepEqual(projection.eligible_issue_ids, ["ISSUE-001"]);
  assert.equal(verifyProjection({ projection }), true);
  const body = formatProjectionComment({ projection });
  assert.ok(body.startsWith(PROJECTION_MARKER));
  assert.match(body, /Codex Review Projection v4/);
  assert.doesNotMatch(body, /```json/);
  assert.deepEqual(parseProjectionComment({ body }), projection);
  assert.deepEqual(
    parseProjectionComment({ body: formatLegacyProjectionComment(projection) }),
    projection,
  );
  const [, , payload] = body.match(
    /codex-review:v4:(dictionary\+deflate-raw|deflate-raw)\+base64\n([A-Za-z0-9+/=]+)\n```/,
  );
  const payloadWithTrailingData = Buffer.concat([
    Buffer.from(payload, "base64"),
    Buffer.from([0]),
  ]).toString("base64");
  assert.throws(
    () =>
      parseProjectionComment({
        body: body.replace(payload, payloadWithTrailingData),
      }),
    /trailing compressed data/,
  );
  assert.throws(
    () =>
      parseProjectionComment({
        body: `${PROJECTION_MARKER}\n\`\`\`json\n${canonicalJson(projection)}\n\`\`\``,
      }),
    /compressed v4 payload/,
  );
  const danglingDecision = structuredClone(projection);
  danglingDecision.open_findings[0].decision_ref = "github-comment:999";
  assert.throws(
    () => verifyProjection({ projection: rehashProjection(danglingDecision) }),
    /does not resolve to a retained decision/,
  );
  const tampered = structuredClone(projection);
  tampered.conclusion = "pass";
  assert.throws(() => verifyProjection({ projection: tampered }), /integrity/);
});

test("reviewer context may be empty but not whitespace", () => {
  const candidate = validateCandidate({
    rawOutput: output({ review_markdown: "" }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });
  assert.equal(candidate.review_markdown, "");
  assert.throws(
    () =>
      validateCandidate({
        rawOutput: output({ review_markdown: " " }),
        target: target(),
        priorProjection: null,
        evidence: evidence(),
      }),
    /review markdown must be a trimmed string/,
  );
});

test("finding presentation fields are required", () => {
  const missing = finding();
  delete missing.where;
  delete missing.evidence;
  assert.throws(
    () =>
      validateCandidate({
        rawOutput: output({ new_findings: [missing] }),
        target: target(),
        priorProjection: null,
        evidence: evidence(),
      }),
    /finding location must be a non-empty trimmed string/,
  );
});

test("obsolete projection shapes are rejected instead of migrated", () => {
  const withBudgetBase = structuredClone(firstProjection());
  delete withBudgetBase.projection_sha256;
  withBudgetBase.autonomous_batch = "unused";
  withBudgetBase.correction = "unused";
  const withBudget = {
    ...withBudgetBase,
    projection_sha256: hashCanonical(withBudgetBase),
  };
  assert.throws(
    () => verifyProjection({ projection: withBudget }),
    /unknown fields/,
  );

  const missingPresentationBase = structuredClone(firstProjection());
  delete missingPresentationBase.projection_sha256;
  delete missingPresentationBase.open_findings[0].where;
  delete missingPresentationBase.open_findings[0].evidence;
  const missingPresentation = {
    ...missingPresentationBase,
    projection_sha256: hashCanonical(missingPresentationBase),
  };
  assert.throws(
    () => verifyProjection({ projection: missingPresentation }),
    /finding location must be a non-empty trimmed string/,
  );

  for (const requiredField of [
    "closed_findings",
    "consumed_evidence_challenge_refs",
  ]) {
    const missingRequiredBase = structuredClone(firstProjection());
    delete missingRequiredBase.projection_sha256;
    delete missingRequiredBase[requiredField];
    assert.throws(() =>
      verifyProjection({
        projection: {
          ...missingRequiredBase,
          projection_sha256: hashCanonical(missingRequiredBase),
        },
      }),
    );
  }
});

test("missing prior evaluations carry still_open with a warning and cannot change identity", () => {
  const prior = firstProjection();
  // Ruling D1: source non-exhaustive error becomes a conservative carry.
  const carried = validateCandidate({ rawOutput: output(), target: target(), priorProjection: prior, evidence: evidence() });
  assert.equal(carried.open_findings[0].stable_id, "ISSUE-001");
  assert.equal(carried.prior_issue_evaluations[0].result, "still_open");
  assert.match(carried.warnings[0], /missing prior evaluation/);
  assert.equal(deriveCandidateSettlement(carried).conclusion, "block");
  const renamed = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "still_open",
          finding: finding({ stable_id: "ISSUE-RENAMED" }),
        },
      ],
    }),
    target: target(),
    priorProjection: prior,
    evidence: evidence(),
  });
  assert.equal(renamed.open_findings[0].stable_id, "ISSUE-001");
  assert.equal(deriveCandidateSettlement(renamed).conclusion, "block");
  assert.match(renamed.warnings.join("\n"), /inconsistent nested finding ID/);
});

test("retained wording drift preserves canonical identity and invariant with current evidence", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/ledger-replay/immutable-wording.json"),
      "utf8",
    ),
  );
  const prior = firstProjection();
  prior.open_findings[0].stable_id = fixture.stable_id;
  prior.open_findings[0].failure_scenario = fixture.prior_failure_scenario;
  const current = finding({
    stable_id: fixture.stable_id,
    failure_scenario: fixture.regenerated_failure_scenario,
    first_evidence_sha: "f".repeat(40),
    where: "src/current-target.ts:42",
    evidence: "The current target still reaches the canonical failure.",
  });
  const candidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: fixture.stable_id,
          result: "still_open",
          finding: current,
        },
      ],
    }),
    target: target(),
    priorProjection: prior,
    evidence: evidence(),
  });

  assert.equal(candidate.open_findings[0].stable_id, fixture.stable_id);
  assert.equal(
    candidate.open_findings[0].failure_scenario,
    fixture.prior_failure_scenario,
  );
  assert.equal(
    candidate.open_findings[0].first_evidence_sha,
    prior.open_findings[0].first_evidence_sha,
  );
  assert.equal(candidate.open_findings[0].where, current.where);
  assert.equal(candidate.open_findings[0].evidence, current.evidence);
  assert.deepEqual(candidate.prior_issue_evaluations, []);

  const invariantDrift = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: fixture.stable_id,
          result: "still_open",
          finding: {
            ...current,
            approved_invariant: "A narrower regenerated invariant.",
            decision_ref: "github-comment:999",
          },
        },
      ],
    }),
    target: target(),
    priorProjection: prior,
    evidence: evidence(),
  });
  assert.equal(
    invariantDrift.open_findings[0].approved_invariant,
    prior.open_findings[0].approved_invariant,
  );
  assert.equal(
    invariantDrift.open_findings[0].decision_ref,
    prior.open_findings[0].decision_ref,
  );
  assert.equal(invariantDrift.open_findings[0].where, current.where);
  assert.equal(invariantDrift.open_findings[0].evidence, current.evidence);
});

test("same-head unsupported findings require an authenticated challenge and independent withdrawal", () => {
  const prior = firstProjection();
  const resolved = output({
    prior_issue_evaluations: [
      {
        stable_id: "ISSUE-001",
        result: "resolved_on_target",
        evidence: "The original premise was unsupported.",
      },
    ],
  });
  assert.throws(
    () =>
      validateCandidate({
        rawOutput: resolved,
        target: target(),
        priorProjection: prior,
        evidence: evidence(),
      }),
    (error) =>
      error instanceof ContractError &&
      error.code === "same_head_resolution_requires_challenge",
  );
  assert.throws(
    () =>
      validateCandidate({
        rawOutput: output({
          prior_issue_evaluations: [
            {
              ...resolved.prior_issue_evaluations[0],
              finding: finding({
                reviewTarget: target({
                  evidence_bundle_sha256: "f".repeat(64),
                }),
              }),
            },
          ],
        }),
        target: target({ evidence_bundle_sha256: "f".repeat(64) }),
        priorProjection: prior,
        evidence: evidence(),
      }),
    (error) =>
      error instanceof ContractError &&
      error.code === "same_head_resolution_requires_challenge",
  );

  const challenge = {
    stable_id: "ISSUE-001",
    evidence: "Trusted evidence does not support the status update premise.",
    challenge_head_sha: SHA.head,
    comment_id: 601,
    actor_login: "sampleowner",
  };
  const withdrawn = output({
    prior_issue_evaluations: [
      {
        stable_id: "ISSUE-001",
        result: "withdrawn_as_unsupported",
        challenge_ref: "github-comment:601",
        evidence:
          "Independent review confirmed that trusted evidence does not support the frozen scenario.",
      },
    ],
  });
  assert.throws(
    () =>
      validateCandidate({
        rawOutput: withdrawn,
        target: target(),
        priorProjection: prior,
        evidence: evidence(),
      }),
    (error) =>
      error instanceof ContractError &&
      error.code === "unsupported_withdrawal_requires_challenge",
  );

  const candidate = validateCandidate({
    rawOutput: withdrawn,
    target: target(),
    priorProjection: prior,
    evidence: evidence({ evidenceChallenges: [challenge] }),
  });
  const projection = project({ candidate, prior });
  assert.deepEqual(candidate.open_findings, []);
  assert.equal(projection.conclusion, "pass");
  assert.equal(projection.watcher_action, "settled");
  assert.deepEqual(
    projection.prior_issue_evaluations,
    withdrawn.prior_issue_evaluations,
  );

  const missingClosedRecord = structuredClone(projection);
  missingClosedRecord.closed_findings = [];
  assert.throws(
    () =>
      verifyProjection({ projection: rehashProjection(missingClosedRecord) }),
    /does not match its canonical closed finding record/,
  );

  const mismatchedClosedRecord = structuredClone(projection);
  mismatchedClosedRecord.closed_findings[0].closure.evidence =
    "Different independently valid closure evidence.";
  assert.throws(
    () =>
      verifyProjection({
        projection: rehashProjection(mismatchedClosedRecord),
      }),
    /does not match its canonical closed finding record/,
  );

  const missingConsumedRef = structuredClone(projection);
  missingConsumedRef.consumed_evidence_challenge_refs = [];
  assert.throws(
    () =>
      verifyProjection({ projection: rehashProjection(missingConsumedRef) }),
    /absent from consumed evidence history/,
  );
});

test("a replacement review can consume a challenge while keeping the finding open", () => {
  const prior = firstProjection();
  const challenge = {
    stable_id: "ISSUE-001",
    evidence: "Trusted evidence does not support the status update premise.",
    challenge_head_sha: SHA.head,
    comment_id: 601,
    actor_login: "sampleowner",
  };
  const challengedStillOpen = output({
    prior_issue_evaluations: [
      {
        stable_id: "ISSUE-001",
        result: "still_open",
        challenge_ref: "github-comment:601",
        finding: finding(),
      },
    ],
  });

  assert.throws(
    () =>
      validateCandidate({
        rawOutput: output({
          prior_issue_evaluations: [
            {
              stable_id: "ISSUE-001",
              result: "still_open",
              finding: finding(),
            },
          ],
        }),
        target: target(),
        priorProjection: prior,
        evidence: evidence({ evidenceChallenges: [challenge] }),
      }),
    (error) =>
      error instanceof ContractError &&
      error.code === "pending_challenge_requires_reference",
  );

  assert.throws(
    () =>
      validateCandidate({
        rawOutput: challengedStillOpen,
        target: target(),
        priorProjection: prior,
        evidence: evidence(),
      }),
    (error) =>
      error instanceof ContractError &&
      error.code === "still_open_challenge_ref_mismatch",
  );

  const candidate = validateCandidate({
    rawOutput: challengedStillOpen,
    target: target(),
    priorProjection: prior,
    evidence: evidence({ evidenceChallenges: [challenge] }),
  });
  const projection = project({ candidate, prior });

  assert.equal(candidate.open_findings.length, 1);
  assert.equal(
    projection.prior_issue_evaluations[0].challenge_ref,
    "github-comment:601",
  );
  assert.equal(projection.prior_issue_evaluations[0].result, "still_open");
  assert.doesNotThrow(() => verifyProjection({ projection }));

  const laterCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "still_open",
          finding: finding(),
        },
      ],
    }),
    target: target(),
    priorProjection: projection,
    evidence: evidence({ evidenceChallenges: [challenge] }),
  });
  assert.equal(laterCandidate.open_findings.length, 1);
  assert.deepEqual(laterCandidate.prior_issue_evaluations, []);
  assert.deepEqual(laterCandidate.consumed_evidence_challenge_refs, [
    "github-comment:601",
  ]);

  assert.throws(
    () =>
      validateCandidate({
        rawOutput: output({
          prior_issue_evaluations: [
            {
              stable_id: "ISSUE-001",
              result: "withdrawn_as_unsupported",
              challenge_ref: "github-comment:601",
              evidence:
                "A later rerun tries to reuse the already-consumed challenge.",
            },
          ],
        }),
        target: target(),
        priorProjection: projection,
        evidence: evidence({ evidenceChallenges: [challenge] }),
      }),
    (error) =>
      error instanceof ContractError &&
      error.code === "evidence_challenge_already_consumed",
  );
});

test("redesign, narrow, and framework evolution stay FIX_IN_PR / NO", () => {
  for (const kind of [
    "REDESIGN_IN_PR",
    "NARROW_BEHAVIOR",
    "EVOLVE_FRAMEWORK",
  ]) {
    const prior = firstProjection();
    const decision = {
      stable_id: "ISSUE-001",
      kind,
      invariant: "Use the approved existing status update seam only.",
      scope: "Current status update behavior only.",
      evidence: null,
      tracker: null,
      owner_or_triage: null,
      decision_head_sha: SHA.head,
      comment_id: 500,
      actor_login: "sampleowner",
    };
    const carried = finding({
      disposition: "FOLLOW_UP",
      autonomous_eligibility: "NO",
      approved_invariant: "Stale model-authored invariant.",
      decision_ref: "github-comment:499",
      follow_up: {
        tracker: "TEST-998",
        owner_or_triage: "Wrong owner",
      },
    });
    assert.throws(
      () =>
        validateCandidate({
          rawOutput: output({
            prior_issue_evaluations: [
              {
                stable_id: "ISSUE-001",
                result: "still_open",
                challenge_ref: "github-comment:601",
                finding: carried,
              },
            ],
          }),
          target: target(),
          priorProjection: prior,
          evidence: evidence({
            humanDecisions: [decision],
            evidenceChallenges: [
              {
                stable_id: "ISSUE-001",
                evidence: "Later evidence disputes the original premise.",
                challenge_head_sha: SHA.head,
                comment_id: 601,
                actor_login: "sampleowner",
              },
            ],
          }),
        }),
      (error) =>
        error instanceof ContractError &&
        error.code === "still_open_challenge_conflicts_with_decision",
    );
    const candidate = validateCandidate({
      rawOutput: output({
        prior_issue_evaluations: [
          { stable_id: "ISSUE-001", result: "still_open", finding: carried },
        ],
      }),
      target: target(),
      priorProjection: prior,
      evidence: evidence({
        humanDecisions: [decision],
        evidenceChallenges: [
          {
            stable_id: "ISSUE-001",
            evidence: "Later evidence disputes the original premise.",
            challenge_head_sha: SHA.head,
            comment_id: 601,
            actor_login: "sampleowner",
          },
        ],
      }),
    });
    assert.equal(candidate.open_findings[0].disposition, "FIX_IN_PR");
    assert.equal(candidate.open_findings[0].autonomous_eligibility, "NO");
    assert.equal(
      candidate.open_findings[0].approved_invariant,
      decision.invariant,
    );
    assert.equal(candidate.open_findings[0].decision_ref, "github-comment:500");
    assert.equal(candidate.open_findings[0].follow_up, null);

    // Correction 2: an unchanged head cannot satisfy a design fix.
    assert.throws(() => validateCandidate({
      rawOutput: output({
        prior_issue_evaluations: [
          {
            stable_id: "ISSUE-001",
            result: "resolved_on_target",
            evidence:
              "The current target already satisfies the newly approved invariant.",
          },
        ],
      }),
      target: target(),
      priorProjection: prior,
      evidence: evidence({
        humanDecisions: [decision],
        evidenceChallenges: [
          {
            stable_id: "ISSUE-001",
            evidence: "Later evidence disputes the original premise.",
            challenge_head_sha: SHA.head,
            comment_id: 601,
            actor_login: "sampleowner",
          },
        ],
      }),
    }), (error) => error instanceof ContractError && error.code === "same_head_resolution_requires_challenge");
  }
});

test("the newest valid decision controls regardless of evidence order", () => {
  const prior = firstProjection();
  const earlier = {
    stable_id: "ISSUE-001",
    kind: "NARROW_BEHAVIOR",
    invariant: "Keep the existing status update behavior.",
    scope: "Current status update behavior only.",
    evidence: null,
    tracker: null,
    owner_or_triage: null,
    decision_head_sha: SHA.head,
    comment_id: 500,
    actor_login: "sampleowner",
  };
  const controlling = {
    ...earlier,
    kind: "EVOLVE_FRAMEWORK",
    invariant: "Use the approved status update seam across the framework.",
    comment_id: 700,
    actor_login: "sample-maintainer",
  };
  const carried = finding({
    autonomous_eligibility: "NO",
    approved_invariant: controlling.invariant,
    decision_ref: "github-comment:700",
  });
  const candidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        { stable_id: "ISSUE-001", result: "still_open", finding: carried },
      ],
    }),
    target: target(),
    priorProjection: prior,
    evidence: evidence({ humanDecisions: [controlling, earlier] }),
  });
  const projection = project({
    candidate,
    prior,
    decisions: [controlling, earlier],
  });

  assert.equal(candidate.open_findings[0].decision_ref, "github-comment:700");
  assert.deepEqual(
    projection.human_decisions.map((decision) => decision.comment_id),
    [500, 700],
  );
});

test("bounded exceptions and evidence-backed rejections may supersede directly", () => {
  for (const kind of ["APPROVE_BOUNDED_EXCEPTION", "REJECT_FINDING"]) {
    const prior = firstProjection();
    const decision = {
      stable_id: "ISSUE-001",
      kind,
      invariant: prior.open_findings[0].approved_invariant,
      scope: "This frozen scenario and PR only.",
      evidence: "Current-target evidence disproves or bounds the scenario.",
      tracker: null,
      owner_or_triage: null,
      decision_head_sha: SHA.head,
      comment_id: 501,
      actor_login: "sampleowner",
    };
    const candidate = validateCandidate({
      rawOutput: output({
        prior_issue_evaluations: [
          {
            stable_id: "ISSUE-001",
            result: "superseded_by_human_decision",
            decision_ref: "github-comment:501",
            evidence: "The current target remains in the approved scope.",
          },
        ],
      }),
      target: target(),
      priorProjection: prior,
      evidence: evidence({
        humanDecisions: [decision],
        evidenceChallenges: [
          {
            stable_id: "ISSUE-001",
            evidence: "Later evidence disputes the original premise.",
            challenge_head_sha: SHA.head,
            comment_id: 601,
            actor_login: "sampleowner",
          },
        ],
      }),
    });
    assert.deepEqual(candidate.open_findings, []);

    assert.throws(
      () =>
        validateCandidate({
          rawOutput: output({
            prior_issue_evaluations: [
              {
                stable_id: "ISSUE-001",
                result: "still_open",
                finding: finding({ decision_ref: "github-comment:501" }),
              },
            ],
          }),
          target: target(),
          priorProjection: prior,
          evidence: evidence({ humanDecisions: [decision] }),
        }),
      (error) =>
        error instanceof ContractError &&
        error.code === "invalid_decision_transition",
    );
  }
});

test("a later design decision is evaluated on the current target before reopening", () => {
  const historical = firstProjection();
  const rejection = {
    stable_id: "ISSUE-001",
    kind: "REJECT_FINDING",
    invariant: historical.open_findings[0].approved_invariant,
    scope: "This frozen scenario and PR only.",
    evidence: "Current-target evidence disproves the original scenario.",
    tracker: null,
    owner_or_triage: null,
    decision_head_sha: SHA.head,
    comment_id: 501,
    actor_login: "sample-maintainer",
  };
  const closedCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "superseded_by_human_decision",
          decision_ref: "github-comment:501",
          evidence: "The current target remains in the rejected scope.",
        },
      ],
    }),
    target: target(),
    priorProjection: historical,
    evidence: evidence({ humanDecisions: [rejection] }),
  });
  const closed = project({
    candidate: closedCandidate,
    prior: historical,
    decisions: [rejection],
  });
  assert.equal(closed.watcher_action, "settled");

  const redesign = {
    ...rejection,
    kind: "REDESIGN_IN_PR",
    invariant: "Use the approved status update seam for this behavior.",
    evidence: null,
    comment_id: 550,
  };
  const currentTarget = target({ head_sha: "f".repeat(40) });
  const reviewPrior = prepareReviewPriorProjection({
    priorProjection: closed,
    humanDecisions: [rejection, redesign],
  });

  assert.equal(reviewPrior.open_findings.length, 1);
  assert.equal(reviewPrior.open_findings[0].stable_id, "ISSUE-001");
  assert.equal(reviewPrior.open_findings[0].disposition, "FIX_IN_PR");
  assert.equal(reviewPrior.open_findings[0].autonomous_eligibility, "NO");
  assert.equal(
    reviewPrior.open_findings[0].approved_invariant,
    redesign.invariant,
  );
  assert.equal(reviewPrior.open_findings[0].decision_ref, "github-comment:550");
  assert.notEqual(
    reviewPrior.open_findings[0].last_evaluated_target,
    hashReviewTarget(currentTarget),
  );

  const resolvedCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "resolved_on_target",
          evidence:
            "The approved status update redesign is implemented and verified.",
          finding: finding({ reviewTarget: currentTarget }),
        },
      ],
    }),
    target: currentTarget,
    priorProjection: closed,
    evidence: evidence({
      humanDecisions: [rejection, redesign],
    }),
  });
  const resolved = project({
    candidate: resolvedCandidate,
    decisions: [rejection, redesign],
    reviewTarget: currentTarget,
  });
  const afterResolutionPrior = prepareReviewPriorProjection({
    priorProjection: resolved,
    humanDecisions: [rejection, redesign],
  });

  assert.deepEqual(resolvedCandidate.open_findings, []);
  assert.equal(resolved.watcher_action, "settled");
  assert.equal(afterResolutionPrior, null);
});

test("a new finding cannot reuse an ID from closed projection history", () => {
  const historical = firstProjection();
  const changedTarget = target({ head_sha: "f".repeat(40) });
  const closedCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "resolved_on_target",
          evidence: "The status update task path is now implemented and verified.",
          finding: finding({ reviewTarget: changedTarget }),
        },
      ],
    }),
    target: changedTarget,
    priorProjection: historical,
    evidence: evidence(),
  });
  const closed = project({
    candidate: closedCandidate,
    reviewTarget: changedTarget,
    prior: historical,
  });

  assert.throws(
    () =>
      validateCandidate({
        rawOutput: output({
          new_findings: [finding({ reviewTarget: changedTarget })],
        }),
        target: changedTarget,
        priorProjection: closed,
        evidence: evidence({
          priorProjections: [
            { comment_id: 100, projection: historical },
            { comment_id: 200, projection: closed },
          ],
        }),
      }),
    /genuinely new stable ID/,
  );
});

test("closed finding snapshots survive later v4 targets without additive history", () => {
  const historical = firstProjection();
  const closureTarget = target({ head_sha: "f".repeat(40) });
  const closedCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "resolved_on_target",
          evidence: "The current target removes the frozen failure path.",
          finding: finding({ reviewTarget: closureTarget }),
        },
      ],
    }),
    target: closureTarget,
    priorProjection: historical,
    evidence: evidence(),
  });
  const closed = project({
    candidate: closedCandidate,
    reviewTarget: closureTarget,
  });
  const laterTarget = target({ head_sha: "9".repeat(40) });
  const laterCandidate = validateCandidate({
    rawOutput: output(),
    target: laterTarget,
    priorProjection: closed,
    evidence: evidence(),
  });
  const later = project({
    candidate: laterCandidate,
    reviewTarget: laterTarget,
  });

  assert.deepEqual(later.closed_findings, closed.closed_findings);
  assert.equal(verifyProjection({ projection: later }), true);
});

test("a later deferral reopens a closed historical finding as a tracked follow-up", () => {
  const historical = firstProjection();
  const changedTarget = target({ head_sha: "f".repeat(40) });
  const closedCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "resolved_on_target",
          evidence: "The original failure is absent on the reviewed target.",
          finding: finding({ reviewTarget: changedTarget }),
        },
      ],
    }),
    target: changedTarget,
    priorProjection: historical,
    evidence: evidence(),
  });
  const closed = project({
    candidate: closedCandidate,
    reviewTarget: changedTarget,
    prior: historical,
  });
  const deferral = {
    stable_id: "ISSUE-001",
    kind: "DEFER_FOLLOW_UP",
    invariant: "This PR does not depend on the deferred cleanup.",
    scope: "Deferred cleanup only.",
    evidence: "The changed path does not consume the deferred behavior.",
    tracker: "TEST-999",
    owner_or_triage: "Framework owner",
    decision_head_sha: SHA.head,
    comment_id: 550,
    actor_login: "sampleowner",
  };

  const reviewPrior = prepareReviewPriorProjection({
    priorProjection: closed,
    priorProjections: [
      { comment_id: 100, projection: historical },
      { comment_id: 500, projection: closed },
    ],
    humanDecisions: [deferral],
  });

  assert.equal(reviewPrior.open_findings.length, 1);
  assert.equal(reviewPrior.open_findings[0].stable_id, "ISSUE-001");
  assert.equal(reviewPrior.open_findings[0].disposition, "FOLLOW_UP");
  assert.equal(reviewPrior.open_findings[0].autonomous_eligibility, "NO");
  assert.equal(
    reviewPrior.open_findings[0].approved_invariant,
    deferral.invariant,
  );
  assert.equal(reviewPrior.open_findings[0].decision_ref, "github-comment:550");
  assert.deepEqual(reviewPrior.open_findings[0].follow_up, {
    tracker: "TEST-999",
    owner_or_triage: "Framework owner",
  });

  const reopenedFinding = {
    ...reviewPrior.open_findings[0],
    last_evaluated_target: hashReviewTarget(changedTarget),
  };
  const reopenedCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "still_open",
          finding: reopenedFinding,
        },
      ],
    }),
    target: changedTarget,
    priorProjection: closed,
    evidence: evidence({ humanDecisions: [deferral] }),
  });
  const reopened = project({
    candidate: reopenedCandidate,
    reviewTarget: changedTarget,
    prior: closed,
    decisions: [deferral],
  });

  assert.deepEqual(reopened.open_findings, [reopenedFinding]);
  assert.deepEqual(reopened.closed_findings, []);
  assert.equal(verifyProjection({ projection: reopened }), true);
});

test("closed historical IDs do not consume the current finding limit", () => {
  const priorProjections = Array.from({ length: 51 }, (_, index) => ({
    comment_id: index + 1,
    projection: {
      open_findings: [
        finding({ stable_id: `closed-historical-finding-${index}` }),
      ],
      prior_issue_evaluations: [],
    },
  }));

  const candidate = validateCandidate({
    rawOutput: output(),
    target: target(),
    priorProjection: null,
    evidence: evidence({ priorProjections }),
  });

  assert.deepEqual(candidate.open_findings, []);
});

test("one resolved prior finding makes room for one new open finding", () => {
  const changedTarget = target({ head_sha: "f".repeat(40) });
  const compactFinding = (stable_id, reviewTarget = target()) =>
    finding({
      reviewTarget,
      stable_id,
      title: "T",
      failure_scenario: "F",
      approved_invariant: "I",
      where: "w",
      evidence: "e",
      affected_lifecycle_planes: [],
    });
  const priorFindings = Array.from({ length: 50 }, (_, index) =>
    compactFinding(`capacity-prior-${index}`),
  );
  const prior = {
    review_target: target(),
    open_findings: priorFindings,
    human_decisions: [],
  };
  const priorIssueEvaluations = priorFindings.map((priorFinding, index) =>
    index === 0
      ? {
          stable_id: priorFinding.stable_id,
          result: "resolved_on_target",
          evidence: "The current target removes this failure path.",
          finding: compactFinding(priorFinding.stable_id, changedTarget),
        }
      : {
          stable_id: priorFinding.stable_id,
          result: "still_open",
          finding: compactFinding(priorFinding.stable_id, changedTarget),
        },
  );
  const candidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: priorIssueEvaluations,
      new_findings: [compactFinding("capacity-new", changedTarget)],
    }),
    target: changedTarget,
    priorProjection: prior,
    evidence: evidence(),
  });

  assert.equal(candidate.open_findings.length, 50);
  assert.doesNotThrow(() =>
    project({ candidate, reviewTarget: changedTarget, prior }),
  );
});

test("Synthetic retained findings are stored once and remain publishable", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/ledger-replay/projection-overflow.json"),
      "utf8",
    ),
  );
  const replayFinding = (stable_id) =>
    finding({
      stable_id,
      title: sizedFixtureText(
        `Title ${stable_id} `,
        fixture.field_lengths.title,
      ),
      failure_scenario: sizedFixtureText(
        `Scenario ${stable_id} `,
        fixture.field_lengths.failure_scenario,
      ),
      approved_invariant: sizedFixtureText(
        `Invariant ${stable_id} `,
        fixture.field_lengths.approved_invariant,
      ),
      where: sizedFixtureText(
        `Location ${stable_id} `,
        fixture.field_lengths.where,
      ),
      evidence: sizedFixtureText(
        `Evidence ${stable_id} `,
        fixture.field_lengths.evidence,
      ),
      affected_lifecycle_planes: [],
    });
  const priorFindings = Array.from(
    { length: fixture.retained_findings },
    (_, index) => replayFinding(`retained-${index}`),
  );
  const priorIssueEvaluations = priorFindings.map((priorFinding) => ({
    stable_id: priorFinding.stable_id,
    result: "still_open",
    finding: priorFinding,
  }));
  const newFindings = Array.from({ length: fixture.new_findings }, (_, index) =>
    replayFinding(`new-${index}`),
  );

  const duplicatedProjection = project({
    candidate: {
      prior_issue_evaluations: priorIssueEvaluations,
      open_findings: [...priorFindings, ...newFindings],
    },
  });
  assert.ok(
    Buffer.byteLength(
      formatProjectionComment({ projection: duplicatedProjection }),
      "utf8",
    ) < 60_000,
  );

  const candidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: priorIssueEvaluations,
      new_findings: newFindings,
    }),
    target: target(),
    priorProjection: { open_findings: priorFindings },
    evidence: evidence(),
  });
  const projection = project({ candidate });
  const body = formatProjectionComment({ projection });

  assert.equal(projection.open_findings.length, 17);
  assert.deepEqual(projection.prior_issue_evaluations, []);
  assert.ok(Buffer.byteLength(body, "utf8") < 60_000);
  assert.deepEqual(parseProjectionComment({ body }), projection);
});

test("a calibrated deferral stays a tracked non-autonomous follow-up and settles", () => {
  const prior = firstProjection();
  const decision = {
    stable_id: "ISSUE-001",
    kind: "DEFER_FOLLOW_UP",
    invariant:
      "This PR neither causes nor relies on the deferred catalogue cleanup.",
    scope: "Catalogue cleanup only.",
    evidence: "The changed path does not consume the catalogue.",
    tracker: "TEST-999",
    owner_or_triage: "Framework owner",
    decision_head_sha: SHA.head,
    comment_id: 502,
    actor_login: "sampleowner",
  };
  const carried = finding({
    severity: "P2",
    reachability: "compound_path",
    likelihood: "low",
    recoverability: "routine",
    disposition: "FIX_IN_PR",
    autonomous_eligibility: "YES",
    approved_invariant: "Stale model-authored invariant.",
    decision_ref: "github-comment:501",
    follow_up: null,
  });
  const candidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        { stable_id: "ISSUE-001", result: "still_open", finding: carried },
      ],
    }),
    target: target(),
    priorProjection: prior,
    evidence: evidence({
      humanDecisions: [decision],
      evidenceChallenges: [
        {
          stable_id: "ISSUE-001",
          evidence: "Later evidence disputes the original premise.",
          challenge_head_sha: SHA.head,
          comment_id: 601,
          actor_login: "sampleowner",
        },
      ],
    }),
  });
  const projection = project({ candidate, prior, decisions: [decision] });
  assert.equal(candidate.open_findings[0].disposition, "FOLLOW_UP");
  assert.equal(candidate.open_findings[0].autonomous_eligibility, "NO");
  assert.equal(
    candidate.open_findings[0].approved_invariant,
    decision.invariant,
  );
  assert.equal(candidate.open_findings[0].decision_ref, "github-comment:502");
  assert.deepEqual(candidate.open_findings[0].follow_up, {
    tracker: "TEST-999",
    owner_or_triage: "Framework owner",
  });
  assert.equal(projection.conclusion, "pass");
  assert.equal(projection.watcher_action, "settled");
});

test("signed P0 and P1 deferrals stay tracked when their approved risk does not drift", () => {
  for (const severity of ["P0", "P1"]) {
    const reviewTarget = target();
    const initialFinding = finding({ reviewTarget, severity });
    const initialCandidate = validateCandidate({
      rawOutput: output({ new_findings: [initialFinding] }),
      target: reviewTarget,
      priorProjection: null,
      evidence: evidence(),
    });
    const prior = project({ candidate: initialCandidate, reviewTarget });
    const decision = {
      stable_id: initialFinding.stable_id,
      kind: "DEFER_FOLLOW_UP",
      invariant: "The approved high-severity finding is owned outside this PR.",
      scope: "The signed deferred finding only.",
      evidence: "The owner accepted the unchanged risk and recorded follow-up.",
      tracker: `ENG-${severity === "P0" ? "900" : "901"}`,
      owner_or_triage: "Engineering triage",
      decision_head_sha: SHA.head,
      comment_id: severity === "P0" ? 900 : 901,
      actor_login: "sampleowner",
    };
    const candidate = validateCandidate({
      rawOutput: output({
        prior_issue_evaluations: [
          {
            stable_id: initialFinding.stable_id,
            result: "still_open",
            finding: initialFinding,
          },
        ],
      }),
      target: reviewTarget,
      priorProjection: prior,
      evidence: evidence({ humanDecisions: [decision] }),
    });

    assert.equal(candidate.open_findings[0].severity, severity);
    assert.equal(candidate.open_findings[0].disposition, "FOLLOW_UP");
    assert.equal(candidate.open_findings[0].autonomous_eligibility, "NO");
    assert.deepEqual(candidate.open_findings[0].follow_up, {
      tracker: decision.tracker,
      owner_or_triage: decision.owner_or_triage,
    });
  }
});

test("a deferral accepts rationale rewording but carries substantive risk drift for an owner decision", () => {
  const reviewTarget = target();
  const proposed = finding({
    reviewTarget,
    severity: "P2",
    reachability: "compound_path",
    likelihood: "low",
    recoverability: "routine",
    attribution: "introduced",
    disposition: "FOLLOW_UP",
    autonomous_eligibility: "NO",
  });
  const proposedCandidate = validateCandidate({
    rawOutput: output({ new_findings: [proposed] }),
    target: reviewTarget,
    priorProjection: null,
    evidence: evidence(),
  });
  const prior = project({ candidate: proposedCandidate, reviewTarget });
  const decision = {
    stable_id: "ISSUE-001",
    kind: "DEFER_FOLLOW_UP",
    invariant: "This PR does not rely on the deferred compound path.",
    scope: "The low-exposure compound path only.",
    evidence: "The approved normal path does not consume this behavior.",
    tracker: "ENG-999",
    owner_or_triage: "Engineering triage",
    decision_head_sha: SHA.head,
    comment_id: 600,
    actor_login: "sampleowner",
  };

  const rewordedRiskRationale =
    "The same compound path remains low likelihood and routinely recoverable.";
  const rewordedCandidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        {
          stable_id: "ISSUE-001",
          result: "still_open",
          finding: {
            ...proposed,
            risk_rationale: rewordedRiskRationale,
          },
        },
      ],
    }),
    target: reviewTarget,
    priorProjection: prior,
    evidence: evidence({ humanDecisions: [decision] }),
  });

  assert.equal(
    rewordedCandidate.open_findings[0].risk_rationale,
    rewordedRiskRationale,
  );

  for (const expandedRisk of [
    { severity: "P1" },
    { reachability: "normal_path" },
    { likelihood: "medium" },
    { recoverability: "irreversible" },
    { attribution: "materially_expanded" },
    { attribution: "relied_upon" },
    { proof_strength: "reproduced" },
    { likely_consequence: "A provider write occurs without confirmation." },
    {
      worst_credible_consequence:
        "A silent external write cannot be reversed safely.",
    },
    {
      affected_lifecycle_planes: [
        ...proposed.affected_lifecycle_planes,
        "provider_action",
      ],
    },
  ]) {
    const blocked = validateCandidate({
          rawOutput: output({
            prior_issue_evaluations: [
              {
                stable_id: "ISSUE-001",
                result: "still_open",
                finding: { ...proposed, ...expandedRisk },
              },
            ],
          }),
          target: reviewTarget,
          priorProjection: prior,
          evidence: evidence({ humanDecisions: [decision] }),
        });
    assert.equal(blocked.open_findings[0].disposition, "AUTHOR_DECISION");
    assert.match(blocked.warnings[0], /risk drift/);
  }
});

test("a calibrated follow-up proposal settles instead of blocking", () => {
  const proposed = finding({
    severity: "P2",
    reachability: "compound_path",
    likelihood: "low",
    likely_consequence: "The customer repeats a recoverable status update request.",
    worst_credible_consequence: "The status update is delayed until a rerun.",
    recoverability: "routine",
    proof_strength: "inferred",
    attribution: "introduced",
    risk_rationale:
      "The compound low-likelihood path causes recoverable friction and needs follow-up approval.",
    disposition: "FOLLOW_UP",
    autonomous_eligibility: "NO",
  });
  const candidate = validateCandidate({
    rawOutput: output({ new_findings: [proposed] }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });

  assert.deepEqual(deriveCandidateSettlement(candidate), {
    conclusion: "pass",
    eligible_issue_ids: [],
    watcher_action: "settled",
  });
  const projection = project({ candidate });
  assert.equal(projection.conclusion, "pass");
  assert.equal(projection.watcher_action, "settled");
  assert.equal(verifyProjection({ projection }), true);
});

test("severity and reachability decide whether an open finding blocks", () => {
  const cases = [
    [{ severity: "P2", reachability: "normal_path" }, "pass"],
    [{ severity: "P1", reachability: "theoretical" }, "pass"],
    [{ severity: "P1", reachability: "compound_path" }, "block"],
    [{ severity: "P0", reachability: "normal_path" }, "block"],
  ];
  for (const [overrides, conclusion] of cases) {
    const candidate = validateCandidate({
      rawOutput: output({ new_findings: [finding(overrides)] }),
      target: target(),
      priorProjection: null,
      evidence: evidence(),
    });
    assert.equal(
      deriveCandidateSettlement(candidate).conclusion,
      conclusion,
      JSON.stringify(overrides),
    );
  }
});

function legacyEraProjection(candidate) {
  const projection = project({ candidate });
  const blockers = projection.open_findings.filter(
    (entry) => entry.disposition !== "FOLLOW_UP",
  );
  const proposals = projection.open_findings.filter(
    (entry) => entry.disposition === "FOLLOW_UP" && entry.decision_ref === null,
  );
  const { projection_sha256: _hash, ...base } = projection;
  const legacyBase = {
    ...base,
    eligible_issue_ids: blockers
      .filter((entry) => entry.autonomous_eligibility === "YES")
      .map(({ stable_id: stableId }) => stableId)
      .toSorted(),
    conclusion: blockers.length > 0 || proposals.length > 0 ? "block" : "pass",
    watcher_action:
      proposals.length > 0 ||
      blockers.some((entry) => entry.disposition === "AUTHOR_DECISION")
        ? "pause_for_human"
        : blockers.some((entry) => entry.autonomous_eligibility !== "YES")
          ? "human_owned"
          : "autonomous_batch",
  };
  return { ...legacyBase, projection_sha256: hashCanonical(legacyBase) };
}

test("a projection comment written under the old settlement still parses", () => {
  const candidate = validateCandidate({
    rawOutput: output({ new_findings: [finding({ severity: "P2" })] }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });
  const current = project({ candidate });
  const legacy = legacyEraProjection(candidate);

  assert.equal(current.conclusion, "pass");
  assert.equal(current.watcher_action, "settled");
  assert.deepEqual(current.eligible_issue_ids, []);
  assert.equal(legacy.conclusion, "block");
  assert.equal(legacy.watcher_action, "autonomous_batch");
  assert.deepEqual(legacy.eligible_issue_ids, ["ISSUE-001"]);

  const body = formatLegacyProjectionComment(legacy);
  assert.deepEqual(parseProjectionComment({ body }), legacy);
});

test("a prior v4 advisory owner-decision settlement still parses", () => {
  const candidate = validateCandidate({
    rawOutput: output({ new_findings: [finding({ severity: "P2", reachability: "theoretical",
      disposition: "AUTHOR_DECISION", autonomous_eligibility: "NO" })] }),
    target: target(), priorProjection: null, evidence: evidence(),
  });
  const current = project({ candidate });
  assert.equal(current.conclusion, "block");
  const priorSettlement = rehashProjection({ ...current, conclusion: "pass",
    watcher_action: "settled", eligible_issue_ids: [] });
  assert.deepEqual(parseProjectionComment({
    body: formatLegacyProjectionComment(priorSettlement),
  }), priorSettlement);
  assert.throws(() => verifyProjection({ projection: priorSettlement }), ContractError);
});

test("an old-settlement projection cannot be published by this run", () => {
  const candidate = validateCandidate({
    rawOutput: output({ new_findings: [finding({ severity: "P2" })] }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });
  const legacy = legacyEraProjection(candidate);

  assert.throws(
    () => verifyProjection({ projection: legacy }),
    (error) =>
      error instanceof ContractError &&
      error.code === "invalid_projection" &&
      /eligible_issue_ids were not derived/.test(error.message),
  );
  assert.throws(
    () => formatProjectionComment({ projection: legacy }),
    ContractError,
  );
});

test("a settlement from neither era is rejected on read", () => {
  const candidate = validateCandidate({
    rawOutput: output({ new_findings: [finding({ severity: "P2" })] }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });
  const { projection_sha256: _hash, ...base } = project({ candidate });
  const invalidBase = { ...base, watcher_action: "human_owned" };
  const invalid = {
    ...invalidBase,
    projection_sha256: hashCanonical(invalidBase),
  };

  assert.throws(
    () =>
      parseProjectionComment({
        body: formatLegacyProjectionComment(invalid),
      }),
    (error) =>
      error instanceof ContractError &&
      error.code === "watcher_action_mismatch",
  );
});

test("forbidden FOLLOW_UP proposals coerce to AUTHOR_DECISION with warnings", () => {
  // Ruling D1 preserves every proposal, including P1 and uncertain risk.
  for (const overrides of [{severity: "P1"}, {reachability: "normal_path"},
    {likelihood: "unknown"}, {recoverability: "unknown"}, {attribution: "relied_upon"}]) {
    const candidate = validateCandidate({
      rawOutput: output({new_findings: [finding({severity: "P2", reachability: "compound_path",
        likelihood: "low", recoverability: "routine", disposition: "FOLLOW_UP", autonomous_eligibility: "NO", ...overrides})]}),
      target: target(), priorProjection: null, evidence: evidence(),
    });
    assert.equal(candidate.open_findings.length, 1);
    assert.equal(candidate.open_findings[0].disposition, "AUTHOR_DECISION");
    assert.equal(candidate.open_findings[0].autonomous_eligibility, "NO");
    assert.match(candidate.warnings[0], /owner decision/);
  }
});

test("pre_existing findings publish with advisory follow-up or required owner decision", () => {
  for (const [risk, expected] of [
    [{severity: "P2", reachability: "compound_path", likelihood: "low", recoverability: "routine"}, "FOLLOW_UP"],
    [{severity: "P1"}, "AUTHOR_DECISION"],
  ]) {
    const candidate = validateCandidate({rawOutput: output({new_findings: [finding({attribution: "pre_existing", ...risk})]}),
      target: target(), priorProjection: null, evidence: evidence()});
    const projection = project({candidate});
    assert.equal(projection.open_findings[0].attribution, "pre_existing");
    assert.equal(projection.open_findings[0].disposition, expected);
    assert.deepEqual(parseProjectionComment({body: formatProjectionComment({projection})}), projection);
  }
});

test("eligible fixes remain autonomous on each newly reviewed head", () => {
  const prior = firstProjection();
  const nextTarget = target({ head_sha: "f".repeat(40) });
  const afterFix = finding({
    reviewTarget: nextTarget,
    first_evidence_sha: SHA.head,
  });
  const candidate = validateCandidate({
    rawOutput: output({
      prior_issue_evaluations: [
        { stable_id: "ISSUE-001", result: "still_open", finding: afterFix },
      ],
    }),
    target: nextTarget,
    priorProjection: prior,
    evidence: evidence(),
  });
  const projection = project({
    candidate,
    reviewTarget: nextTarget,
    prior,
  });
  assert.equal(projection.watcher_action, "autonomous_batch");
  assert.deepEqual(projection.eligible_issue_ids, ["ISSUE-001"]);
});

test("an entropy-heavy near-cap projection keeps the smaller transport", () => {
  const closedHistory = Array.from({ length: 5 }, (_, index) => ({
    finding: incompressibleFinding(index),
    closure: {
      result: "resolved_on_target",
      evidence:
        index === 4
          ? entropyText("closure-4", PROJECTION_FIXTURE_CLOSURE_EVIDENCE_BYTES)
          : `closed ${index}`,
    },
  }));
  const projection = project({
    candidate: {
      open_findings: [],
      prior_issue_evaluations: [],
      closed_findings: closedHistory,
    },
  });
  const body = formatProjectionComment({ projection });
  const legacyBody = formatLegacyProjectionComment(projection);

  assert.equal(MAX_PROJECTION_COMMENT_BYTES, 65_000);
  assert.ok(Buffer.byteLength(body, "utf8") < MAX_PROJECTION_COMMENT_BYTES);
  assert.ok(
    Buffer.byteLength(body, "utf8") <= Buffer.byteLength(legacyBody, "utf8"),
  );
  assert.deepEqual(parseProjectionComment({ body }), projection);
  assert.deepEqual(parseProjectionComment({ body: legacyBody }), projection);
});

test("dictionary transport publishes a complete repeated history that exceeds the legacy cap", () => {
  const history = Array.from({ length: 54 }, (_, index) => {
    const retained = finding({
      stable_id: `history-${index}`,
      failure_scenario: entropyText(`scenario-${index}`, 740),
      evidence: entropyText(`evidence-${index}`, 740),
    });
    return {
      finding: retained,
      closure: {
        result: "resolved_on_target",
        evidence: `Closed ${index} on the reviewed target.`,
      },
    };
  });
  const priorIssueEvaluations = history.slice(0, 5).map((record) => ({
    stable_id: record.finding.stable_id,
    result: record.closure.result,
    evidence: record.closure.evidence,
    finding: record.finding,
  }));
  const projection = project({
    candidate: {
      open_findings: [],
      prior_issue_evaluations: priorIssueEvaluations,
      closed_findings: history,
    },
  });
  const body = formatProjectionComment({ projection });
  const legacyBody = formatLegacyProjectionComment(projection);

  assert.ok(
    Buffer.byteLength(legacyBody, "utf8") >= MAX_PROJECTION_COMMENT_BYTES,
  );
  assert.ok(Buffer.byteLength(body, "utf8") < MAX_PROJECTION_COMMENT_BYTES);
  assert.ok(body.includes(PROJECTION_PAYLOAD_LABEL));
  assert.deepEqual(parseProjectionComment({ body }), projection);

  const payload = body.match(
    /codex-review:v4:dictionary\+deflate-raw\+base64\n([A-Za-z0-9+/=]+)\n```/,
  )[1];
  const transport = JSON.parse(
    inflateRawSync(Buffer.from(payload, "base64")).toString("utf8"),
  );
  transport[2].push("~~~~~~~~");
  const noncanonicalPayload = deflateRawSync(
    Buffer.from(canonicalJson(transport)),
    { level: zlibConstants.Z_BEST_COMPRESSION },
  ).toString("base64");
  assert.throws(
    () =>
      parseProjectionComment({
        body: body.replace(payload, noncanonicalPayload),
      }),
    /dictionary transport is not canonical/,
  );
});

test("new-finding and transport byte limits preserve compressed history", () => {
  const many = Array.from({ length: 51 }, (_, index) =>
    finding({ stable_id: `ISSUE-${index}` }),
  );
  const oversizedFindings = Array.from({ length: 15 }, (_, index) =>
    finding({
      stable_id: `oversized-${index}`,
      title: `Oversized finding ${index}`,
      failure_scenario: `${index}: ${"s".repeat(1_990)}`,
      approved_invariant: `${index}: ${"i".repeat(1_990)}`,
    }),
  );
  const oversizedCandidate = validateCandidate({
    rawOutput: output({ new_findings: oversizedFindings }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });
  const compressedProjection = project({ candidate: oversizedCandidate });
  const compressedBody = formatProjectionComment({
    projection: compressedProjection,
  });
  assert.ok(
    Buffer.byteLength(canonicalJson(compressedProjection), "utf8") > 60_000,
  );
  assert.ok(Buffer.byteLength(compressedBody, "utf8") < 60_000);
  assert.deepEqual(
    parseProjectionComment({ body: compressedBody }),
    compressedProjection,
  );
  const closedHistory = Array.from({ length: 23 }, (_, index) => ({
    finding: finding({
      stable_id: `closed-${index}`,
      failure_scenario: `${index}: ${"s".repeat(1_990)}`,
      approved_invariant: `${index}: ${"i".repeat(1_990)}`,
    }),
    closure: {
      result: "resolved_on_target",
      evidence: `The current target closes historical finding ${index}.`,
    },
  }));
  const closedHistoryProjection = project({
    candidate: {
      open_findings: [],
      prior_issue_evaluations: [],
      closed_findings: closedHistory,
    },
  });
  const closedHistoryBody = formatProjectionComment({
    projection: closedHistoryProjection,
  });
  assert.ok(
    Buffer.byteLength(canonicalJson(closedHistoryProjection), "utf8") > 60_000,
  );
  assert.ok(Buffer.byteLength(closedHistoryBody, "utf8") < 60_000);
  assert.deepEqual(
    parseProjectionComment({ body: closedHistoryBody }),
    closedHistoryProjection,
  );

  const incompressibleFindings = Array.from({ length: 10 }, (_, index) =>
    incompressibleFinding(index),
  );
  const incompressibleCandidate = validateCandidate({
    rawOutput: output({ new_findings: incompressibleFindings }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });
  assert.throws(
    () => project({ candidate: incompressibleCandidate }),
    (error) =>
      error instanceof ContractError && error.code === "projection_overflow",
  );
  assert.throws(
    () =>
      validateCandidate({
        rawOutput: output({ new_findings: many }),
        target: target(),
        priorProjection: null,
        evidence: evidence(),
      }),
    (error) =>
      error instanceof ContractError && error.code === "too_many_findings",
  );
});

test("model-authored text may quote authoritative markers", () => {
  const candidate = validateCandidate({
    rawOutput: output({
      review_markdown:
        "The `<!-- codex-review:projection:v4 -->` marker must start the comment.",
      new_findings: [
        finding({
          failure_scenario:
            "A review quotes <!-- codex-review:projection:v4 -->, codex-review:state:v1:base64, [review-human-decision:v1], or [review-automation-event:v1] in ordinary prose.",
        }),
      ],
    }),
    target: target(),
    priorProjection: null,
    evidence: evidence(),
  });
  const projection = project({ candidate });

  assert.match(
    formatProjectionComment({ projection }),
    /codex-review:projection:v4/,
  );
  assert.deepEqual(
    parseProjectionComment({ body: formatProjectionComment({ projection }) }),
    projection,
  );
  assert.equal(
    parseProjectionComment({
      body: `Quoted ${formatProjectionComment({ projection })}`,
    }),
    null,
  );
});

// Shared rulings: repository-defined lifecycle planes and retained counts do
// not import Intavia's domain policy or its total-open-finding ceiling.
test("shared planes and more than 50 retained findings remain publishable", () => {
  const retained = Array.from({length: 51}, (_, index) => finding({
    stable_id: `retained-${index}`, affected_lifecycle_planes: ["repository_defined_plane"],
  }));
  const prior = project({candidate: {open_findings: retained}});
  const candidate = validateCandidate({rawOutput: output(), target: target(), priorProjection: prior, evidence: evidence()});
  assert.equal(candidate.open_findings.length, 51);
  assert.equal(candidate.warnings.length, 51);
  const projection = project({candidate});
  assert.deepEqual(parseProjectionComment({body: formatProjectionComment({projection})}), projection);
});
