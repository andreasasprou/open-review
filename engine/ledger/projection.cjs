"use strict";

const {
  constants: zlibConstants,
  deflateRawSync,
  inflateRawSync,
} = require("node:zlib");

const {
  DECISION_KINDS,
  buildReviewTarget,
  canonicalJson,
  hashCanonical,
  hashReviewTarget,
} = require("./evidence.cjs");

const PROJECTION_MARKER = "<!-- codex-review:projection:v4 -->";
const PROJECTION_SCHEMA_VERSION = 4;
// Shared ruling: cap only newly reported findings; retained history has no count cap.
const MAX_NEW_FINDINGS = 25;
// Shared-engine delta: preserve PR #2's size-bounded visible reviews.
const MAX_REVIEW_MARKDOWN_BYTES = 60_000;
const MAX_PROJECTION_COMMENT_BYTES = 65_000;
const MAX_PROJECTION_JSON_BYTES = 8 * 1024 * 1024;
const PROJECTION_PAYLOAD_LABEL =
  "codex-review:v4:dictionary+deflate-raw+base64";
const LEGACY_PROJECTION_PAYLOAD_LABEL = "codex-review:v4:deflate-raw+base64";
const PROJECTION_TRANSPORT_VERSION = 1;
const MIN_INTERNED_STRING_BYTES = 8;
const CANONICAL_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const WATCHER_ACTIONS = Object.freeze([
  "pause_for_human",
  "autonomous_batch",
  "settled",
  "human_owned",
]);
const SEVERITIES = new Set(["P0", "P1", "P2"]);
const REACHABILITY = new Set(["normal_path", "compound_path", "theoretical"]);
const LIKELIHOODS = new Set(["high", "medium", "low", "unknown"]);
const RECOVERABILITY = new Set([
  "routine",
  "operational_intervention",
  "irreversible",
  "unknown",
]);
const PROOF_STRENGTHS = new Set([
  "reproduced",
  "deterministic_static_proof",
  "inferred",
  "speculative",
]);
const ATTRIBUTIONS = new Set([
  "introduced",
  "materially_expanded",
  "relied_upon",
  "pre_existing",
]);
const DISPOSITIONS = new Set(["FIX_IN_PR", "AUTHOR_DECISION", "FOLLOW_UP"]);
const DEFERRED_FOLLOW_UP_RISK_ORDER = Object.freeze({
  severity: Object.freeze({ P2: 0, P1: 1, P0: 2 }),
  reachability: Object.freeze({
    theoretical: 0,
    compound_path: 1,
    normal_path: 2,
  }),
  likelihood: Object.freeze({ low: 0, medium: 1, high: 2, unknown: 3 }),
  recoverability: Object.freeze({
    routine: 0,
    operational_intervention: 1,
    unknown: 2,
    irreversible: 3,
  }),
  attribution: Object.freeze({
    pre_existing: 0,
    introduced: 1,
    materially_expanded: 2,
    relied_upon: 3,
  }),
});
const DEFERRED_FOLLOW_UP_EXACT_RISK_FIELDS = Object.freeze([
  "proof_strength",
  "likely_consequence",
  "worst_credible_consequence",
]);
const DESIGN_DECISION_KINDS = new Set([
  "REDESIGN_IN_PR",
  "NARROW_BEHAVIOR",
  "EVOLVE_FRAMEWORK",
]);
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

class ContractError extends Error {
  constructor({ code, message, details }) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new ContractError({ code, message, details });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(
  value,
  name,
  maxBytes,
  { nullable = false, allowEmpty = false } = {},
) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    (!allowEmpty && value === "")
  ) {
    fail(
      "invalid_field",
      `${name} must be a ${allowEmpty ? "trimmed" : "non-empty trimmed"} string`,
    );
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("field_too_large", `${name} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  if (!isObject(value)) fail("invalid_field", `${name} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    fail("unknown_field", `${name} contains unknown fields`, extras);
  }
}

function decisionRef(decision) {
  return `github-comment:${decision.comment_id}`;
}

function isProposedFollowUp(finding) {
  return finding.disposition === "FOLLOW_UP" && finding.decision_ref === null;
}

// Unsettled owner decisions block even when the retained risk is advisory.
// Other P2 findings, theoretical paths, and follow-up proposals are advisory.
function isMergeBlocker(finding) {
  return (
    finding.disposition === "AUTHOR_DECISION" ||
    (finding.disposition !== "FOLLOW_UP" &&
      finding.severity !== "P2" &&
      finding.reachability !== "theoretical")
  );
}

// Previously published v4 projections gated only reachable P0/P1 findings.
function wasMergeBlocker(finding) {
  return finding.disposition !== "FOLLOW_UP" &&
    finding.severity !== "P2" && finding.reachability !== "theoretical";
}

function isFollowUpRiskEligible(finding) {
  return (
    finding.severity === "P2" &&
    ["compound_path", "theoretical"].includes(finding.reachability) &&
    finding.likelihood === "low" &&
    finding.recoverability === "routine" &&
    finding.attribution !== "relied_upon"
  );
}

function deferredFollowUpRiskDrifted({ currentFinding, priorFinding }) {
  const orderedRiskExpanded = Object.entries(
    DEFERRED_FOLLOW_UP_RISK_ORDER,
  ).some(
    ([field, order]) =>
      Object.hasOwn(priorFinding, field) &&
      order[currentFinding[field]] > order[priorFinding[field]],
  );
  const exactRiskChanged = DEFERRED_FOLLOW_UP_EXACT_RISK_FIELDS.some(
    (field) =>
      Object.hasOwn(priorFinding, field) &&
      currentFinding[field] !== priorFinding[field],
  );
  const priorPlanes = new Set(priorFinding.affected_lifecycle_planes);
  const lifecycleExpanded = currentFinding.affected_lifecycle_planes.some(
    (plane) => !priorPlanes.has(plane),
  );
  return orderedRiskExpanded || exactRiskChanged || lifecycleExpanded;
}

function challengeRef(challenge) {
  return `github-comment:${challenge.comment_id}`;
}

function validateEvidenceChallenge(challenge) {
  exactKeys(
    challenge,
    [
      "stable_id",
      "evidence",
      "challenge_head_sha",
      "comment_id",
      "actor_login",
    ],
    "evidence challenge",
  );
  if (!STABLE_ID_RE.test(challenge.stable_id || ""))
    fail("invalid_evidence_challenge", "Invalid challenge stable_id");
  bounded(challenge.evidence, "challenge evidence", 4_000);
  if (!FULL_SHA_RE.test(challenge.challenge_head_sha || ""))
    fail("invalid_evidence_challenge", "Invalid challenge head SHA");
  if (!Number.isSafeInteger(challenge.comment_id) || challenge.comment_id <= 0)
    fail("invalid_evidence_challenge", "Invalid challenge comment ID");
  bounded(challenge.actor_login, "challenge actor", 100);
  return structuredClone(challenge);
}

function normalizeEvidenceChallenges(challenges) {
  if (!Array.isArray(challenges))
    fail("invalid_evidence_challenge", "Evidence challenges must be an array");
  const normalized = challenges
    .map(validateEvidenceChallenge)
    .toSorted((left, right) => left.comment_id - right.comment_id);
  if (
    new Set(normalized.map(({ comment_id }) => comment_id)).size !==
    normalized.length
  )
    fail("invalid_evidence_challenge", "Challenge comment IDs must be unique");
  return normalized;
}

function consumedChallengeRefs({ priorProjection }) {
  return new Set(priorProjection?.schema_version === PROJECTION_SCHEMA_VERSION
    ? priorProjection.consumed_evidence_challenge_refs : []);
}

function validateHumanDecision(decision) {
  exactKeys(
    decision,
    [
      "stable_id",
      "kind",
      "invariant",
      "scope",
      "evidence",
      "tracker",
      "owner_or_triage",
      "decision_head_sha",
      "comment_id",
      "actor_login",
    ],
    "human decision",
  );
  if (!STABLE_ID_RE.test(decision.stable_id || ""))
    fail("invalid_decision", "Invalid decision stable_id");
  if (!DECISION_KINDS.includes(decision.kind))
    fail("invalid_decision", "Invalid decision kind");
  bounded(decision.invariant, "decision invariant", 2_000);
  bounded(decision.scope, "decision scope", 2_000);
  if (decision.evidence !== null)
    bounded(decision.evidence, "decision evidence", 4_000);
  if (decision.tracker !== null)
    bounded(decision.tracker, "decision tracker", 2_048);
  if (decision.owner_or_triage !== null)
    bounded(decision.owner_or_triage, "decision owner", 2_000);
  if (!FULL_SHA_RE.test(decision.decision_head_sha || ""))
    fail("invalid_decision", "Invalid decision head SHA");
  if (!Number.isSafeInteger(decision.comment_id) || decision.comment_id <= 0)
    fail("invalid_decision", "Invalid decision comment ID");
  bounded(decision.actor_login, "decision actor", 100);
  if (decision.kind === "REJECT_FINDING" && !decision.evidence)
    fail(
      "reject_finding_requires_evidence",
      "REJECT_FINDING requires evidence",
    );
  if (
    decision.kind === "DEFER_FOLLOW_UP" &&
    (!decision.evidence || !decision.tracker || !decision.owner_or_triage)
  ) {
    fail(
      "defer_follow_up_requires_tracking",
      "DEFER_FOLLOW_UP requires independence evidence, tracker, and owner or triage",
    );
  }
  return structuredClone(decision);
}

function normalizeHumanDecisions(decisions) {
  return decisions
    .map(validateHumanDecision)
    .toSorted((left, right) => left.comment_id - right.comment_id);
}

function closureFromEvaluation(evaluation) {
  if (evaluation.result === "resolved_on_target") {
    return {
      result: evaluation.result,
      evidence: evaluation.evidence,
    };
  }
  if (evaluation.result === "withdrawn_as_unsupported") {
    return {
      result: evaluation.result,
      evidence: evaluation.evidence,
      challenge_ref: evaluation.challenge_ref,
    };
  }
  return {
    result: evaluation.result,
    evidence: evaluation.evidence,
    decision_ref: evaluation.decision_ref,
  };
}

