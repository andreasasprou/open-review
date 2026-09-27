"use strict";

const {
  buildMechanicalCandidate,
  buildProjection,
  deriveCandidateSettlement,
  formatProjectionComment,
  isMergeBlocker,
  validateCandidate,
} = require("./projection.cjs");

const SUMMARY_MARKER = "<!-- codex-review:summary:v2 -->";
const MAX_SUMMARY_BYTES = 60_000;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeStructuredText(value) {
  return escapeHtml(value)
    .replace(/([\\`*_[\]{}()#+\-.!|])/g, "\\$1")
    .replaceAll(":", "&#58;")
    .replaceAll("@", "&#64;");
}

function escapeTableCell(value) {
  return escapeStructuredText(value).replace(/\s+/g, " ").trim();
}

function findingNextStep(finding, watcherAction) {
  if (finding.disposition === "FOLLOW_UP")
    return finding.decision_ref
      ? "Track separately"
      : "Optional follow-up; does not block merge";
  if (!isMergeBlocker(finding)) return "Advisory; does not block merge";
  if (finding.disposition === "AUTHOR_DECISION")
    return "Choose the product or architecture direction";
  if (watcherAction === "pause_for_human") return "Wait for the human decision";
  if (watcherAction === "human_owned")
    return "Provide the required action, access, or proof";
  return finding.autonomous_eligibility === "YES"
    ? "Agent can fix in this PR"
    : "Discuss the implementation before changing code";
}

function formatFindingDetails(finding, watcherAction) {
  const lines = [
    "<details>",
    `<summary><strong>${finding.severity} · ${escapeStructuredText(finding.title)}</strong> — ${findingNextStep(finding, watcherAction)}</summary>`,
    "",
    `- **Stable ID:** \`${finding.stable_id}\``,
    `- **Disposition:** \`${finding.disposition}\``,
    `- **Reachability:** \`${finding.reachability}\``,
    `- **Likelihood:** \`${finding.likelihood}\``,
    `- **Likely consequence:** ${escapeStructuredText(finding.likely_consequence)}`,
    `- **Worst credible consequence:** ${escapeStructuredText(finding.worst_credible_consequence)}`,
    `- **Recoverability:** \`${finding.recoverability}\``,
    `- **Proof strength:** \`${finding.proof_strength}\``,
    `- **Attribution:** \`${finding.attribution}\``,
    `- **Risk decision:** ${escapeStructuredText(finding.risk_rationale)}`,
    `- **Failure scenario:** ${escapeStructuredText(finding.failure_scenario)}`,
    `- **Required invariant:** ${escapeStructuredText(finding.approved_invariant)}`,
    `- **Where:** ${escapeStructuredText(finding.where)}`,
    `- **Current evidence:** ${escapeStructuredText(finding.evidence)}`,
  ];
  if (finding.affected_lifecycle_planes.length > 0) {
    lines.push(
      `- **Affected areas:** ${finding.affected_lifecycle_planes.join(", ")}`,
    );
  }
  if (finding.follow_up) {
    lines.push(
      `- **Follow-up:** ${escapeStructuredText(finding.follow_up.tracker)} — ${escapeStructuredText(finding.follow_up.owner_or_triage)}`,
    );
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

function formatReviewTarget(target) {
  if (!target) return "";
  const rows = [
    ["Repository", target.repository],
    ["PR", String(target.pr_number)],
    ["Base", `${target.base_ref}@${target.base_sha}`],
    ["Merge base", target.merge_base_sha],
    ["Head", target.head_sha],
    ["Trusted reviewer", target.trusted_reviewer_ref],
    ["Evidence bundle", target.evidence_bundle_sha256],
    ["Evidence schema", String(target.evidence_schema_version)],
  ];
  return [
    `<details><summary>Review target · <code>${escapeHtml(target.head_sha)}</code></summary>`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(
      ([name, value]) => `| ${name} | <code>${escapeHtml(value)}</code> |`,
    ),
    "",
    "</details>",
  ].join("\n");
}

function formatPriorIssueDetails(evaluations = []) {
  if (evaluations.length === 0) return "";
  const rows = evaluations.map((evaluation) => {
    const result = evaluation.result.replaceAll("_", " ");
    const evidence = evaluation.evidence
      ? ` — ${escapeTableCell(evaluation.evidence)}`
      : "";
    return `- \`${evaluation.stable_id}\`: **${result}**${evidence}`;
  });
  return [
    "<details>",
    `<summary>Prior findings (${evaluations.length})</summary>`,
    "",
    ...rows,
    "",
    "</details>",
  ].join("\n");
}

function formatDecisionSupersessions(decisions = []) {
  const byIssue = new Map();
  for (const decision of decisions.toSorted(
    (left, right) => left.comment_id - right.comment_id,
  )) {
    const issueDecisions = byIssue.get(decision.stable_id) || [];
    issueDecisions.push(decision);
    byIssue.set(decision.stable_id, issueDecisions);
  }
  const lines = [];
  for (const [stableId, issueDecisions] of byIssue) {
    if (issueDecisions.length < 2) continue;
    const controlling = issueDecisions.at(-1);
    const superseded = issueDecisions
      .slice(0, -1)
      .map((decision) => `\`${decision.comment_id}\``)
      .join(", ");
    lines.push(
      `- \`${stableId}\`: decision comment \`${controlling.comment_id}\` controls and supersedes ${superseded}.`,
    );
  }
  return lines.length > 0
    ? ["### Decision supersession", "", ...lines].join("\n")
    : "";
}

function formatReviewSummary(
  candidate,
  { includeAnalysis = true, target = null, humanDecisions = [] } = {},
) {
  const findings = candidate.open_findings || [];
  const blockers = findings.filter(isMergeBlocker);
  const settlement = deriveCandidateSettlement(candidate);
  const resolvedOnTargetCount = (
    candidate.prior_issue_evaluations || []
  ).filter((evaluation) => evaluation.result === "resolved_on_target").length;
  const withdrawnUnsupportedCount = (
    candidate.prior_issue_evaluations || []
  ).filter(
    (evaluation) => evaluation.result === "withdrawn_as_unsupported",
  ).length;
  const supersededCount = (candidate.prior_issue_evaluations || []).filter(
    (evaluation) => evaluation.result === "superseded_by_human_decision",
  ).length;
  const verdict = {
    autonomous_batch: "Changes requested",
    human_owned: "Changes requested — human action needed",
    pause_for_human: "Product or architecture decision needed",
    settled: "Review passed",
  }[settlement.watcher_action];
  const overview = {
    autonomous_batch: `${blockers.length} concrete fix${blockers.length === 1 ? " is" : "es are"} ready for the implementing agent.`,
    human_owned: `${blockers.length} already-decided repair${blockers.length === 1 ? " needs" : "s need"} an action, permission, credential, or proof before completion.`,
    pause_for_human: `${blockers.length} finding${blockers.length === 1 ? " needs" : "s need"} human direction before merge.`,
    settled:
      findings.length > 0
        ? `No merge blockers; ${findings.length} advisory finding${findings.length === 1 ? " is" : "s are"} published for the author.`
        : "No open findings.",
  }[settlement.watcher_action];
  const progress = [
    resolvedOnTargetCount > 0
      ? `${resolvedOnTargetCount} prior finding${resolvedOnTargetCount === 1 ? " was" : "s were"} resolved on this head.`
      : "",
    withdrawnUnsupportedCount > 0
      ? `${withdrawnUnsupportedCount} prior finding${withdrawnUnsupportedCount === 1 ? " was" : "s were"} withdrawn after independent evidence review.`
      : "",
    supersededCount > 0
      ? `${supersededCount} prior finding${supersededCount === 1 ? " was" : "s were"} superseded by a human decision.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const targetDetails = formatReviewTarget(target);
  const lines = [
    `## ${verdict}`,
    "",
    `${overview}${progress ? ` ${progress}` : ""}`,
  ];
  if (targetDetails) lines.push("", targetDetails);
  const decisionSupersessions = formatDecisionSupersessions(humanDecisions);
  if (decisionSupersessions) lines.push("", decisionSupersessions);

  if (findings.length > 0) {
    lines.push(
      "",
      "### What needs attention",
      "",
      "| Severity | Finding | Next step |",
      "| --- | --- | --- |",
      ...findings.map(
        (finding) =>
          `| ${finding.severity} | ${escapeTableCell(finding.title)} | ${findingNextStep(finding, settlement.watcher_action)} |`,
      ),
      "",
      ...findings.flatMap((finding) => [
        formatFindingDetails(finding, settlement.watcher_action),
        "",
      ]),
    );
  }

  const prior = formatPriorIssueDetails(candidate.prior_issue_evaluations);
  if (prior) lines.push(prior, "");

  const rawMarkdown = String(candidate.review_markdown || "")
    .replace(SUMMARY_MARKER, "")
    .trim();
  if (includeAnalysis && rawMarkdown) {
    lines.push(
      "<details>",
      "<summary>Reviewer context</summary>",
      "",
      escapeHtml(rawMarkdown),
      "",
      "</details>",
    );
  }
  return lines.join("\n").trim();
}

// Subagent threads bill separately and never reach the orchestrator's
// `turn.completed` event, so the token scope has to be stated explicitly.
function formatTokenScope(metadata = {}) {
  if (metadata.usageScope !== "all-threads") return "orchestrator thread only";
  const threads = Number(metadata.threadCount) || 0;
  const subagents = Number(metadata.subagentCount) || 0;
  const orchestrators = Math.max(threads - subagents, 0);
  return `all ${threads} threads (${orchestrators} orchestrator + ${subagents} subagent)`;
}

function buildMetadataFooter(metadata = {}) {
  const rows = [
    ["Model", metadata.model || "unknown"],
    ["Reasoning effort", metadata.reasoningEffort || "unknown"],
    ["Duration", `${metadata.duration || 0}s`],
    ["Input tokens", String(metadata.inputTokens || 0)],
    ["Cached tokens", String(metadata.cachedTokens || 0)],
    ["Output tokens", String(metadata.outputTokens || 0)],
    ["Reasoning tokens", String(metadata.reasoningTokens || 0)],
    ["Token scope", formatTokenScope(metadata)],
  ];
  // Incremental rounds resume the prior round's session, so the per-round
  // decision is the only place the rollout can be measured from real runs.
  if (metadata.reviewMode) rows.push(["Review mode", metadata.reviewMode]);
  if (metadata.resumeDecision) {
    rows.push(["Session resume", metadata.resumeDecision]);
  }
  return [
    "",
    "---",
    "<details>",
    "<summary>Review metadata</summary>",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    "",
    "</details>",
  ].join("\n");
}

function formatRejectedRecords(records = []) {
  if (!Array.isArray(records) || records.length === 0) return "";
  const lines = records.slice(0, 20).map((record) => {
    const id = record?.comment_id || record?.id || "unknown";
    const reason = String(record?.reason || "invalid authoritative record")
      .replace(/\s+/g, " ")
      .slice(0, 500);
    return `- Comment ${id}: ${reason}`;
  });
  if (records.length > lines.length) {
    lines.push(
      `- ${records.length - lines.length} more rejected record(s) are in the evidence bundle.`,
    );
  }
  return [
    "<details>",
    `<summary>Rejected authoritative records (${records.length})</summary>`,
    "",
    "These marker-shaped records were ignored by trusted validation:",
    "",
    ...lines,
    "",
    "</details>",
  ].join("\n");
}

function buildSummaryBody({
  candidate,
  target,
  metadata,
  rejectedRecords,
  humanDecisions,
}) {
  const render = (includeAnalysis) =>
    [
      SUMMARY_MARKER,
      formatReviewSummary(candidate, {
        includeAnalysis,
        target,
        humanDecisions,
      }),
      formatRejectedRecords(rejectedRecords),
      buildMetadataFooter(metadata),
    ]
      .filter(Boolean)
      .join("\n");
  let body = render(true);
  if (Buffer.byteLength(body, "utf8") >= MAX_SUMMARY_BYTES) {
    body = render(false);
  }
  if (Buffer.byteLength(body, "utf8") >= MAX_SUMMARY_BYTES) {
    throw new Error(
      `Review summary exceeds ${MAX_SUMMARY_BYTES} UTF-8 bytes; split this PR.`,
    );
  }
  return body;
}

async function revalidateTarget({ github, owner, repo, prNumber, target, eventName }) {
  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const actualRepository = `${owner}/${repo}`;
  if (
    target.repository !== actualRepository ||
    target.pr_number !== prNumber ||
    pr.base?.ref !== target.base_ref ||
    pr.base?.sha !== target.base_sha ||
    pr.head?.sha !== target.head_sha ||
    (eventName !== "workflow_dispatch" && pr.head?.repo?.full_name !== actualRepository)
  ) {
    throw new Error(
      "The PR target moved before publication; this review is superseded.",
    );
  }
}

function parseDiffHunks({ patch }) {
  const allowlist = new Map();
  let currentPath = null;
  let currentLine = 0;
  let inHunk = false;
  for (const line of String(patch || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
    } else if (line.startsWith("+++ ")) {
      const nextPath = line.slice(4).trim();
      currentPath =
        nextPath === "/dev/null" ? null : nextPath.replace(/^b\//, "");
      if (currentPath && !allowlist.has(currentPath))
        allowlist.set(currentPath, new Set());
    } else if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      inHunk = Boolean(match);
      if (match) currentLine = Number(match[1]) - 1;
    } else if (inHunk && currentPath) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentLine += 1;
        allowlist.get(currentPath).add(currentLine);
      } else if (line.startsWith(" ")) {
        currentLine += 1;
        allowlist.get(currentPath).add(currentLine);
      }
    }
  }
  return allowlist;
}

function validateInlineComments({
  comments,
  patch,
  openIssueIds,
  log = () => {},
}) {
  const allowlist = parseDiffHunks({ patch });
  const dedupe = new Set();
  const valid = [];
  for (const comment of comments || []) {
    const file = String(comment?.file || "");
    const line = Number(comment?.line);
    const issueId = String(comment?.issue_id || "");
    const startLine = comment?.start_line;
    const key = `${issueId}:${file}:${startLine || ""}:${line}`;
    if (
      !openIssueIds.has(issueId) ||
      !Number.isSafeInteger(line) ||
      line <= 0 ||
      !allowlist.get(file)?.has(line) ||
      (startLine != null &&
        (!Number.isSafeInteger(startLine) ||
          startLine >= line ||
          !allowlist.get(file)?.has(startLine))) ||
      dedupe.has(key)
    ) {
      log(
        `Ignoring invalid inline comment ${issueId || "unknown"} at ${file || "unknown"}:${line || 0}`,
      );
      continue;
    }
    dedupe.add(key);
    valid.push(comment);
  }
  return valid;
}

function formatInlineBody(comment, severity) {
  const title = severity ? `[${severity}] ${comment.title}` : comment.title;
  const parts = [`**${title}**`, comment.body];
  if (comment.category) parts.push(`*Category: ${comment.category}*`);
  if (comment.suggestion)
    parts.push(`\`\`\`suggestion\n${comment.suggestion}\n\`\`\``);
  return parts.filter(Boolean).join("\n\n");
}

async function publishInlineComments({
  github,
  owner,
  repo,
  prNumber,
  target,
  candidate,
  trustedPatch,
  summaryCommentId,
  log,
}) {
  if (!candidate.inline_comments.length) return null;
  const findingsById = new Map(
    candidate.open_findings.map((finding) => [finding.stable_id, finding]),
  );
  const comments = validateInlineComments({
    comments: candidate.inline_comments,
    patch: trustedPatch,
    openIssueIds: new Set(findingsById.keys()),
    log,
  }).map((comment) => {
    const reviewComment = {
      path: comment.file,
      line: comment.line,
      side: "RIGHT",
      body: formatInlineBody(
        comment,
        findingsById.get(comment.issue_id)?.severity,
      ),
    };
    if (comment.start_line != null) {
      reviewComment.start_line = comment.start_line;
      reviewComment.start_side = "RIGHT";
    }
    return reviewComment;
  });
  if (!comments.length) return null;
  const { data: review } = await github.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: target.head_sha,
    event: "COMMENT",
    body: `See review summary comment ${summaryCommentId}.`,
    comments,
  });
  return review.id;
}

