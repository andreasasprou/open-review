---

## Output

Your response is structured by `--output-schema`. Fill `review_markdown`,
`inline_comments`, `state`, `new_findings`, and `prior_issue_evaluations`.
The publisher owns the ledger and derives the merge gate. Markdown does not
settle findings.

### `review_markdown`

Keep the visible review format:

```markdown
## Verdict: [BLOCK | ATTENTION | OK]

### Findings
- [If none: None.]
- [Otherwise, for each finding: severity, reachability, likelihood,
  recoverability, title, failure scenario, location, consequence, evidence]

### Risks Not Raised
- [brief note on checked areas that were not findings]

## Human Reviewer Callouts (Non-Blocking)
- [applicable callouts, or "- (none)"]
```

`## Verdict:` is a display label. A P0/P1 finding on a normal or compound path
blocks unless an authenticated owner decision defers it. P2 and theoretical
findings are advisory. An unapproved `FOLLOW_UP` proposal that does not meet
the narrow P2/low-likelihood/routine-recovery rule becomes `AUTHOR_DECISION` in
the publisher; keep the finding in structured output. No finding is removed for
pre-existing attribution or because it was outside the latest repair delta.

### `new_findings`

Include every genuinely new supported finding, up to the existing 25-finding
output safety limit. Use a stable ID that does not appear in
`.codex-ci/ledger-evidence.json` `reservedFindingIds`. Do not include a prior
finding here; evaluate it below. The parent reviewer, not child finders,
chooses `disposition` and `autonomous_eligibility`.

For each finding, fill every schema field. Preserve the complete risk chain:
`severity`, `reachability`, `likelihood`, `likely_consequence`,
`worst_credible_consequence`, `recoverability`, `proof_strength`,
`attribution`, and `risk_rationale`. State a concrete frozen
`failure_scenario`, the already approved `approved_invariant`, current `where`
and `evidence`. `affected_lifecycle_planes` is a string array using the
repository's rule pack when it defines a taxonomy; otherwise use `[]`.

`FIX_IN_PR` proposes repair of an approved invariant. Set
`autonomous_eligibility: YES` only for a bounded local repair. `AUTHOR_DECISION`
requests an owner choice and must be `NO`. `FOLLOW_UP` proposes deferred work and
must be `NO`. An unapproved proposal may be advisory only when P2, low
likelihood, compound or theoretical, routinely recoverable, and not relied on
by the PR. A pre-existing finding still belongs in the ledger: propose
`FOLLOW_UP`; the publisher will request an owner decision if it cannot be an
advisory follow-up.

### `prior_issue_evaluations`

Read `.codex-ci/prior-projection.json`. For every prior open `stable_id`, emit
one evaluation with the same ID and a complete current finding. Preserve its
frozen `failure_scenario` and `approved_invariant` unless a collected owner
decision changes the invariant. The publisher carries any omitted prior finding
forward as `still_open` and warns; omission never closes it.

Every evaluation must include `evidence`, `challenge_ref`, and `decision_ref`.
Use `null` for a field that does not apply to its result. A non-null
`challenge_ref` on `still_open` means the authenticated challenge was considered.

- `still_open`: report the current finding. If this answers an unconsumed
  authenticated evidence challenge, copy its supplied `github-comment:<id>`
  into `challenge_ref`.
- `resolved_on_target`: provide current-target `evidence` that makes the frozen
  scenario unreachable. A same-head correction needs a challenge instead.
- `withdrawn_as_unsupported`: provide independent `evidence` and the exact
  unconsumed authenticated `challenge_ref` from
  `.codex-ci/ledger-evidence.json`. The challenge alone never settles it.
- `superseded_by_human_decision`: provide current-target `evidence` and the
  exact authenticated `decision_ref` that covers the invariant and scope.

Do not use a free-form reply, thread resolution, missing ID, or Markdown to
close a prior finding. A new failure scenario gets a new stable ID. The
publisher preserves closed snapshots and consumed challenge history.

### `inline_comments`

When a finding has a safe changed-line anchor, use its `stable_id` as
`issue_id`, exact diff `file`, ending `line`, optional `start_line` (`null` for a
single line), `title`, `body`, `category`, and optional `suggestion` (`null`
when none). All findings appear in the summary even without inline anchors.

### `state`

Return metadata only: `schema_version: 1`, `last_reviewed_head_sha` equal to the
current review head, current `review_count`, ISO-8601 `updated_at`, and a short
`pr_summary`. Existing finding state belongs to the publisher's v4 ledger.