function closedFindingRecords({ priorProjection }) {
  if (priorProjection?.schema_version === PROJECTION_SCHEMA_VERSION) {
    return structuredClone(priorProjection.closed_findings);
  }
  return [];
}

function decisionCommentIdFromRef(ref) {
  const match = /^github-comment:([1-9][0-9]*)$/.exec(ref || "");
  return match ? Number(match[1]) : 0;
}

function historicalFindingStates({
  priorProjection,
  priorProjections,
  humanDecisions = [],
}) {
  const statesById = new Map();
  const records = closedFindingRecords({ priorProjection });
  for (const record of records) {
    statesById.set(record.finding.stable_id, {
      finding: record.finding,
      closingDecisionCommentId: Math.max(
        decisionCommentIdFromRef(record.finding.decision_ref),
        decisionCommentIdFromRef(record.closure.decision_ref),
      ),
    });
  }
  return statesById;
}

function latestFindingHeadSha({
  stableId,
  priorProjection = null,
  priorProjections = [],
}) {
  const substantiveOnHead = (projection) => {
    const finding = (projection?.open_findings || []).find((entry) => entry.stable_id === stableId) ||
      (projection?.closed_findings || []).find((entry) => entry.finding.stable_id === stableId)?.finding;
    // A synthesized still_open evaluation preserves the finding on this run;
    // it does not establish that the model evaluated the repaired head.
    const synthesizedCarry = (projection?.prior_issue_evaluations || []).some((entry) =>
      entry.stable_id === stableId && entry.result === "still_open" && !("challenge_ref" in entry));
    return Boolean(finding && !synthesizedCarry);
  };
  const historicalRecords = [...priorProjections].toSorted(
    (left, right) =>
      Number(right?.comment_id || 0) - Number(left?.comment_id || 0),
  );
  for (const record of historicalRecords) {
    const projection = record?.projection;
    if (substantiveOnHead(projection) && FULL_SHA_RE.test(projection?.review_target?.head_sha || "")) {
      return projection.review_target.head_sha;
    }
  }
  if (substantiveOnHead(priorProjection) && FULL_SHA_RE.test(priorProjection?.review_target?.head_sha || "")) {
    return priorProjection.review_target.head_sha;
  }
  return null;
}

function canonicalOpenFindingFields({ decision }) {
  if (!decision) return null;
  if (DESIGN_DECISION_KINDS.has(decision.kind)) {
    return {
      disposition: "FIX_IN_PR",
      autonomous_eligibility: "NO",
      approved_invariant: decision.invariant,
      decision_ref: decisionRef(decision),
      follow_up: null,
    };
  }
  if (decision.kind === "DEFER_FOLLOW_UP") {
    return {
      disposition: "FOLLOW_UP",
      autonomous_eligibility: "NO",
      approved_invariant: decision.invariant,
      decision_ref: decisionRef(decision),
      follow_up: {
        tracker: decision.tracker,
        owner_or_triage: decision.owner_or_triage,
      },
    };
  }
  return null;
}

function prepareReviewPriorProjection(input = {}, decisions = []) {
  // Shared-engine call adapter; the state machine below is the pinned v4 port.
  const { priorProjection = null, priorProjections = [], humanDecisions = [] } =
    input && Object.hasOwn(input, "priorProjection")
      ? input : { priorProjection: input, humanDecisions: decisions };
  const openFindings = structuredClone(priorProjection?.open_findings || []);
  const openIds = new Set(openFindings.map((finding) => finding.stable_id));
  const historicalStatesById = historicalFindingStates({
    priorProjection,
    priorProjections,
    humanDecisions,
  });
  const decisionsByIssue = new Map();
  for (const decision of normalizeHumanDecisions(humanDecisions)) {
    decisionsByIssue.set(decision.stable_id, decision);
  }

  for (const [stableId, decision] of decisionsByIssue) {
    const keepsFindingOpen =
      DESIGN_DECISION_KINDS.has(decision.kind) ||
      decision.kind === "DEFER_FOLLOW_UP";
    if (openIds.has(stableId) || !keepsFindingOpen) {
      continue;
    }
    const historicalState = historicalStatesById.get(stableId);
    if (
      !historicalState ||
      decision.comment_id <= historicalState.closingDecisionCommentId
    ) {
      continue;
    }
    openFindings.push({
      ...structuredClone(historicalState.finding),
      ...canonicalOpenFindingFields({ decision }),
    });
    openIds.add(stableId);
  }

  return openFindings.length > 0 ? { open_findings: openFindings } : null;
}

function normalizeFinding(
  finding,
  {
    target,
    priorFinding = null,
    newFinding = false,
    historicalFinding = false,
    conflictRetained = false,
    warnings = null,
  } = {},
) {
  // Ruling D1: publish pre-existing findings and retain forbidden follow-up
  // proposals as owner decisions. Never apply this coercion to stored records.
  finding = structuredClone(finding);
  if (conflictRetained) {
    finding.disposition = "AUTHOR_DECISION";
    finding.autonomous_eligibility = "NO";
    finding.follow_up = null;
  } else if (warnings && newFinding && finding.attribution === "pre_existing") {
    finding.disposition = "FOLLOW_UP";
    finding.autonomous_eligibility = "NO";
    finding.follow_up = null;
  }
  if (!conflictRetained && warnings && isProposedFollowUp(finding) && !isFollowUpRiskEligible(finding)) {
    finding.disposition = "AUTHOR_DECISION";
    finding.autonomous_eligibility = "NO";
    finding.follow_up = null;
    warnings.push(`${finding.stable_id}: unapproved follow-up proposal requires an owner decision`);
  }
  exactKeys(
    finding,
    [
      "stable_id",
      "severity",
      "reachability",
      "likelihood",
      "likely_consequence",
      "worst_credible_consequence",
      "recoverability",
      "proof_strength",
      "attribution",
      "risk_rationale",
      "disposition",
      "autonomous_eligibility",
      "title",
      "failure_scenario",
      "approved_invariant",
      "where",
      "evidence",
      "first_evidence_sha",
      "last_evaluated_target",
      "affected_lifecycle_planes",
      "decision_ref",
      "follow_up",
    ],
    "finding",
  );
  if (!STABLE_ID_RE.test(finding.stable_id || ""))
    fail("invalid_finding", "Invalid stable_id");
  if (!SEVERITIES.has(finding.severity))
    fail("invalid_finding", "Invalid severity");
  if (!REACHABILITY.has(finding.reachability))
    fail("invalid_finding", "Invalid reachability");
  if (!LIKELIHOODS.has(finding.likelihood))
    fail("invalid_finding", "Invalid likelihood");
  bounded(finding.likely_consequence, "likely consequence", 2_000);
  bounded(
    finding.worst_credible_consequence,
    "worst credible consequence",
    2_000,
  );
  if (!RECOVERABILITY.has(finding.recoverability))
    fail("invalid_finding", "Invalid recoverability");
  if (!PROOF_STRENGTHS.has(finding.proof_strength))
    fail("invalid_finding", "Invalid proof strength");
  if (!ATTRIBUTIONS.has(finding.attribution))
    fail("invalid_finding", "Invalid attribution");
  bounded(finding.risk_rationale, "risk rationale", 2_000);
  if (!DISPOSITIONS.has(finding.disposition))
    fail("invalid_finding", "Invalid disposition");
  if (!["YES", "NO"].includes(finding.autonomous_eligibility))
    fail("invalid_finding", "Invalid autonomous eligibility");
  if (
    finding.disposition !== "FIX_IN_PR" &&
    finding.autonomous_eligibility !== "NO"
  ) {
    fail(
      "invalid_autonomy",
      "AUTHOR_DECISION and FOLLOW_UP can never be autonomous",
    );
  }
  bounded(finding.title, "finding title", 160);
  bounded(finding.failure_scenario, "failure scenario", 2_000);
  bounded(finding.approved_invariant, "approved invariant", 2_000);
  const where = bounded(finding.where, "finding location", 2_000);
  const currentEvidence = bounded(finding.evidence, "finding evidence", 4_000);
  if (!FULL_SHA_RE.test(finding.first_evidence_sha || ""))
    fail("invalid_finding", "Invalid first evidence SHA");
  if (target) {
    const targetRef = hashReviewTarget(target);
    if (finding.last_evaluated_target !== targetRef)
      fail(
        "stale_finding_target",
        "Finding does not reference the current review target",
      );
  } else if (!SHA256_RE.test(finding.last_evaluated_target || "")) {
    fail("invalid_finding", "Invalid last evaluated target");
  }
  if (!Array.isArray(finding.affected_lifecycle_planes))
    fail("invalid_finding", "Lifecycle planes must be an array");
  const planes = [...new Set(finding.affected_lifecycle_planes)];
  // Shared schema permits repository-defined lifecycle plane strings.
  if (planes.some((plane) => typeof plane !== "string" || !plane.trim()))
    fail("invalid_finding", "Invalid lifecycle plane");
  if (
    !(finding.decision_ref === null || typeof finding.decision_ref === "string")
  )
    fail("invalid_finding", "Invalid decision_ref");
  if (finding.decision_ref !== null)
    bounded(finding.decision_ref, "decision_ref", 2_048);
  if (finding.follow_up !== null) {
    exactKeys(finding.follow_up, ["tracker", "owner_or_triage"], "follow_up");
    bounded(finding.follow_up.tracker, "follow-up tracker", 2_048);
    bounded(finding.follow_up.owner_or_triage, "follow-up owner", 2_000);
  }
  const proposedFollowUp = isProposedFollowUp(finding);
  if (
    !historicalFinding &&
    proposedFollowUp &&
    !isFollowUpRiskEligible(finding)
  ) {
    fail(
      "uncalibrated_follow_up",
      "A proposed follow-up must be P2, low-likelihood, compound or theoretical, routinely recoverable, and not relied upon by the PR",
    );
  }
  if (proposedFollowUp && finding.follow_up !== null)
    fail(
      "unapproved_follow_up_tracking",
      "A proposed follow-up cannot claim approved tracking metadata",
    );
  if (
    finding.disposition === "FOLLOW_UP" &&
    finding.decision_ref !== null &&
    !finding.follow_up
  )
    fail(
      "follow_up_tracking_required",
      "An approved follow-up requires tracker and owner or triage",
    );
  if (finding.disposition !== "FOLLOW_UP" && finding.follow_up !== null)
    fail("invalid_follow_up", "Only FOLLOW_UP may contain follow_up metadata");
  if (newFinding && finding.first_evidence_sha !== target.head_sha)
    fail(
      "invalid_first_evidence",
      "A new finding must bind first evidence to the current head",
    );
  if (newFinding && finding.decision_ref !== null)
    fail(
      "invalid_new_finding_decision",
      "A new finding cannot claim a controlling decision",
    );
  return {
    ...structuredClone(finding),
    ...(priorFinding
      ? {
          stable_id: priorFinding.stable_id,
          failure_scenario: priorFinding.failure_scenario,
          first_evidence_sha: priorFinding.first_evidence_sha,
        }
      : {}),
    where,
    evidence: currentEvidence,
    affected_lifecycle_planes: planes,
  };
}