function reviewLog(message) {
  process.stdout.write(`[codex-review] ${message}\n`);
}

async function postResults({
  github,
  owner,
  repo,
  prNumber,
  target,
  priorProjection = null,
  evidence,
  checkIdentity,
  modelOutput = null,
  trustedPatch = "",
  mechanicalReason = null,
  metadata = {},
  // Shared-engine wiring: the existing visible review owns summary and inline
  // lifecycle. The pinned publisher still owns projection preflight/publication.
  candidate: suppliedCandidate = null,
  summaryBody: suppliedSummaryBody = null,
  skipInlineComments = false,
  revalidateAuthority = async () => {},
  eventName = "pull_request_target",
}) {
  if (priorProjection) {
    const priorCheck = priorProjection.check_identity;
    if (!priorCheck) throw new Error("Prior projection has no workflow run identity");
    const currentRun = BigInt(checkIdentity.workflow_run_id);
    const priorRun = BigInt(priorCheck.workflow_run_id);
    if (currentRun < priorRun || currentRun === priorRun &&
      checkIdentity.workflow_run_attempt <= priorCheck.workflow_run_attempt) {
      throw new Error("Normal publication requires a newer workflow run or attempt");
    }
  }
  const rawOutput = mechanicalReason
    ? buildMechanicalCandidate({
        priorProjection,
        target,
        reason: mechanicalReason,
      })
    : modelOutput;
  if (!suppliedCandidate && !rawOutput) {
    throw new Error("Model output is missing.");
  }
  const candidate = suppliedCandidate || validateCandidate({
    rawOutput,
    target,
    priorProjection,
    evidence,
  });
  const summaryBody = suppliedSummaryBody || buildSummaryBody({
    candidate,
    target,
    metadata,
    rejectedRecords: evidence?.rejected_records,
    humanDecisions: evidence?.human_decisions || [],
  });

  // Validate the complete projection before publishing a summary. The largest
  // accepted integer makes the preflight at least as large as the real GitHub
  // comment ID, so a deterministic projection overflow cannot leave an
  // authoritative-looking summary without its projection.
  const preflightProjection = buildProjection({
    candidate,
    target,
    priorProjection,
    humanDecisions: evidence?.human_decisions || [],
    checkIdentity,
    summaryCommentId: Number.MAX_SAFE_INTEGER,
  });
  formatProjectionComment({ projection: preflightProjection });

  await revalidateAuthority();
  await revalidateTarget({ github, owner, repo, prNumber, target, eventName });
  const { data: summary } = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: summaryBody,
  });
  reviewLog(`Published additive summary comment ${summary.id}.`);

  const projection = buildProjection({
    candidate,
    target,
    priorProjection,
    humanDecisions: evidence?.human_decisions || [],
    checkIdentity,
    summaryCommentId: summary.id,
  });
  await revalidateAuthority();
  await revalidateTarget({ github, owner, repo, prNumber, target, eventName });
  const { data: projectionComment } = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: formatProjectionComment({ projection }),
  });
  reviewLog(
    `Published additive projection comment ${projectionComment.id} with projection SHA-256 ${projection.projection_sha256}.`,
  );

  let inlineReviewId = null;
  try {
    inlineReviewId = skipInlineComments ? null : await publishInlineComments({
      github,
      owner,
      repo,
      prNumber,
      target,
      candidate,
      trustedPatch,
      summaryCommentId: summary.id,
      log: reviewLog,
    });
  } catch (error) {
    reviewLog(
      `Inline review publication failed without changing settlement: ${error.message}`,
    );
  }

  return {
    candidate,
    projection,
    summaryCommentId: summary.id,
    projectionCommentId: projectionComment.id,
    inlineReviewId,
    shouldFail: projection.conclusion !== "pass",
  };
}

module.exports = {
  MAX_SUMMARY_BYTES,
  SUMMARY_MARKER,
  buildMetadataFooter,
  formatReviewTarget,
  formatReviewSummary,
  buildSummaryBody,
  formatInlineBody,
  formatRejectedRecords,
  parseDiffHunks,
  postResults,
  publishInlineComments,
  revalidateTarget,
  validateInlineComments,
};
