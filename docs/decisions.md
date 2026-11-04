# Engine decisions

Why the engine uses its current models, workers, limits and stages, and which
alternatives were tested and rejected. Read this before you propose a model or
architecture change, and add an entry when you make one (see `AGENTS.md` and
[the evaluation protocol](evaluation-protocol.md)).

The numbers are aggregates from private evaluation sets. Per-PR evidence stays
with the consumer repositories that own the PRs.

- **Development set:** 14 PRs from one consumer, 33 known defects. It was used
  for tuning, so gains measured on it are optimistic.
- **Held-out set:** 12 PRs from two other consumers: 8 with 10 known defects
  and 4 controls without one. It is never used for tuning.
- **Fresh-PR set:** 30 recently merged PRs, 10 from each of three consumers,
  outside every recall set.

Costs are OpenAI list prices for the review's model calls.

## Current configuration

Update this table in the same change as the code. Each value names the
decision entry behind it.

| Setting | Value | Decision |
| --- | --- | --- |
| `parent-model` | `auto` (`gpt-6-astra` on sensitive paths, else `gpt-6.1-sol`) | [parent-model-risk-gated](#parent-model-risk-gated) |
| `parent-reasoning-effort` | `high` | [parent-model](#parent-model), [parent-model-risk-gated](#parent-model-risk-gated) |
| Child threads open at once | `2` | [child-thread-cap](#child-thread-cap) |
| `child-model` | `gpt-6-luna` | [gpt-6-children](#gpt-6-children) |
| `child-reasoning-effort` | `max` | [gpt-6-children](#gpt-6-children) |
| `contract-investigator-model` | `gpt-6-sol` | [finder-models](#finder-models) |
| `contract-investigator-reasoning-effort` | `high` | [finder-models](#finder-models) |
| `worker-model` | `gpt-6.1-sol` | [focused-workers-risk-gated](#focused-workers-risk-gated) |
| `worker-reasoning-effort` | `medium` | [focused-workers-risk-gated](#focused-workers-risk-gated) |
| `focused-workers` | `auto` (2 on sensitive paths, else 0); none on incremental reviews | [focused-workers-risk-gated](#focused-workers-risk-gated), [review-scope](#review-scope) |
| `focused-worker-limit` | `8m` | [focused-workers](#focused-workers) |
| `rules-worker` | `true`; skipped on incremental reviews and on PRs without a production change | [rules-worker](#rules-worker), [review-scope](#review-scope), [review-cost-trims](#review-cost-trims) |
| Rules worker input | production-file hunks and the rule pack | [review-cost-trims](#review-cost-trims) |
| Codex skill list (parent, children, workers) | off (`skills.include_instructions=false`) | [review-cost-trims](#review-cost-trims) |
| `rules-worker-limit` | `12m` | [rules-worker](#rules-worker) |
| `worker-stage-deadline-minutes` | `13` | [rules-worker](#rules-worker) |
| `codex-cli-version` | `0.157.1` | [codex-cli-version](#codex-cli-version) |
| `review-budget-minutes` | `20` | [review-budget](#review-budget) |
| Local scope after a passed review | carry an unchanged patch; otherwise incremental from a passed ancestor | [review-scope](#review-scope) |
| `OPEN_REVIEW_INCREMENTAL_REASONING` (local) | `high` | [review-scope](#review-scope) |
| `OPEN_REVIEW_INCREMENTAL_TIMEOUT` (local) | `10m` | [review-scope](#review-scope) |
| `--docs-only-paths` (local) | none | [review-scope](#review-scope) |

## Decisions

Newest first. Each entry gives the question, the evidence, the decision, and
what would reopen it.

### risk-triage

**2026-11-04.** Owner idea: set each PR's review level with a deterministic
check and a quick model triage instead of the path rule alone, and pass
trivial PRs without a model review. Calibrated here; not yet wired into
routing. It is integrated after [review-scope](#review-scope) lands.

- Levels, decided in this order from base-owned code:
  - **high**, without a model call: the PR changes a path of the
    [focused-workers-risk-gated](#focused-workers-risk-gated) rule. The GPT-6
    Astra parent and 2 workers review it. PR text is attacker-controlled, so
    no model answer can lower this floor.
  - **trivial**, without a model call: no such path, and either every path is
    a docs-only path (agent instructions and review rules excluded) or the PR
    changes at most 20 lines in at most 3 files. Only mechanical checks run.
  - otherwise the triage model decides. GPT-6.1 Sol at `medium` effort reads
    the title and description (capped, marked untrusted), the changed files
    with sizes and test, doc or generated tags, and changed-line excerpts
    capped at 9,000 characters (`engine/risk-triage.cjs`,
    `engine/risk-triage-prompt.txt`). It answers strict JSON
    `{risk: high|normal|docs, reasons, confidence}`. A high answer gets the
    full review. A normal or docs answer gets one single-pass review by a
    cheaper model, without children or workers, in about 5 minutes. A request
    error, a timeout or an invalid answer counts as high. The model can only
    raise a level: "docs" on a PR that changes code is normal.
- Calibration set: a manifest in one consumer repository
  (`.open-review/calibration/risk-triage.json`) of 187 of its 924 PRs merged
  in 9 days. It holds 49 PRs whose review blocked on a P0 or P1 finding that
  the next passing push fixed (required high), 14 blocked and cleared without
  a change to the named file, 28 low-risk, 17 docs, 10 agent-instruction, and
  a seeded random sample of 80 reviewed PRs for the high share. The path rule
  alone marks 37 of the 49 required PRs high, 37 of the 80 sampled PRs (46%),
  and 42% of all 924 merged PRs.
- Rule for prompt `risk-triage-v1`, declared before the run:
  1. the final level is high on all 49 required PRs;
  2. the final high share on the sample is at most 55% (owner target
     40–50%);
  3. no agent-instruction PR ends as docs;
  4. at most 2% of calls fail;
  5. the 90th-percentile latency is at most 30 s.
  Pool capacity allows two runs: v1 and, if v1 fails, one revised prompt. A
  revised prompt is tuned on this set, so its result is optimistic.
- Trivial threshold, measured without a model on the 924 merged PRs and on
  the 63 blocked PRs at the head the block was raised on: no blocked PR is
  trivial at any threshold up to 100 lines in 5 files. The smallest blocked
  PR outside the path rule changed 135 lines in 7 files; three smaller
  blocked PRs (4 to 44 lines) are high through the path rule. At 20 lines and
  3 files, 8% of merged PRs are trivial. Their reviews raised no P0 or P1
  finding, 2 parent P2 findings (both on documentation text), 7 focused-worker
  P2 findings and 91 repository-rule P2 findings. At 100 lines and 5 files, a
  PR with a P1 finding (a CI script outside the workflow directory) would be
  trivial. Keep the threshold at or below 50 lines in 3 files (11%).
- Normal-level reviewer, not yet run because of pool capacity: GPT-6.1 Terra
  at `low` and at `medium` against GPT-6.1 Sol at `medium`, each a single
  pass without children or workers, on the development set's PRs outside the
  path rule. Rule, declared now: adopt the cheapest arm that finds at least as
  many known defects as GPT-6.1 Sol `medium` with no more invalid blocking
  findings; screen with 1 sample, and use 3 when the screen is within 1
  defect.
- Result: pending.
### review-cost-trims

**2026-11-04.** Owner decision on cost, without a recall evaluation. Can a
review drop context and coordination calls that find nothing? An audit of 635
retained local reviews on one consumer over 7 days found the parent paying
for its context more than for its thinking: 21 requests per review on
average, each re-sending a context that grows from about 35k to 126k tokens.

- Evidence from the audit:
  - Codex injected the repository's skill list into every session, about 18%
    of the parent's first request; the parent opened a human review skill in
    634 of 635 reviews, and children and workers re-read skill files.
  - Coordination-only parent requests (spawn, follow-up messages, waits,
    `list_agents`, `request_user_input_async` and `sleep`) were 24% of parent
    cost. Exec mode has no user, so every `request_user_input_async` was waste.
  - 69 children spawned with the default `fork_turns` (`all`) ran on the
    parent's GPT-6 Astra whatever model the spawn named: 42% of child cost.
  - The rules worker read the whole diff and the guidance chain, about 2.2M
    input tokens per review and 13% of the pool.
- Decision:
  - Parent, child and worker sessions run with
    `skills.include_instructions=false`. Children share the parent session's
    configuration. The prompt says repository skill files are not review
    guidance.
  - The Delegation rules ask for `fork_turns: "none"` on every spawn.
  - Not adopted after the proof run: coordination rules (one spawn per child
    with its full brief, no follow-ups, no `list_agents`, `sleep` or
    user-input calls, one blocking wait) and `features.sleep_tool=false`. In
    the proof run they doubled coordination-only parent requests (4 to 8) and
    wall time (4m44s to 10m48s); see Proof below.
  - The local runner warns, without changing the gate, when a child ran on the
    parent model although its spawn did not ask for it.
  - The rules worker reads the production-file hunks of the diff (the files a
    focused worker may take) and the rule pack, not the whole diff and the
    guidance chain. A PR without a production change runs no rules worker.
- Accepted loss: not measured on a recall set. In the audit window 40% of the
  rules worker's 1,051 candidates (22% of its P2 candidates) were on test or
  documentation files; it no longer checks those files, and rules it read
  only from guidance outside the rule pack. The parent no longer sees the
  skill list, which also stops the skill-driven extra children.
- Not changed: models, reasoning efforts, worker counts and time limits.
- Proof: one non-publishing review of one sensitive PR at the audit's typical
  size (32 KB diff, 9 files), with the same head, base, rule pack, parent
  model and effort (GPT-6 Astra, `xhigh`), children and workers (4 focused
  workers and the rules worker on GPT-6 Sol `high`) as a retained run from 4
  days earlier. Credits at list price:

  | | before | after |
  | --- | --- | --- |
  | Total | 130.6 | 97.9 (-25%) |
  | Parent | 82.9 | 67.1 |
  | Children (dependency map, contract investigator) | 6.8 | 7.7 |
  | Rules worker | 18.6 (2.2M input tokens) | 3.0 (0.1M) |
  | Focused workers | 22.3 | 20.2 |
  | Parent requests | 22 | 19 |
  | Coordination-only parent requests | 4 (13.9 credits) | 8 (22.9 credits) |
  | Parent first request | 34.6k tokens | 28.3k tokens |
  | Wall time | 4m44s | 10m48s |

  - The proof run included the dropped coordination rules and sleep-tool
    flag; the shipped change has neither. Codex 0.157.1 accepted both keys
    under `--strict-config` and rejects unknown ones. No thread of the after-run received the skill list
    (children's first requests fell from about 22k to 16k tokens). A probe
    against a local stub provider showed both keys remove the skill block and
    the `sleep` and `clock` tools from the first request.
  - Neither run forked a child or ran one on the parent model. On a retained
    run with a forked child, the new check names it.
  - Coordination: the after-run sent no follow-up message and called no
    `list_agents`, but it waited 4 times with `wait_agent` and twice through
    `wait` on a nonexistent command. `wait_agent` returns on every mailbox
    update without content, and the contract investigator starts only after
    the dependency map returns, so the review waits in two phases. Wall time
    doubled because the dependency map child ran 14 requests against 7.
  - Both reviews passed with no parent findings. The rules worker reported 3
    advisory findings before and none after: two were on test or
    documentation files, and the third cited a rule outside the rule pack.
  - Confounders: one sample per arm; the PR's discussion context had grown
    since the earlier run; upstream load was not controlled.
- Reopen when a recall evaluation shows these rules losing known defects, or
  when a pinned Codex version changes skill injection or `fork_turns`
  defaults. Retry coordination rules only with a measurement that shows fewer
  requests and no slower reviews.

### parent-model-risk-gated

**2026-11-04.** Owner decision on cost, without an evaluation run. In one
consumer pool, the GPT-6 Astra parent was 46% of model usage, its child
threads 13% and the focused workers 20%.

- Decision: `parent-model` defaults to `auto`. GPT-6 Astra reviews a PR that
  changes a stored-data, security or infrastructure path outside tests and
  docs (the path rule of
  [focused-workers-risk-gated](#focused-workers-risk-gated)); GPT-6.1 Sol
  reviews every other PR. The rule reads every path of the PR, rename sources
  included, so all rounds of a PR use one model. A consumer with its own risk
  tiers passes the model for each tier.
- Effort: `parent-reasoning-effort` stays `high` for both models. That is the
  setting under which GPT-6.1 Sol was measured as a parent
  ([parent-model](#parent-model)); no other effort was measured.
- Accepted loss: on PRs outside the sensitive paths, a weaker parent. On the
  development set GPT-6.1 Sol found 6 of 33 known defects (+3 partial)
  against Astra's 9, with 4 of its 18 findings invalid, at about a quarter of
  Astra's cost. Blocking findings on those PRs now come from it.
- The path rule matched 40% of one consumer's last 1,195 merged PRs.
- `eval/run-recall.sh` inherits `CODEX_MODEL`. An evaluation that measures
  the parent sets it to one model, as worker evaluations pass an explicit
  count.
- The confound in [worker-model](#worker-model) holds: Codex 0.157.1 runs
  `gpt-6.1-sol` with fallback model metadata.
- Reopen when an evaluation shows GPT-6.1 Sol missing blocking defects that
  Astra finds outside the sensitive paths, or when the pool has capacity for
  Astra on every PR.

### child-thread-cap

**2026-11-04.** Owner decision on cost. The parent may keep at most 2 child
threads open, down from 3. Codex 0.157.1 has no limit on total child threads,
but parents keep their children open, so this limit acts as one: in 739
recent runs on one consumer no review opened more than 3.

- Children per review in those runs: none in 5%, one in 19%, two in 69%,
  three in 7%; none nested. The first child is usually the dependency map and
  the second the contract investigator ([recall-mode](#recall-mode)); a third
  was an ad hoc probe of failure paths, state precedence or contracts.
- Saving: about 3% of child-thread tokens, under 0.5% of that pool.
- Accepted loss: not measured; it affects the 7% of reviews that opened a
  third child. A limit of 1 would save about 39% of child-thread tokens but
  drop the contract investigator from about 70% of reviews. Not adopted.
- Reopen when an evaluation shows a third child finding known defects that
  the first two miss.

### review-scope

**2026-11-04.** Owner decision on cost, from an offline replay without a
model run. On one consumer, 48% of review tokens over 9 days went to full
re-reviews of PRs whose previous head had passed. The median push after a pass
changed 19 lines, about 5% of the PR.

- Decision: a publishing local run first classifies the head without a model
  (`engine/review-scope.cjs`), from git and the PR's settlement comments by
  repository writers:
  - every changed path matches the consumer's `--docs-only-paths` (none by
    default): PASS without a model;
  - the latest settlement passed on the same base branch, and every file of
    the PR has the same base and result blobs as at the passed head (a rerun,
    or a rebase or merge that left the PR's files alone), or now differs only
    in docs-only paths: the pass is carried;
  - the latest settlement passed on the same base branch at an ancestor of
    this head: an incremental review of the files whose blobs changed, by the
    parent alone at `high` reasoning within 10 minutes. The diff starts at
    the passed head, or at the current merge base when the base moved in
    between, so a base-branch change the PR dropped stays visible;
  - anything else, including a latest BLOCK, a retargeted PR, a passed head
    that was force-rewritten, a settlement without a recorded base, a changed
    path with a newline in its name, or `--full-review`: a full review.
- File identity is exact (modes and blob ids at the merge base and the
  head). Hunk text is not: an edit moved between two identical regions would
  match. A rebase over base-branch changes to the PR's own files therefore
  loses its carried pass.
- Every settlement uses the exact-head marker and records its base branch and
  merge base (`Review base:`); a carried or incremental one names the passed
  head and settlement it builds on. Publication refuses a settlement when
  the PR's head, base branch or merge base changed during the run.
- Incremental reviews, hosted and local, run no focused or rules workers.
  After a merge from the base branch, a hosted review stays full.
- Replay of the 9 days through these rules, with the focused-worker cut:
  45–53% of the earlier review tokens. It lost 0 of 21 acted-on blocking
  findings and about 10% of acted-on advisory findings after adjusting for
  chance, 14% counting repository-convention findings. Most lost findings
  were older problems that a later full re-review spotted on unchanged code.
- Evaluation rule, declared before the run: replay 30 PRs with 2 or more
  reviewed heads. The incremental review must find every blocking finding
  inside the new change and lose no more than 10% of acted-on P2 findings.
  Not yet run.
- Reopen when that evaluation fails, or when blocking findings per 100 PRs
  (13 in the baseline) or fix-up PRs after merge rise.

### focused-workers-risk-gated

**2026-11-04.** Owner decision on cost, without an evaluation run. The
focused workers were about 37% of one consumer pool's weekly model tokens
(1.7B uncached input and output tokens, about 11,000 worker sessions), more
than any other single model use.

- Decision: `focused-workers` defaults to `auto`. It runs 2 workers when the
  PR changes a stored-data, security or infrastructure path (migrations, SQL
  and schema files, database directories, auth, IAM, secrets and permission
  code, `infra/`, Terraform and Pulumi, container files, CI workflows), tests
  and docs excluded, and none otherwise. A consumer with its own risk tiers
  passes an explicit count instead.
- The focused and rules workers move from `gpt-6-sol` at `high` to
  `gpt-6.1-sol` at `medium`, configurable with `worker-model` and
  `worker-reasoning-effort`.
- Accepted loss: PRs outside the sensitive paths lose the workers' extra
  recall (3 known defects of 33 on the development set; see
  [focused-workers](#focused-workers)). On sensitive PRs, 2 workers cover the
  2 highest-churn files instead of 4. [worker-model](#worker-model) measured
  GPT-6.1 Sol at high: equal known defects, fewer other real findings, a
  slower stage. Medium effort was not measured.
- Path rule, checked on 300 recent default-branch commits per consumer:
  13% to 26% matched.
- The confound in [worker-model](#worker-model) still holds: Codex 0.157.1
  runs `gpt-6.1-sol` with fallback model metadata.
- Evaluations that measure the workers pass an explicit count.
- Reopen when the pool has capacity for the workers on every PR, or when an
  evaluation shows the path rule misses most worker-found defects.

### worker-model

**2026-10-02.** Do GPT-6.1 Sol workers, at half the cached-input price, match
GPT-6 Sol?

- Rule, declared before the run: switch only with at least as many known
  defects, equal or lower cost, and no slower worker stage.
- A first run at peak upstream load was invalid: most workers in both arms hit
  their time limit.
- A light rerun used only the 5 workers that had caught a known defect, with
  both arms at the same time. Known defects: 1 of 3 in each arm. Other
  plausible-real findings: 7 against 3. Invalid findings: 0 in each. Timeouts:
  1 of 5 in each. Mean worker time: 231 s against 301 s. Stage median: 200 s
  against 373 s. Cost: 55% lower.
- Decision: keep `gpt-6-sol`. GPT-6.1 Sol fails the stage-time rule and
  returns fewer real findings.
- Confound: Codex 0.157.1 has no model metadata for `gpt-6.1-sol` and runs it
  with fallback defaults. A switch would run the same way.
- Reopen when a pinned Codex version ships `gpt-6.1-sol` metadata.

### review-budget

**2026-10-01.** The default stays at 20 minutes. When upstream
time-to-first-token doubled (median 6.9 s to 13.4 s, same daytime hour on
consecutive days), one consumer's reviews started to time out at 20 minutes. Consumers set
`review-budget-minutes` for their own load; current consumers use 30 and 40.

- Reopen when most consumers override the default.

### workers-beside-parent

**2026-09-30.** The focused and rules workers ran after the parent and added
3 to 12 minutes to each review. They now start before the parent and are joined
before publication, in the hosted action and in the local runner. On one
consumer the median review time fell from 13.9 to 10.3 minutes, and the 75th
percentile from 19.0 to 10.6 minutes. The parent is now the slow part.

### no-sonnet-stage

**2026-09-30.** Should Claude Sonnet 5.5 at max effort review beside the
engine?

- Development set: Sonnet alone found 12 of 33 known defects. The parent
  found 9, and the parent with focused workers found 12. The union of parent
  and Sonnet was 17. Cost per PR was close to the parent's; time was about
  twice as long.
- Held-out set, with the routing rule frozen before the runs (large PRs and
  PRs that touch schema or authorization files; 6 of 12 PRs): the engine found
  7 of 10. The engine with routed Sonnet found 8, at 49% more cost. Sonnet
  alone found 3. The development gain did not transfer.
- Decision: no Sonnet stage.
- Reopen when a larger held-out set shows at least 2 extra defects per 10 at
  no more than about 20% extra cost, or when the price drops.

### parent-model

The parent stays GPT-6 Astra at high reasoning effort.

- **2026-09-29.** GPT-6.1 Sol as the parent on the development set: 6 of 33
  known defects (+3 partial) against Astra's 9. 4 of its 18 findings were
  invalid. Cost was about a quarter of Astra's. One PR hit the review budget.
  Not a replacement.
- **2026-09-30.** Sonnet with the workers and no Astra parent found 6 of 10
  held-out defects, against 7 for the engine (see
  [no-sonnet-stage](#no-sonnet-stage)).
- Reopen when a new model beats Astra on the held-out set within the same
  budget.

### no-verifier-filter

**2026-09-29.** Can one Astra verifier pass remove false findings from the
pooled findings of several reviewers?

- Pool: 87 findings on 12 development PRs, containing 20 known defects.
- Rule, declared before the run: accept at least 19 of the 20 known defects
  and no invalid blocker. Result: it accepted 16 of the 20 and marked 4
  uncertain; it accepted 2 of 8 invalid findings, at P1 and P2. The rule
  failed.
- Decision: no verifier filter. Uncertain findings stay advisory.

### rules-worker

**2026-09-29.** The parent skips repository-rule findings (test, tooling and
written-convention issues) because its findings bar needs user impact. A
hosted review bot was catching them.

- Pilot on 13 PRs at the bot's reviewed commits: 42 of 61 findings valid
  (69%; the bot 73%). It found 11 of the bot's 19 valid findings and 2 bugs
  the bot missed.
- Held-out check on 10 PRs: 19 of 23 findings valid (83%; the bot 86%). It
  found 8 of the bot's 27 reachable valid findings, plus 4 partial. 13 of
  those 27 were behaviour bugs, which are the parent's and the focused
  workers' job.
- Decision: an advisory rules worker, on by default, beside the focused
  workers. It has a 12-minute limit, the worker stage has a 13-minute
  deadline, and its findings go to their own capped summary section,
  deduplicated against the ledger and the focused workers.

### focused-workers

**2026-09-28.** Does a small read-only worker per changed file find defects
that the parent reads but misses?

- Why: an audit of 39 parent misses in saved transcripts. 28 code paths were
  read without the mechanism being recognised. The budget never ran out
  (0 of 39).
- Pilot on the development set, 3 trials: up to 4 changed non-test files per
  PR, chosen by churn; one GPT-6 Sol high worker per file; the output must be a
  failing trace or "no counterexample within budget". Result: 3.0 extra known
  defects per trial beyond the parent (12 against 9 of 33), exactly at the
  bar declared before the run.
- Fresh-PR set, 116 workers: 51 distinct candidate bugs, 43 plausible real,
  2 invalid (3.4%). The review that ran on those PRs had flagged 1 of the 51.
- Precision check: an Astra pass told to disprove 12 sampled bugs; 11 held.
- Decision: an advisory stage of up to 4 workers with an 8-minute limit each.
  Findings go to the summary only and do not change the merge gate. Cost:
  20% to 25% more per review.

### no-prompt-nudge

**2026-09-27.** A prompt change aimed at read-but-missed defects found 7 known
defects (+2 partial) against the baseline's 9 (+3 partial), at 10% more cost,
in one sample. Not adopted. The drop is within noise: detecting a 2-defect
gain on 33 defects needs about 250 paired defect runs. Do not tune prompts on
single samples.

### no-decision-model

**2026-09-27.** An external typed yes/no decision model (no tools, no
repository access) was tested offline as a grader, a verifier and a ranker of
where to look.

- Grader: it agreed with a blind Opus grader on 91.5% of pairs, but it was
  lenient, and 8 of 59 labels changed when the question was paraphrased.
- Verifier: it scored known-real and unlabelled findings the same (median
  0.90 against 0.88).
- Ranker, with a go rule declared before the run: at 4 locations per PR it
  captured 4 of 24 parent-missed defects. A GPT-6 Luna ranker also captured 4,
  and random ranking reached 7 at its 95th percentile. No go.
- Decision: not adopted. Reopen on independent code-review recall evidence.

### recall-mode

**2026-09-27.** The engine reviews changed contracts and their consumers, not
only changed lines:

- a deterministic change-impact inventory of changed statuses,
  discriminators, writes, shared schemas and their counterparts;
- a contract-investigator child that checks each obligation;
- the findings cap raised from 5 to 25;
- a disposition ledger carried between rounds.

Released on one graded sample: confirmed defects per sample rose from 6.7 to
9 on one consumer and stayed flat or rose on the others. Cost per review
changed by -7% to +8%.

### gpt-6-children

**2026-09-26.** Child investigations default to GPT-6 Luna at max reasoning
effort. Codex CLI versions before 0.156.1 cannot start GPT-6 children and fall
back to older models without an error. With an evidence rule and GPT-6
children together, a replay of 9 shipped bugs went from 0 to 4 caught. The two
changes were not measured separately.

### finder-models

**2026-09-26.** Which model should run finder and investigator children under
the parent? A replay on 33 known-defect keys, blind graded, 1 sample:

- previous engine: 8 of 33, 9 valid findings, 3 noise;
- GPT-6 Sol finders: 12 of 33, 24 valid, 14 noise;
- GPT-6 Astra finders: 13 of 33, 26 valid, 11 noise, at 27% more cost;
- GPT-6 Luna finders: 15 of 33, 25 valid, 16 noise, at 27% more cost,
  because the parent re-reads about twice as much.

With 3 samples: Sol 38 of 99, Astra 42 of 99 at 33% more cost. Decision:
GPT-6 Sol at high effort for finders and contract investigators, under a
GPT-6 Astra parent at high effort.

### codex-cli-version

**2026-09-26.** Codex CLI 0.157.1. Codex 0.156 removed the standalone Landlock
sandbox, so the read-only sandbox uses bubblewrap on 0.157.1. Versions before
0.156.1 cannot start GPT-6 children. The local runner installs the pinned
version for its run, because a machine's own Codex install changes version
(one evaluation run failed on a newer local Codex).

- Reopen when a required model needs a newer CLI, for example for its model
  metadata.