function findingRisk(finding) {
  const severity = typeof finding?.severity === "string"
    ? ({ P0: 3, P1: 2, P2: 1 }[finding.severity] || 2) : 2;
  const reachability = typeof finding?.reachability === "string"
    ? ({ normal_path: 2, compound_path: 1, theoretical: 0 }[finding.reachability] ?? 2) : 2;
  return [severity >= 2 && reachability > 0 ? 1 : 0, severity, reachability];
}

function moreRiskyFinding(left, right) {
  const a = findingRisk(left);
  const b = findingRisk(right);
  for (let index = 0; index < a.length; index += 1) {
    if (b[index] !== a[index]) return b[index] > a[index] ? right : left;
  }
  return left;
}

function canonicalEvaluation(evaluation, target) {
  try {
    if (!isObject(evaluation) || typeof evaluation.stable_id !== "string" ||
        !STABLE_ID_RE.test(evaluation.stable_id) || !isObject(evaluation.finding) ||
        evaluation.finding.stable_id !== evaluation.stable_id)
      return null;
    const allowed = {
      still_open: ["stable_id", "result", "finding", "challenge_ref"],
      resolved_on_target: ["stable_id", "result", "finding", "evidence"],
      withdrawn_as_unsupported: ["stable_id", "result", "finding", "challenge_ref", "evidence"],
      superseded_by_human_decision: ["stable_id", "result", "finding", "decision_ref", "evidence"],
    }[evaluation.result];
    if (!allowed) return null;
    exactKeys(evaluation, allowed, "prior evaluation");
    if (evaluation.result !== "still_open") bounded(evaluation.evidence, "evaluation evidence", 4_000);
    if (["withdrawn_as_unsupported", "superseded_by_human_decision"].includes(evaluation.result) &&
        !Object.hasOwn(evaluation, evaluation.result === "withdrawn_as_unsupported" ? "challenge_ref" : "decision_ref"))
      return null;
    if (Object.hasOwn(evaluation, "challenge_ref")) bounded(evaluation.challenge_ref, "challenge ref", 2_048);
    if (Object.hasOwn(evaluation, "decision_ref")) bounded(evaluation.decision_ref, "decision ref", 2_048);
    const finding = normalizeFinding(evaluation.finding, { target });
    return canonicalJson({ ...evaluation, finding });
  } catch {
    return null;
  }
}

function nonEmptyText(value, fallback, limit) {
  const source = typeof value === "string" && value.trim() ? value.trim() : fallback;
  let result = "";
  let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    result += character;
    bytes += size;
  }
  return result.trimEnd();
}

function repairReportedFinding(raw, stableId) {
  const finding = { ...raw, stable_id: stableId };
  if (finding.disposition !== "FIX_IN_PR" && finding.autonomous_eligibility === "YES")
    finding.autonomous_eligibility = "NO";
  const scenario = nonEmptyText(finding.failure_scenario, `Reported finding ${stableId} requires review.`, 2_000);
  const firstReportedLine = typeof finding.failure_scenario === "string"
    ? finding.failure_scenario.split("\n", 1)[0] : "";
  const title = nonEmptyText(finding.title,
    nonEmptyText(firstReportedLine, `Untitled finding ${stableId}`, 160), 160);
  finding.title = title;
  finding.failure_scenario = scenario;
  for (const [key, fallback, limit] of [
    ["likely_consequence", scenario, 2_000],
    ["worst_credible_consequence", scenario, 2_000],
    ["risk_rationale", "The reported finding requires review.", 2_000],
    ["approved_invariant", "Resolve the reported failure before merge.", 2_000],
    ["where", "Location unavailable; inspect review evidence.", 2_000],
    ["evidence", "Reviewer output omitted complete evidence; verify the reported failure.", 4_000],
  ]) finding[key] = nonEmptyText(finding[key], fallback, limit);
  return finding;
}

function minimalBlockingFinding(raw, stableId, target, reason) {
  const repaired = repairReportedFinding(raw, stableId);
  return {
    stable_id: stableId,
    severity: ["P0", "P1"].includes(raw?.severity) ? raw.severity : "P1",
    reachability: ["normal_path", "compound_path"].includes(raw?.reachability)
      ? raw.reachability : "normal_path",
    likelihood: LIKELIHOODS.has(raw?.likelihood) ? raw.likelihood : "unknown",
    likely_consequence: repaired.likely_consequence,
    worst_credible_consequence: repaired.worst_credible_consequence,
    recoverability: RECOVERABILITY.has(raw?.recoverability) ? raw.recoverability : "irreversible",
    proof_strength: PROOF_STRENGTHS.has(raw?.proof_strength) ? raw.proof_strength : "speculative",
    attribution: ATTRIBUTIONS.has(raw?.attribution) ? raw.attribution : "relied_upon",
    risk_rationale: `Reconciliation could not validate the reported finding (${reason}).`,
    disposition: "AUTHOR_DECISION",
    autonomous_eligibility: "NO",
    title: repaired.title,
    failure_scenario: repaired.failure_scenario,
    approved_invariant: repaired.approved_invariant,
    where: repaired.where,
    evidence: repaired.evidence,
    first_evidence_sha: target.head_sha,
    last_evaluated_target: hashReviewTarget(target),
    affected_lifecycle_planes: Array.isArray(raw?.affected_lifecycle_planes)
      ? [...new Set(raw.affected_lifecycle_planes.filter((plane) => typeof plane === "string" && plane.trim()))]
      : [],
    decision_ref: null,
    follow_up: null,
  };
}

