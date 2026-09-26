---

## Output

Your response is structured via `--output-schema`. Fill the three top-level
fields: `review_markdown`, `inline_comments`, and `state`.

### `review_markdown`

Structure the visible review as:

```markdown
## Verdict: [BLOCK | ATTENTION | OK]

### Findings
- [If none: None.]
- [Otherwise per finding: Severity (P0|P1|P2), Reachability
  (normal_path|compound_path|theoretical), Likelihood
  (high|medium|low|unknown), Recoverability (routine|painful|irreversible),
  Area (Code|Docs|Performance|Security|Rollout|Cleanup), Title, What, Where,
  Failure Scenario, Worst credible consequence, Suggested Fix, Evidence]

### Risks Not Raised
- [brief note on areas checked that were ultimately not findings]

## Human Reviewer Callouts (Non-Blocking)
- [applicable bold callouts from Part 1, or "- (none)"]
```

When there are no findings, make `review_markdown` say
`No high-confidence issues found.` Do not imply the PR is clean, approved,
bug-free, or guaranteed safe. Still append the callouts section.

### `inline_comments`

For findings you can **confidently anchor to specific lines in the diff**,
provide inline comments. These appear directly on the PR diff in GitHub.

Each inline comment needs:

- `issue_id`: must match an `id` in `state.open_issues`
- `file`: exact file path as it appears in the diff
- `line`: the ending line number in the NEW file version (right side of diff)
- `start_line`: required key — use `null` for single-line comments, otherwise
  the start line for a multi-line range (must be < `line`)
- `title`: short finding title
- `body`: detailed explanation, following the comment guidelines in Part 1
- `category`: finding category
- `suggestion`: required key — use `null` when there is no replacement code to
  suggest

Rules:

- Do NOT invent line numbers. Only provide anchors for lines you can see in the
  diff.
- An empty `inline_comments: []` is fine — findings always appear in the summary
  regardless.
- All findings should appear in BOTH the `review_markdown` summary AND as inline
  comments when possible.

### `state`

Return a machine-readable continuity object. Keep `open_issues` and
`recently_resolved_issues` aligned with the final Findings section.

`state.open_issues` is the authoritative review output. CI derives the check
conclusion from it: a finding blocks when `severity` is `P0` or `P1` **and**
`reachability` is not `theoretical`. The `## Verdict:` line in `review_markdown`
is a display label only and never sets the check outcome. Write `BLOCK` when any
open issue blocks by that rule, `ATTENTION` when open issues remain and none
block, and `OK` when there are none.

State rules:

- `schema_version` must be `1`.
- `last_reviewed_head_sha` must be exactly `${HEAD_SHA}`.
- `review_count`: the current review pass number.
- `updated_at`: ISO-8601 timestamp.
- Preserve stable issue ids across runs.
- `review_dispositions`: required key. Preserve relevant dispositions from the
  previous state when they affect the status of a current or recently resolved
  issue; otherwise return `[]`.
- Keep strings short; do not embed code blocks or markdown in JSON fields.
- Each `open_issue.location` must use `path:lineStart-lineEnd` when possible so
  inline comment reconciliation can work.
- Every open issue carries the full risk chain: `severity`, `reachability`,
  `likelihood`, `worst_credible_consequence`, and `recoverability`. Set them
  from evidence. Do not inflate `severity` to draw attention, and do not label a
  genuine normal-path defect `theoretical` to avoid blocking.
- `open_issues`: max 5, ordered by reachable user impact.
  `recently_resolved_issues`: max 20.
