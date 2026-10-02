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
| `parent-model` | `gpt-6-astra` | [parent-model](#parent-model) |
| `parent-reasoning-effort` | `high` | [parent-model](#parent-model) |
| `child-model` | `gpt-6-luna` | [gpt-6-children](#gpt-6-children) |
| `child-reasoning-effort` | `max` | [gpt-6-children](#gpt-6-children) |
| `contract-investigator-model` | `gpt-6-sol` | [finder-models](#finder-models) |
| `contract-investigator-reasoning-effort` | `high` | [finder-models](#finder-models) |
| `worker-model` | `gpt-6-sol` | [worker-model](#worker-model) |
| `worker-reasoning-effort` | `high` | [focused-workers](#focused-workers) |
| `focused-workers` | `4` | [focused-workers](#focused-workers) |
| `focused-worker-limit` | `8m` | [focused-workers](#focused-workers) |
| `rules-worker` | `true` | [rules-worker](#rules-worker) |
| `rules-worker-limit` | `12m` | [rules-worker](#rules-worker) |
| `worker-stage-deadline-minutes` | `13` | [rules-worker](#rules-worker) |
| `codex-cli-version` | `0.157.1` | [codex-cli-version](#codex-cli-version) |
| `review-budget-minutes` | `20` | [review-budget](#review-budget) |

## Decisions

Newest first. Each entry gives the question, the evidence, the decision, and
what would reopen it.

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