function validateCandidate({ rawOutput, target, priorProjection, evidence }) {
  const reviewTarget = buildReviewTarget(target);
  const warnings = [];
  exactKeys(
    rawOutput,
    [
      "review_markdown",
      "inline_comments",
      "prior_issue_evaluations",
      "new_findings",
    ],
    "review output",
  );
  bounded(
    rawOutput.review_markdown,
    "review markdown",
    MAX_REVIEW_MARKDOWN_BYTES,
    { allowEmpty: true },
  );
  if (!Array.isArray(rawOutput.inline_comments))
    fail("invalid_candidate", "inline_comments must be an array");
  if (!Array.isArray(rawOutput.prior_issue_evaluations))
    fail("invalid_candidate", "prior_issue_evaluations must be an array");
  if (!Array.isArray(rawOutput.new_findings))
    fail("invalid_candidate", "new_findings must be an array");
  if (rawOutput.new_findings.length > MAX_NEW_FINDINGS)
    fail("too_many_findings", `Review output exceeds ${MAX_NEW_FINDINGS} new findings`);

  const decisions = normalizeHumanDecisions(evidence?.human_decisions || []);
  const reviewPriorProjection = prepareReviewPriorProjection({
    priorProjection,
    priorProjections: evidence?.prior_projections || [],
    humanDecisions: decisions,
  });
  const priorFindings = reviewPriorProjection?.open_findings || [];
  const priorById = new Map(
    priorFindings.map((entry) => [entry.stable_id, entry]),
  );
  const candidateById = new Map();
  for (const finding of rawOutput.new_findings) {
    const prior = candidateById.get(finding?.stable_id);
    if (prior) {
      candidateById.set(finding.stable_id, moreRiskyFinding(prior, finding));
      warnings.push(`${finding.stable_id}: duplicate new finding reconciled by risk`);
    } else candidateById.set(finding?.stable_id, finding);
  }
  const convertedNewFindings = new Set();
  const conflictRetainedFindingIds = new Set();
  const evaluationById = new Map();
  const unknownById = new Map();
  const unreconciledKnownIds = new Set();
  const conflictIds = new Set();
  const evaluationsById = new Map();
  for (const rawEvaluation of rawOutput.prior_issue_evaluations) {
    // Strict model output requires nullable keys. The durable v4 projection
    // keeps only fields applicable to this result; a still-open finding has no
    // closing evidence even when the model fills that key.
    const evaluation = isObject(rawEvaluation) ? { ...rawEvaluation } : rawEvaluation;
    if (isObject(evaluation)) {
      for (const key of ["evidence", "challenge_ref", "decision_ref"])
        if (evaluation[key] === null || (key === "evidence" && evaluation.result === "still_open"))
          delete evaluation[key];
    }
    if (!isObject(evaluation)) {
      warnings.push("Unknown prior evaluation was dropped: evaluation is not an object");
      continue;
    }
    const members = evaluationsById.get(evaluation.stable_id) || [];
    members.push(evaluation);
    evaluationsById.set(evaluation.stable_id, members);
  }
  for (const [stableId, members] of evaluationsById) {
    const canonical = members.map((member) => canonicalEvaluation(member, reviewTarget));
    const conflict = members.length > 1 &&
      (canonical.some((value) => value === null) || canonical.some((value) => value !== canonical[0]));
    if (conflict) {
      conflictIds.add(stableId);
      warnings.push(`reconciliation conflict on ${typeof stableId === "string" ? stableId : "(invalid stable ID)"}: ${members.length} evaluations disagreed; kept prior record and blocked`);
      if (!priorById.has(stableId)) {
        const latestWellFormed = members.findLast((member, index) =>
          member.result === "still_open" && canonical[index] !== null);
        unknownById.set(stableId, latestWellFormed || {
          stable_id: stableId, result: "still_open", finding: { stable_id: stableId },
        });
      }
      continue;
    }
    if (members.length > 1)
      warnings.push(`${stableId}: equivalent duplicate prior evaluation dropped`);
    const evaluation = members[0];
    if (priorById.has(stableId)) evaluationById.set(stableId, evaluation);
    else if (evaluation.result === "still_open") unknownById.set(stableId, evaluation);
    else warnings.push(`${typeof stableId === "string" ? stableId : "(invalid stable ID)"}: unknown prior ${typeof evaluation.result === "string" ? evaluation.result.replace(/[^a-z_]/g, "") : "invalid"} evaluation dropped`);
  }
  const closedIds = new Set((priorProjection?.closed_findings || []).map((entry) => entry.finding.stable_id));
  for (const [stableId, evaluation] of unknownById) {
    const warningId = typeof stableId === "string" && STABLE_ID_RE.test(stableId)
      ? stableId : "(invalid stable ID)";
    let finding = isObject(evaluation.finding) ? { ...evaluation.finding } : { stable_id: stableId };
    if (finding.stable_id !== stableId) {
      warnings.push(`${warningId}: inconsistent reported finding ID; using evaluation ID`);
      finding.stable_id = stableId;
    }
    if (typeof finding.stable_id !== "string" || !STABLE_ID_RE.test(finding.stable_id)) {
      const base = `RECON-${hashCanonical({ stableId: warningId, target: reviewTarget.head_sha }).slice(0, 12)}`;
      let safeId = base;
      for (let suffix = 2; candidateById.has(safeId) || priorById.has(safeId) || closedIds.has(safeId); suffix += 1)
        safeId = `${base}-${suffix}`;
      finding.stable_id = safeId;
      warnings.push(`${safeId}: invalid reported stable ID replaced with a blocking identity`);
    }
    if (closedIds.has(stableId)) {
      const base = `${stableId.slice(0, 40)}:recur:${reviewTarget.head_sha.slice(0, 8)}`;
      let freshId = base;
      for (let suffix = 2; candidateById.has(freshId) || priorById.has(freshId) || closedIds.has(freshId); suffix += 1)
        freshId = `${base}-${suffix}`;
      finding.stable_id = freshId;
      const link = `Recurrence of prior finding ${stableId}.`;
      finding.evidence = `${nonEmptyText(finding.evidence, "Reported recurrence.",
        4_000 - Buffer.byteLength(link, "utf8") - 1)} ${link}`;
      warnings.push(`${stableId}: closed finding recurred as ${freshId}`);
    }
    if (conflictIds.has(stableId)) {
      finding = canonicalEvaluation(evaluation, reviewTarget) === null
        ? minimalBlockingFinding(finding, finding.stable_id, reviewTarget, "conflicting evaluations")
        : repairReportedFinding(finding, finding.stable_id);
      finding.disposition = "AUTHOR_DECISION";
      finding.autonomous_eligibility = "NO";
      finding.follow_up = null;
      finding.decision_ref = null;
      conflictRetainedFindingIds.add(finding.stable_id);
    }
    const existing = candidateById.get(finding.stable_id);
    if (conflictIds.has(stableId) || !existing || moreRiskyFinding(existing, finding) === finding) {
      candidateById.set(finding.stable_id, finding);
      convertedNewFindings.add(finding);
    } else warnings.push(`${warningId}: duplicate new finding retained the higher risk`);
  }
  for (const prior of priorFindings) {
    if (conflictIds.has(prior.stable_id)) continue;
    const evaluation = evaluationById.get(prior.stable_id);
    if (!evaluation) continue;
    if (evaluation.result === "still_open") {
      if (evaluation.finding?.stable_id !== prior.stable_id) {
        evaluation.finding = minimalBlockingFinding(evaluation.finding, prior.stable_id,
          reviewTarget, "inconsistent stable ID");
        unreconciledKnownIds.add(prior.stable_id);
        warnings.push(`${prior.stable_id}: inconsistent nested finding ID retained as a blocker`);
      } else {
        const originallyAutonomous = evaluation.finding.autonomous_eligibility === "YES" &&
          evaluation.finding.disposition !== "FIX_IN_PR";
        evaluation.finding = repairReportedFinding(evaluation.finding, prior.stable_id);
        if (originallyAutonomous) {
          unreconciledKnownIds.add(prior.stable_id);
          warnings.push(`${prior.stable_id}: non-fix disposition made non-autonomous`);
        }
      }
    }
    const validateReportedEvaluation = (finding) => normalizeFinding({ ...finding,
      disposition: "FIX_IN_PR", autonomous_eligibility: "NO", decision_ref: null,
      follow_up: null, attribution: "introduced" }, { target: reviewTarget });
    try {
      validateReportedEvaluation(evaluation.finding);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      if (evaluation.result !== "still_open") {
        evaluationById.delete(prior.stable_id);
        warnings.push(`${prior.stable_id}: invalid prior evaluation metadata; prior finding carried forward (${error.code})`);
        continue;
      }
      const repaired = repairReportedFinding(evaluation.finding, prior.stable_id);
      try {
        validateReportedEvaluation(repaired);
        evaluation.finding = repaired;
        warnings.push(`${prior.stable_id}: invalid still_open metadata repaired (${error.code})`);
      } catch (repairError) {
        if (!(repairError instanceof ContractError)) throw repairError;
        evaluation.finding = minimalBlockingFinding(repaired, prior.stable_id,
          reviewTarget, repairError.code);
        unreconciledKnownIds.add(prior.stable_id);
        warnings.push(`${prior.stable_id}: invalid still_open metadata retained as a blocker (${repairError.code})`);
      }
    }
  }
  // Ruling D1: omitted evaluations retain every prior finding and warn.
  const missingEvaluationIds = new Set();
  for (const prior of priorFindings) {
    if (evaluationById.has(prior.stable_id) || conflictIds.has(prior.stable_id)) continue;
    missingEvaluationIds.add(prior.stable_id);
    warnings.push(`${prior.stable_id}: missing prior evaluation; carried forward as still_open`);
    evaluationById.set(prior.stable_id, {
      stable_id: prior.stable_id,
      result: "still_open",
      finding: {
        ...structuredClone(prior), last_evaluated_target: hashReviewTarget(reviewTarget),
        // A reopened closed deferral still needs the replacement review.
        ...(!(priorProjection?.open_findings || []).some((finding) => finding.stable_id === prior.stable_id) &&
          prior.disposition === "FOLLOW_UP" ? {disposition: "AUTHOR_DECISION", follow_up: null, decision_ref: null} : {}),
      },
    });
  }

  const decisionsByIssue = new Map();
  for (const decision of decisions)
    decisionsByIssue.set(decision.stable_id, decision);
  const challenges = normalizeEvidenceChallenges(
    evidence?.evidence_challenges || [],
  );
  const challengesByRef = new Map(
    challenges.map((challenge) => [challengeRef(challenge), challenge]),
  );
  const consumedChallenges = consumedChallengeRefs({
    priorProjection,
    priorProjections: evidence?.prior_projections || [],
  });
  const priorClosedFindingRecords = closedFindingRecords({ priorProjection });
  const closedFindingsById = new Map(
    priorClosedFindingRecords.map((record) => [
      record.finding.stable_id,
      record,
    ]),
  );
  const consumedChallengeRefsForProjection = new Set(consumedChallenges);
  const closeFinding = ({ evaluation, finding }) => {
    closedFindingsById.set(finding.stable_id, {
      finding: structuredClone(finding),
      closure: closureFromEvaluation(evaluation),
    });
  };
  const historicalFindingStatesById = historicalFindingStates({
    priorProjection,
    priorProjections: evidence?.prior_projections || [],
    humanDecisions: decisions,
  });
  const pendingChallengesByIssue = new Map();
  for (const challenge of challenges) {
    const ref = challengeRef(challenge);
    if (consumedChallenges.has(ref)) continue;
    if (decisionsByIssue.has(challenge.stable_id)) continue;
    if (pendingChallengesByIssue.has(challenge.stable_id))
      fail(
        "multiple_pending_evidence_challenges",
        "A prior issue may have only one unconsumed evidence challenge",
      );
    pendingChallengesByIssue.set(challenge.stable_id, challenge);
  }
  const openFindings = [];
  const evaluations = [];
  for (const priorFinding of priorFindings) {
    if (conflictIds.has(priorFinding.stable_id)) {
      const storedFinding = (priorProjection?.open_findings || []).find(
        (finding) => finding.stable_id === priorFinding.stable_id) || priorFinding;
      const carried = normalizeFinding({ ...structuredClone(storedFinding),
        last_evaluated_target: hashReviewTarget(reviewTarget),
        disposition: "AUTHOR_DECISION", autonomous_eligibility: "NO", follow_up: null,
      }, { target: reviewTarget, conflictRetained: true });
      openFindings.push(carried);
      evaluations.push({ stable_id: priorFinding.stable_id, result: "still_open",
        finding: structuredClone(carried) });
      continue;
    }
    const evaluation = evaluationById.get(priorFinding.stable_id);
    const latestDecision = decisionsByIssue.get(priorFinding.stable_id) || null;
    const missingEvaluation = missingEvaluationIds.has(priorFinding.stable_id);
    // Missing model work cannot turn a new deferral or exception into authority.
    const decision = !missingEvaluation || DESIGN_DECISION_KINDS.has(latestDecision?.kind) ||
      (latestDecision?.kind === "DEFER_FOLLOW_UP" &&
        (priorProjection?.open_findings || []).some((finding) => finding.stable_id === priorFinding.stable_id && finding.decision_ref === decisionRef(latestDecision)))
      ? latestDecision : null;
    const pendingChallenge =
      pendingChallengesByIssue.get(priorFinding.stable_id) || null;
    const normalizeEvaluatedFinding = () => {
      if (evaluation.finding?.stable_id !== priorFinding.stable_id)
        fail("renamed_prior_issue", "A prior stable issue cannot be renamed");
      const canonicalInvariantFields = decision
        ? canonicalOpenFindingFields({ decision })
        : evaluation.result === "still_open"
          ? {
              approved_invariant: priorFinding.approved_invariant,
              decision_ref: missingEvaluation ? evaluation.finding.decision_ref : priorFinding.decision_ref,
            }
          : null;
      let finding;
      try {
        finding = normalizeFinding({ ...evaluation.finding, ...canonicalInvariantFields },
          { target: reviewTarget, priorFinding, warnings });
      } catch (error) {
        if (evaluation.result !== "still_open" || !(error instanceof ContractError)) throw error;
        evaluation.finding = minimalBlockingFinding(evaluation.finding, priorFinding.stable_id,
          reviewTarget, error.code);
        unreconciledKnownIds.add(priorFinding.stable_id);
        finding = normalizeFinding({ ...evaluation.finding, ...canonicalInvariantFields },
          { target: reviewTarget, priorFinding, warnings });
        warnings.push(`${priorFinding.stable_id}: inconsistent reassessment retained as a blocker (${error.code})`);
      }
      if (
        !decision && !missingEvaluation &&
        (finding.approved_invariant !== priorFinding.approved_invariant ||
          finding.decision_ref !== priorFinding.decision_ref)
      )
        fail(
          "unapproved_invariant_change",
          "A prior invariant or decision reference changed without a decision",
        );
      return finding;
    };
    if (
      ![
        "still_open",
        "resolved_on_target",
        "withdrawn_as_unsupported",
        "superseded_by_human_decision",
      ].includes(evaluation.result)
    )
      fail("invalid_prior_issue_result", "Unknown prior issue result");
    if (evaluation.result === "still_open") {
      const hasChallengeRef = "challenge_ref" in evaluation;
      if (pendingChallenge && !hasChallengeRef && !missingEvaluation)
        fail(
          "pending_challenge_requires_reference",
          "The replacement review must reference the pending evidence challenge",
        );
      exactKeys(
        evaluation,
        hasChallengeRef
          ? ["stable_id", "result", "challenge_ref", "finding"]
          : ["stable_id", "result", "finding"],
        "still_open evaluation",
      );
      if (hasChallengeRef) {
        bounded(evaluation.challenge_ref, "challenge ref", 2_048);
        if (decision)
          fail(
            "still_open_challenge_conflicts_with_decision",
            "A controlling human decision must use its decision transition",
          );
        if (consumedChallenges.has(evaluation.challenge_ref))
          fail(
            "evidence_challenge_already_consumed",
            "An evidence challenge may be considered by only one replacement review",
          );
        const challenge = challengesByRef.get(evaluation.challenge_ref);
        if (
          !challenge ||
          challenge.stable_id !== priorFinding.stable_id ||
          challenge !== pendingChallenge
        )
          fail(
            "still_open_challenge_ref_mismatch",
            "A challenge-backed still-open evaluation requires the matching authenticated evidence challenge",
          );
      }
      const carried = normalizeEvaluatedFinding();
      if (decision)
        validateDecisionTransition({
          decision,
          evaluation,
          finding: carried,
          priorFinding,
          warnings,
          reconciliationUncertain: unreconciledKnownIds.has(priorFinding.stable_id),
        });
      else if (!missingEvaluation && (
        carried.approved_invariant !== priorFinding.approved_invariant ||
        carried.decision_ref !== priorFinding.decision_ref)
      )
        fail(
          "unapproved_invariant_change",
          "A prior invariant or decision reference changed without a decision",
        );
      openFindings.push(carried);
      if (hasChallengeRef) consumedChallengeRefsForProjection.add(evaluation.challenge_ref);
      if (hasChallengeRef || missingEvaluation)
        evaluations.push(structuredClone({ ...evaluation, finding: carried }));
    } else if (evaluation.result === "resolved_on_target") {
      if (pendingChallenge)
        fail(
          "pending_challenge_requires_challenge_evaluation",
          "A pending evidence challenge must be answered as still_open or withdrawn_as_unsupported",
        );
      exactKeys(
        evaluation,
        ["stable_id", "result", "evidence", "finding"],
        "resolved evaluation",
      );
      bounded(evaluation.evidence, "resolution evidence", 4_000);
      const closedFinding = normalizeEvaluatedFinding();
      const priorHeadSha = latestFindingHeadSha({
        stableId: priorFinding.stable_id,
        priorProjection,
        priorProjections: evidence?.prior_projections || [],
      });
      if (!priorHeadSha)
        fail(
          "same_head_resolution_requires_challenge",
          "Cannot prove a different substantive finding head; same-head correction requires an authenticated evidence challenge",
        );
      // Correction 2: design approval cannot claim a code fix on the same head.
      if (priorHeadSha === reviewTarget.head_sha)
        fail(
          "same_head_resolution_requires_challenge",
          "A same-head correction must use withdrawn_as_unsupported with an authenticated evidence challenge",
        );
      evaluations.push({
        ...structuredClone(evaluation),
        finding: closedFinding,
      });
      closeFinding({ evaluation, finding: closedFinding });
    } else if (evaluation.result === "withdrawn_as_unsupported") {
      exactKeys(
        evaluation,
        ["stable_id", "result", "challenge_ref", "evidence", "finding"],
        "unsupported withdrawal evaluation",
      );
      bounded(evaluation.challenge_ref, "challenge ref", 2_048);
      bounded(evaluation.evidence, "withdrawal evidence", 4_000);
      if (consumedChallenges.has(evaluation.challenge_ref))
        fail(
          "evidence_challenge_already_consumed",
          "An evidence challenge may be considered by only one replacement review",
        );
      const challenge = challengesByRef.get(evaluation.challenge_ref);
      if (
        !challenge ||
        challenge.stable_id !== priorFinding.stable_id ||
        challenge !== pendingChallenge
      )
        fail(
          "unsupported_withdrawal_requires_challenge",
          "Unsupported withdrawal requires a matching authenticated evidence challenge",
        );
      if (decision)
        fail(
          "unsupported_withdrawal_conflicts_with_decision",
          "A controlling human decision must use its decision transition",
        );
      const closedFinding = normalizeEvaluatedFinding();
      consumedChallengeRefsForProjection.add(evaluation.challenge_ref);
      evaluations.push({
        ...structuredClone(evaluation),
        finding: closedFinding,
      });
      closeFinding({ evaluation, finding: closedFinding });
    } else {
      if (pendingChallenge)
        fail(
          "pending_challenge_requires_challenge_evaluation",
          "A pending evidence challenge must be answered as still_open or withdrawn_as_unsupported",
        );
      exactKeys(
        evaluation,
        ["stable_id", "result", "decision_ref", "evidence", "finding"],
        "superseded evaluation",
      );
      bounded(evaluation.evidence, "supersession evidence", 4_000);
      if (
        !decision ||
        !["APPROVE_BOUNDED_EXCEPTION", "REJECT_FINDING"].includes(decision.kind)
      )
        fail(
          "invalid_direct_supersession",
          "Only a bounded exception or evidence-backed rejection can directly supersede",
        );
      if (evaluation.decision_ref !== decisionRef(decision))
        fail("decision_ref_mismatch", "Supersession decision_ref is invalid");
      const closedFinding = normalizeEvaluatedFinding();
      evaluations.push({
        ...structuredClone(evaluation),
        finding: closedFinding,
      });
      closeFinding({ evaluation, finding: closedFinding });
    }
  }

  const reservedIds = new Set([
    ...historicalFindingStatesById.keys(),
    ...priorById.keys(),
  ]);
  const normalizedNewFindings = [];
  for (const rawFinding of candidateById.values()) {
    let normalized;
    try {
      normalized = normalizeFinding(convertedNewFindings.has(rawFinding)
        ? repairReportedFinding(rawFinding, rawFinding.stable_id) : rawFinding, {
        target: reviewTarget,
        newFinding: true,
        conflictRetained: conflictRetainedFindingIds.has(rawFinding.stable_id),
        warnings,
      });
    } catch (error) {
      if (!convertedNewFindings.has(rawFinding) || !(error instanceof ContractError)) throw error;
      normalized = normalizeFinding(minimalBlockingFinding(rawFinding, rawFinding.stable_id,
        reviewTarget, error.code), { target: reviewTarget, newFinding: true,
          conflictRetained: conflictRetainedFindingIds.has(rawFinding.stable_id) });
      warnings.push(`${normalized.stable_id}: invalid reported finding retained as a blocker (${error.code})`);
    }
    if (reservedIds.has(normalized.stable_id))
      fail(
        "duplicate_or_reused_stable_id",
        "A new finding must use a genuinely new stable ID",
      );
    reservedIds.add(normalized.stable_id);
    if (convertedNewFindings.has(rawFinding))
      warnings.push(`${normalized.stable_id}: unknown prior still_open evaluation became a new finding`);
    normalizedNewFindings.push(normalized);
  }
  const isNewBlocker = (finding) =>
    conflictRetainedFindingIds.has(finding.stable_id) || isMergeBlocker(finding);
  const blockers = normalizedNewFindings.filter(isNewBlocker);
  const advisorySlots = Math.max(0, MAX_NEW_FINDINGS - blockers.length);
  const advisories = normalizedNewFindings.filter((finding) => !isNewBlocker(finding));
  const keptAdvisories = new Set(advisories
    .toSorted((left, right) => {
      const a = findingRisk(left);
      const b = findingRisk(right);
      return b[1] - a[1] || b[2] - a[2];
    }).slice(0, advisorySlots));
  const newFindings = normalizedNewFindings.filter((finding) =>
    isNewBlocker(finding) || keptAdvisories.has(finding));
  for (const finding of normalizedNewFindings) {
    if (!newFindings.includes(finding))
      warnings.push(`${finding.stable_id}: advisory finding omitted to make room within the ${MAX_NEW_FINDINGS}-finding cap`);
  }
  if (blockers.length > MAX_NEW_FINDINGS)
    warnings.push(`${blockers.length} reachable blockers exceed the ${MAX_NEW_FINDINGS}-finding cap; all blockers remain open and the review is blocked`);
  openFindings.push(...newFindings);
  for (const finding of openFindings) {
    closedFindingsById.delete(finding.stable_id);
  }
  return {
    review_markdown: rawOutput.review_markdown,
    inline_comments: structuredClone(rawOutput.inline_comments),
    prior_issue_evaluations: evaluations,
    new_findings: newFindings,
    open_findings: openFindings,
    closed_findings: [...closedFindingsById.values()].toSorted((left, right) =>
      left.finding.stable_id.localeCompare(right.finding.stable_id),
    ),
    consumed_evidence_challenge_refs: [
      ...consumedChallengeRefsForProjection,
    ].toSorted(),
    warnings,
  };
}

function validateDecisionTransition({
  decision,
  evaluation,
  finding,
  priorFinding,
  warnings,
  reconciliationUncertain = false,
}) {
  const ref = decisionRef(decision);
  if (finding.decision_ref !== ref)
    fail(
      "decision_ref_mismatch",
      "Finding must reference its controlling human decision",
    );
  if (DESIGN_DECISION_KINDS.has(decision.kind)) {
    if (
      evaluation.result !== "still_open" ||
      finding.disposition !== "FIX_IN_PR" ||
      finding.autonomous_eligibility !== "NO"
    )
      fail(
        "invalid_decision_transition",
        `${decision.kind} keeps the issue open as FIX_IN_PR / NO`,
      );
    if (finding.approved_invariant !== decision.invariant)
      fail(
        "decision_invariant_mismatch",
        "Finding must carry the approved human invariant",
      );
    return;
  }
  if (decision.kind === "DEFER_FOLLOW_UP") {
    // Ruling D1: widened risk remains published and blocked until a new
    // owner decision; the old approval cannot reapply in a subsequent review.
    if (reconciliationUncertain ||
      (priorFinding.disposition === "AUTHOR_DECISION" && priorFinding.decision_ref === ref) ||
      deferredFollowUpRiskDrifted({ currentFinding: evaluation.finding, priorFinding })) {
      finding.disposition = "AUTHOR_DECISION";
      finding.autonomous_eligibility = "NO";
      finding.follow_up = null;
      finding.approved_invariant = priorFinding.approved_invariant;
      warnings.push(`${finding.stable_id}: deferred risk drift requires a new owner decision`);
      return;
    }
    if (
      finding.disposition !== "FOLLOW_UP" ||
      finding.autonomous_eligibility !== "NO" ||
      finding.approved_invariant !== decision.invariant ||
      finding.follow_up?.tracker !== decision.tracker ||
      finding.follow_up?.owner_or_triage !== decision.owner_or_triage
    )
      fail(
        "invalid_decision_transition",
        "DEFER_FOLLOW_UP must remain a tracked non-autonomous follow-up",
      );
    return;
  }
  if (["APPROVE_BOUNDED_EXCEPTION", "REJECT_FINDING"].includes(decision.kind)) {
    fail(
      "invalid_decision_transition",
      `${decision.kind} must supersede directly or resolve with current-target evidence`,
    );
  }
}

function normalizeCheckIdentity(identity, target) {
  const keys = [
    "workflow_path",
    "workflow_ref",
    "trusted_workflow_sha",
    "workflow_run_id",
    "workflow_run_attempt",
    "workflow_job_id",
    "check_run_id",
    "check_suite_id",
    "app_slug",
    "head_sha",
  ];
  exactKeys(identity, keys, "check_identity");
  bounded(identity.workflow_path, "workflow path", 512);
  bounded(identity.workflow_ref, "workflow ref", 512);
  if (identity.trusted_workflow_sha !== target.trusted_reviewer_ref)
    fail(
      "check_identity_mismatch",
      "Trusted workflow SHA does not match ReviewTarget",
    );
  // Shared callers also use direct issue_comment/workflow_dispatch runs whose
  // native check head belongs to the trusted workflow. Evidence authenticates
  // that event-specific identity before this projection can be published.
  if (
    !FULL_SHA_RE.test(identity.trusted_workflow_sha) ||
    !FULL_SHA_RE.test(identity.head_sha)
  )
    fail("invalid_check_identity", "Check identity SHAs must be full SHAs");
  if (!/^\d+$/.test(String(identity.workflow_run_id)))
    fail("invalid_check_identity", "workflow_run_id must be numeric");
  for (const key of [
    "workflow_run_attempt",
    "workflow_job_id",
    "check_run_id",
    "check_suite_id",
  ]) {
    if (!Number.isSafeInteger(identity[key]) || identity[key] <= 0)
      fail("invalid_check_identity", `${key} must be a positive safe integer`);
  }
  if (identity.app_slug !== "github-actions")
    fail(
      "invalid_check_identity",
      "Native review check must belong to github-actions",
    );
  return {
    ...structuredClone(identity),
    workflow_run_id: String(identity.workflow_run_id),
  };
}

function deriveCandidateSettlement(candidate, blockerPredicate = isMergeBlocker) {
  const openFindings = candidate.open_findings || [];
  const blockers = openFindings.filter(blockerPredicate);
  const conclusion = blockers.length > 0 ? "block" : "pass";
  const eligibleIssueIds = blockers
    .filter((finding) => finding.autonomous_eligibility === "YES")
    .map((finding) => finding.stable_id)
    .toSorted();
  let watcherAction = "settled";
  if (conclusion === "block") {
    watcherAction = blockers.some(
      (finding) => finding.disposition === "AUTHOR_DECISION",
    )
      ? "pause_for_human"
      : blockers.some((finding) => finding.autonomous_eligibility !== "YES")
        ? "human_owned"
        : "autonomous_batch";
  }
  return {
    conclusion,
    eligible_issue_ids: eligibleIssueIds,
    watcher_action: watcherAction,
  };
}

// Read compatibility only. Projection comments published before severity-aware
// settlement carry this derivation: every non-FOLLOW_UP finding blocks, and an
// unsigned follow-up proposal forces a human pause. Never build or publish a
// projection from it — verification accepts it on read so that PRs opened under
// the old policy keep their cumulative review state.
function deriveLegacySettlement(candidate) {
  const openFindings = candidate.open_findings || [];
  const proposedFollowUps = openFindings.filter(isProposedFollowUp);
  const blockers = openFindings.filter(
    (finding) => finding.disposition !== "FOLLOW_UP",
  );
  const conclusion =
    blockers.length > 0 || proposedFollowUps.length > 0 ? "block" : "pass";
  const eligibleIssueIds = blockers
    .filter((finding) => finding.autonomous_eligibility === "YES")
    .map((finding) => finding.stable_id)
    .toSorted();
  let watcherAction = "settled";
  if (conclusion === "block") {
    watcherAction =
      proposedFollowUps.length > 0 ||
      blockers.some((finding) => finding.disposition === "AUTHOR_DECISION")
        ? "pause_for_human"
        : blockers.some((finding) => finding.autonomous_eligibility !== "YES")
          ? "human_owned"
          : "autonomous_batch";
  }
  return {
    conclusion,
    eligible_issue_ids: eligibleIssueIds,
    watcher_action: watcherAction,
  };
}

function settlementMatches(projection, settlement) {
  return (
    canonicalJson(projection.eligible_issue_ids) ===
      canonicalJson(settlement.eligible_issue_ids) &&
    projection.conclusion === settlement.conclusion &&
    projection.watcher_action === settlement.watcher_action
  );
}

function buildProjection({
  candidate,
  target,
  humanDecisions = [],
  checkIdentity,
  summaryCommentId,
}) {
  const reviewTarget = buildReviewTarget(target);
  if (!Number.isSafeInteger(summaryCommentId) || summaryCommentId <= 0)
    fail(
      "invalid_publication_identity",
      "summaryCommentId must be a positive safe integer",
    );
  const decisions = normalizeHumanDecisions(humanDecisions);
  const openFindings = structuredClone(candidate.open_findings || []);
  const settlement = deriveCandidateSettlement({ open_findings: openFindings });
  const projectionBase = {
    schema_version: PROJECTION_SCHEMA_VERSION,
    projection_id: "",
    review_target: reviewTarget,
    review_target_hash: hashReviewTarget(reviewTarget),
    check_identity: normalizeCheckIdentity(checkIdentity, reviewTarget),
    summary_comment_id: summaryCommentId,
    prior_issue_evaluations: structuredClone(
      candidate.prior_issue_evaluations || [],
    ),
    open_findings: openFindings,
    closed_findings: structuredClone(candidate.closed_findings || []),
    consumed_evidence_challenge_refs: structuredClone(
      candidate.consumed_evidence_challenge_refs || [],
    ),
    human_decisions: decisions,
    eligible_issue_ids: settlement.eligible_issue_ids,
    watcher_action: settlement.watcher_action,
    conclusion: settlement.conclusion,
  };
  projectionBase.projection_id = `codex-review-v4-${hashCanonical(projectionBase).slice(0, 24)}`;
  const projection = {
    ...projectionBase,
    projection_sha256: hashCanonical(projectionBase),
  };
  verifyProjection({ projection });
  return projection;
}

function formatProjectionComment(input) {
  const projection = input?.projection || input;
  verifyProjection({ projection });
  return formatProjectionCommentUnchecked(projection);
}

// `allowLegacySettlement` is the read-compatibility switch for durable
// projection comments: parsing an already-published comment accepts either the
// current or the legacy settlement derivation, while building or formatting a
// projection this run publishes requires the current one.
function verifyProjection({ projection, allowLegacySettlement = false }) {
  if (
    !isObject(projection) ||
    projection.schema_version !== PROJECTION_SCHEMA_VERSION
  )
    fail("invalid_projection", "Expected projection schema version 4");
  if (!SHA256_RE.test(projection.projection_sha256 || ""))
    fail("invalid_projection", "Invalid projection hash");
  const { projection_sha256: claimedHash, ...unhashed } = projection;
  if (hashCanonical(unhashed) !== claimedHash)
    fail("projection_hash_mismatch", "Projection integrity check failed");
  exactKeys(
    projection,
    [
      "schema_version",
      "projection_id",
      "review_target",
      "review_target_hash",
      "check_identity",
      "summary_comment_id",
      "prior_issue_evaluations",
      "open_findings",
      "closed_findings",
      "consumed_evidence_challenge_refs",
      "human_decisions",
      "eligible_issue_ids",
      "watcher_action",
      "conclusion",
      "projection_sha256",
    ],
    "projection",
  );
  bounded(projection.projection_id, "projection ID", 200);
  if (!/^codex-review-v4-[0-9a-f]{24}$/.test(projection.projection_id))
    fail("invalid_projection", "Projection ID has an invalid format");
  const reviewTarget = buildReviewTarget(projection.review_target);
  if (projection.review_target_hash !== hashReviewTarget(reviewTarget))
    fail(
      "review_target_hash_mismatch",
      "Projection target hash does not match its full ReviewTarget",
    );
  normalizeCheckIdentity(projection.check_identity, reviewTarget);
  if (
    !Number.isSafeInteger(projection.summary_comment_id) ||
    projection.summary_comment_id <= 0
  )
    fail("invalid_projection", "summary_comment_id must be positive");
  if (
    !Array.isArray(projection.prior_issue_evaluations) ||
    !Array.isArray(projection.open_findings) ||
    !Array.isArray(projection.closed_findings) ||
    !Array.isArray(projection.consumed_evidence_challenge_refs) ||
    !Array.isArray(projection.human_decisions)
  )
    fail("invalid_projection", "Projection collections must be arrays");
  const openIds = new Set();
  for (const finding of projection.open_findings) {
    const normalized = normalizeFinding(finding, { target: reviewTarget });
    if (openIds.has(normalized.stable_id))
      fail(
        "invalid_projection",
        "Projection contains duplicate open finding IDs",
      );
    openIds.add(normalized.stable_id);
  }
  const evaluatedIds = new Set();
  const closingEvaluationsById = new Map();
  const evaluatedChallengeRefs = new Set();
  for (const evaluation of projection.prior_issue_evaluations) {
    if (!isObject(evaluation) || !STABLE_ID_RE.test(evaluation.stable_id || ""))
      fail(
        "invalid_projection",
        "Projection contains an invalid prior evaluation",
      );
    if (evaluatedIds.has(evaluation.stable_id))
      fail(
        "invalid_projection",
        "Projection contains duplicate prior evaluations",
      );
    evaluatedIds.add(evaluation.stable_id);
    if (evaluation.result === "still_open") {
      const hasChallengeRef = "challenge_ref" in evaluation;
      exactKeys(
        evaluation,
        hasChallengeRef
          ? ["stable_id", "result", "challenge_ref", "finding"]
          : ["stable_id", "result", "finding"],
        "projection still_open evaluation",
      );
      if (hasChallengeRef)
        bounded(evaluation.challenge_ref, "challenge ref", 2_048);
      const normalized = normalizeFinding(evaluation.finding, {
        target: reviewTarget,
      });
      if (
        normalized.stable_id !== evaluation.stable_id ||
        !openIds.has(evaluation.stable_id)
      )
        fail(
          "invalid_projection",
          "Still-open evaluation must appear in open_findings",
        );
    } else if (evaluation.result === "resolved_on_target") {
      exactKeys(
        evaluation,
        ["stable_id", "result", "evidence", "finding"],
        "projection resolved evaluation",
      );
      bounded(evaluation.evidence, "resolution evidence", 4_000);
    } else if (evaluation.result === "withdrawn_as_unsupported") {
      exactKeys(
        evaluation,
        ["stable_id", "result", "challenge_ref", "evidence", "finding"],
        "projection unsupported withdrawal evaluation",
      );
      bounded(evaluation.challenge_ref, "challenge ref", 2_048);
      bounded(evaluation.evidence, "withdrawal evidence", 4_000);
    } else if (evaluation.result === "superseded_by_human_decision") {
      exactKeys(
        evaluation,
        ["stable_id", "result", "decision_ref", "evidence", "finding"],
        "projection superseded evaluation",
      );
      bounded(evaluation.decision_ref, "supersession decision ref", 2_048);
      bounded(evaluation.evidence, "supersession evidence", 4_000);
    } else
      fail(
        "invalid_projection",
        "Projection contains an unknown prior evaluation result",
      );
    const normalized = normalizeFinding(evaluation.finding, {
      target: reviewTarget,
    });
    if (normalized.stable_id !== evaluation.stable_id)
      fail("invalid_projection", "Prior evaluation finding ID does not match");
    if (typeof evaluation.challenge_ref === "string")
      evaluatedChallengeRefs.add(evaluation.challenge_ref);
    if (evaluation.result !== "still_open")
      closingEvaluationsById.set(evaluation.stable_id, evaluation);
  }
  const closedIds = new Set();
  const closedRecordsById = new Map();
  for (const record of projection.closed_findings) {
    exactKeys(record, ["finding", "closure"], "closed finding record");
    const normalized = normalizeFinding(record.finding, {
      historicalFinding: true,
    });
    if (closedIds.has(normalized.stable_id))
      fail(
        "invalid_projection",
        "Projection contains duplicate closed finding IDs",
      );
    closedIds.add(normalized.stable_id);
    closedRecordsById.set(normalized.stable_id, record);
    const closure = record.closure;
    if (closure?.result === "resolved_on_target") {
      exactKeys(closure, ["result", "evidence"], "resolved closure");
      bounded(closure.evidence, "resolution evidence", 4_000);
    } else if (closure?.result === "withdrawn_as_unsupported") {
      exactKeys(
        closure,
        ["result", "evidence", "challenge_ref"],
        "withdrawn closure",
      );
      bounded(closure.evidence, "withdrawal evidence", 4_000);
      bounded(closure.challenge_ref, "challenge ref", 2_048);
    } else if (closure?.result === "superseded_by_human_decision") {
      exactKeys(
        closure,
        ["result", "evidence", "decision_ref"],
        "superseded closure",
      );
      bounded(closure.evidence, "supersession evidence", 4_000);
      bounded(closure.decision_ref, "supersession decision ref", 2_048);
    } else {
      fail("invalid_projection", "Projection contains an invalid closure");
    }
  }
  if (
    new Set(projection.consumed_evidence_challenge_refs).size !==
      projection.consumed_evidence_challenge_refs.length ||
    canonicalJson(projection.consumed_evidence_challenge_refs) !==
      canonicalJson([...projection.consumed_evidence_challenge_refs].toSorted())
  )
    fail(
      "invalid_projection",
      "consumed_evidence_challenge_refs must be unique and sorted",
    );
  for (const ref of projection.consumed_evidence_challenge_refs)
    bounded(ref, "consumed evidence challenge ref", 2_048);
  for (const [stableId, evaluation] of closingEvaluationsById) {
    const closedRecord = closedRecordsById.get(stableId);
    if (
      !closedRecord ||
      canonicalJson(closedRecord.finding) !==
        canonicalJson(evaluation.finding) ||
      canonicalJson(closedRecord.closure) !==
        canonicalJson(closureFromEvaluation(evaluation))
    )
      fail(
        "invalid_projection",
        "Closing evaluation does not match its canonical closed finding record",
      );
  }
  const consumedRefs = new Set(projection.consumed_evidence_challenge_refs);
  if ([...evaluatedChallengeRefs].some((ref) => !consumedRefs.has(ref)))
    fail(
      "invalid_projection",
      "Challenge-backed evaluation reference is absent from consumed evidence history",
    );

  projection.human_decisions.forEach(validateHumanDecision);
  const decisionsByRef = new Map();
  for (const decision of projection.human_decisions) {
    const ref = decisionRef(decision);
    if (decisionsByRef.has(ref))
      fail(
        "invalid_projection",
        "Projection contains duplicate human decision comment IDs",
      );
    decisionsByRef.set(ref, decision);
  }
  const requireDecisionRef = ({ stableId, ref }) => {
    if (ref === null || ref === undefined) return;
    const decision = decisionsByRef.get(ref);
    if (!decision || decision.stable_id !== stableId)
      fail(
        "invalid_projection",
        `Decision reference ${ref} does not resolve to a retained decision for ${stableId}`,
      );
  };
  for (const finding of projection.open_findings) {
    requireDecisionRef({
      stableId: finding.stable_id,
      ref: finding.decision_ref,
    });
  }
  for (const record of projection.closed_findings) {
    requireDecisionRef({
      stableId: record.finding.stable_id,
      ref: record.finding.decision_ref,
    });
    requireDecisionRef({
      stableId: record.finding.stable_id,
      ref: record.closure.decision_ref,
    });
  }
  for (const evaluation of projection.prior_issue_evaluations) {
    requireDecisionRef({
      stableId: evaluation.stable_id,
      ref: evaluation.decision_ref,
    });
  }
  if (
    !Array.isArray(projection.eligible_issue_ids) ||
    new Set(projection.eligible_issue_ids).size !==
      projection.eligible_issue_ids.length
  )
    fail("invalid_projection", "eligible_issue_ids must be a unique array");
  const currentSettlement = deriveCandidateSettlement(projection);
  const acceptedSettlements = allowLegacySettlement
    ? [currentSettlement, deriveCandidateSettlement(projection, wasMergeBlocker),
        deriveLegacySettlement(projection)]
    : [currentSettlement];
  if (
    !acceptedSettlements.some((settlement) =>
      settlementMatches(projection, settlement),
    )
  ) {
    if (
      canonicalJson(projection.eligible_issue_ids) !==
      canonicalJson(currentSettlement.eligible_issue_ids)
    )
      fail(
        "invalid_projection",
        "eligible_issue_ids were not derived from open findings",
      );
    if (projection.conclusion !== currentSettlement.conclusion)
      fail(
        "invalid_projection",
        "Projection conclusion was not derived from open findings",
      );
    if (!WATCHER_ACTIONS.includes(projection.watcher_action))
      fail("invalid_projection", "Unknown watcher action");
    fail(
      "watcher_action_mismatch",
      "Projection watcher action was not derived by trusted code",
    );
  }
  const bytes = Buffer.byteLength(
    formatProjectionCommentUnchecked(projection),
    "utf8",
  );
  if (bytes >= MAX_PROJECTION_COMMENT_BYTES)
    fail(
      "projection_overflow",
      `Compressed projection transport is ${bytes} bytes`,
    );
  return true;
}

function formatProjectionCommentUnchecked(projection) {
  const { label, payload } = encodeProjectionPayload(projection);
  return [
    PROJECTION_MARKER,
    "<details>",
    "<summary>Codex Review Projection v4 (compressed; do not edit)</summary>",
    "",
    "```text",
    label,
    payload,
    "```",
    "</details>",
  ].join("\n");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function collectProjectionTransportDictionaries(projection) {
  const keys = new Set();
  const stringCounts = new Map();
  const visit = (value) => {
    if (typeof value === "string") {
      stringCounts.set(value, (stringCounts.get(value) || 0) + 1);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      visit(entry);
    }
  };
  visit(projection);
  return {
    keys: [...keys].toSorted(compareUtf8),
    strings: [...stringCounts]
      .filter(
        ([value, count]) =>
          count >= 2 &&
          Buffer.byteLength(value, "utf8") >= MIN_INTERNED_STRING_BYTES,
      )
      .map(([value]) => value)
      .toSorted(compareUtf8),
  };
}

function buildProjectionTransport(projection) {
  const { keys, strings } = collectProjectionTransportDictionaries(projection);
  const keyIndexes = new Map(keys.map((key, index) => [key, index]));
  const stringIndexes = new Map(strings.map((value, index) => [value, index]));
  const compact = (value) => {
    if (typeof value === "string" && stringIndexes.has(value)) {
      return [2, stringIndexes.get(value)];
    }
    if (Array.isArray(value)) return [0, ...value.map(compact)];
    if (isObject(value)) {
      return [
        1,
        ...Object.keys(value)
          .toSorted(compareUtf8)
          .flatMap((key) => [keyIndexes.get(key), compact(value[key])]),
      ];
    }
    return value;
  };
  return [PROJECTION_TRANSPORT_VERSION, keys, strings, compact(projection)];
}

function expandProjectionTransport(transport) {
  if (
    !Array.isArray(transport) ||
    transport.length !== 4 ||
    transport[0] !== PROJECTION_TRANSPORT_VERSION
  ) {
    fail(
      "invalid_projection_payload",
      "Projection dictionary transport has an invalid envelope",
    );
  }
  const [, keys, strings, compactProjection] = transport;
  const validDictionary = (values) =>
    Array.isArray(values) &&
    values.every((value) => typeof value === "string") &&
    new Set(values).size === values.length &&
    canonicalJson(values) === canonicalJson([...values].toSorted(compareUtf8));
  if (!validDictionary(keys) || !validDictionary(strings)) {
    fail(
      "invalid_projection_payload",
      "Projection dictionary transport has invalid dictionaries",
    );
  }

  let expandedTextBytes = 0;
  const accountText = (value) => {
    expandedTextBytes += Buffer.byteLength(value, "utf8");
    if (expandedTextBytes > MAX_PROJECTION_JSON_BYTES) {
      fail(
        "invalid_projection_payload",
        "Projection payload exceeds the decoded size limit",
      );
    }
  };
  const expand = (value) => {
    if (!Array.isArray(value)) {
      if (typeof value === "string") accountText(value);
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        return value;
      }
      fail(
        "invalid_projection_payload",
        "Projection dictionary transport contains an invalid primitive",
      );
    }
    const marker = value[0];
    if (marker === 0) return value.slice(1).map(expand);
    if (marker === 2) {
      const index = value[1];
      if (
        value.length !== 2 ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= strings.length
      ) {
        fail(
          "invalid_projection_payload",
          "Projection dictionary transport has an invalid string reference",
        );
      }
      accountText(strings[index]);
      return strings[index];
    }
    if (marker !== 1 || value.length % 2 !== 1) {
      fail(
        "invalid_projection_payload",
        "Projection dictionary transport has an invalid value marker",
      );
    }
    const expanded = {};
    for (let index = 1; index < value.length; index += 2) {
      const keyIndex = value[index];
      if (
        !Number.isSafeInteger(keyIndex) ||
        keyIndex < 0 ||
        keyIndex >= keys.length
      ) {
        fail(
          "invalid_projection_payload",
          "Projection dictionary transport has an invalid key reference",
        );
      }
      const key = keys[keyIndex];
      if (Object.hasOwn(expanded, key)) {
        fail(
          "invalid_projection_payload",
          "Projection dictionary transport has a duplicate object key",
        );
      }
      accountText(key);
      Object.defineProperty(expanded, key, {
        configurable: true,
        enumerable: true,
        value: expand(value[index + 1]),
        writable: true,
      });
    }
    return expanded;
  };

  const projection = expand(compactProjection);
  if (!isObject(projection)) {
    fail(
      "invalid_projection_payload",
      "Projection dictionary transport must expand to an object",
    );
  }
  if (
    Buffer.byteLength(canonicalJson(projection), "utf8") >
    MAX_PROJECTION_JSON_BYTES
  ) {
    fail(
      "invalid_projection_payload",
      "Projection payload exceeds the decoded size limit",
    );
  }
  if (
    canonicalJson(buildProjectionTransport(projection)) !==
    canonicalJson(transport)
  ) {
    fail(
      "invalid_projection_payload",
      "Projection dictionary transport is not canonical",
    );
  }
  return projection;
}

function encodeProjectionPayload(projection) {
  const encode = (value) =>
    deflateRawSync(Buffer.from(canonicalJson(value)), {
      level: zlibConstants.Z_BEST_COMPRESSION,
    }).toString("base64");
  const candidates = [
    {
      label: LEGACY_PROJECTION_PAYLOAD_LABEL,
      payload: encode(projection),
    },
    {
      label: PROJECTION_PAYLOAD_LABEL,
      payload: encode(buildProjectionTransport(projection)),
    },
  ];
  return candidates.toSorted(
    (left, right) =>
      left.label.length +
      left.payload.length -
      (right.label.length + right.payload.length),
  )[0];
}

function decodeProjectionPayload(encoded) {
  if (
    !CANONICAL_BASE64_RE.test(encoded) ||
    Buffer.from(encoded, "base64").toString("base64") !== encoded
  ) {
    fail(
      "invalid_projection_payload",
      "Projection payload is not canonical base64",
    );
  }
  const compressed = Buffer.from(encoded, "base64");
  let inflated;
  try {
    inflated = inflateRawSync(compressed, {
      info: true,
      maxOutputLength: MAX_PROJECTION_JSON_BYTES,
    });
  } catch (error) {
    fail(
      "invalid_projection_payload",
      `Projection payload could not be decompressed: ${error.message}`,
    );
  }
  if (inflated.engine.bytesWritten !== compressed.length) {
    fail(
      "invalid_projection_payload",
      "Projection payload contains trailing compressed data",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(inflated.buffer);
  } catch (error) {
    fail(
      "invalid_projection_payload",
      `Projection payload is not valid UTF-8: ${error.message}`,
    );
  }
}

function parseProjectionComment({ body }) {
  if (typeof body !== "string" || !body.startsWith(PROJECTION_MARKER))
    return null;
  const blocks = [
    ...body.matchAll(
      /```text\n(codex-review:v4:(?:dictionary\+deflate-raw|deflate-raw)\+base64)\n([A-Za-z0-9+/=]+)\n```/g,
    ),
  ];
  if (blocks.length !== 1)
    fail(
      "invalid_projection_comment",
      "Projection comment must contain exactly one compressed v4 payload",
    );
  const [, payloadLabel, encodedPayload] = blocks[0];
  const json = decodeProjectionPayload(encodedPayload);
  let decoded;
  try {
    decoded = JSON.parse(json);
  } catch (error) {
    fail(
      "invalid_projection_json",
      `Projection JSON could not be parsed: ${error.message}`,
    );
  }
  if (canonicalJson(decoded) !== json)
    fail("noncanonical_projection", "Projection JSON is not canonical");
  const projection =
    payloadLabel === PROJECTION_PAYLOAD_LABEL
      ? expandProjectionTransport(decoded)
      : decoded;
  verifyProjection({ projection, allowLegacySettlement: true });
  return projection;
}

function buildMechanicalCandidate({ priorProjection, target, reason }) {
  bounded(reason, "mechanical review reason", 2_000);
  const reviewTarget = buildReviewTarget(target);
  const priorIssueEvaluations = (priorProjection?.open_findings || []).map(
    (prior) => ({
      stable_id: prior.stable_id,
      result: "still_open",
      finding: {
        ...structuredClone(prior),
        last_evaluated_target: hashReviewTarget(reviewTarget),
      },
    }),
  );
  return {
    review_markdown: reason,
    inline_comments: [],
    prior_issue_evaluations: priorIssueEvaluations,
    new_findings: [],
  };
}

// Shared action/local-settlement adapters. Model output omits fields owned by
// the engine; bind those fields before entering the moved Intavia state machine.
function foldReview({ output, target, priorProjection = null, humanDecisions = [], evidenceChallenges = [], priorProjections = [] }) {
  const priorById = new Map((prepareReviewPriorProjection({ priorProjection, priorProjections, humanDecisions })?.open_findings || [])
    .map((finding) => [finding.stable_id, finding]));
  const bindFinding = (finding, prior = null) => ({
    ...finding,
    first_evidence_sha: prior?.first_evidence_sha || target.head_sha,
    last_evaluated_target: hashReviewTarget(target),
    decision_ref: prior?.decision_ref || null,
    follow_up: prior?.follow_up || null,
  });
  return validateCandidate({
    rawOutput: {
      review_markdown: output.review_markdown || "",
      inline_comments: output.inline_comments || [],
      new_findings: output.new_findings.map((finding) => bindFinding(finding)),
      prior_issue_evaluations: output.prior_issue_evaluations.map((evaluation) =>
        isObject(evaluation) ? {
          ...evaluation,
          finding: bindFinding(evaluation.finding, priorById.get(evaluation.stable_id)),
        } : evaluation),
    },
    target,
    priorProjection,
    evidence: { human_decisions: humanDecisions, evidence_challenges: evidenceChallenges, prior_projections: priorProjections },
  });
}

function readProjectionComment(body) {
  return parseProjectionComment({ body });
}

function validateProjection(projection, { existing = false } = {}) {
  verifyProjection({ projection, allowLegacySettlement: existing });
  return projection;
}

function settlement(findings) {
  return deriveCandidateSettlement({ open_findings: findings });
}

module.exports = {
  ContractError,
  foldReview,
  hashCanonical,
  readProjectionComment,
  validateProjection,
  settlement,
  MAX_NEW_FINDINGS,
  MAX_PROJECTION_COMMENT_BYTES,
  LEGACY_PROJECTION_PAYLOAD_LABEL,
  PROJECTION_MARKER,
  PROJECTION_PAYLOAD_LABEL,
  PROJECTION_SCHEMA_VERSION,
  WATCHER_ACTIONS,
  buildMechanicalCandidate,
  buildProjection,
  challengeRef,
  consumedChallengeRefs,
  deriveCandidateSettlement,
  formatProjectionComment,
  isMergeBlocker,
  isProposedFollowUp,
  parseProjectionComment,
  prepareReviewPriorProjection,
  validateCandidate,
  verifyProjection,
};
