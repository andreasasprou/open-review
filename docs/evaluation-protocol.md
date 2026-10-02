# Evaluation protocol

How to test a change to a model, a reasoning effort, a worker count, a time
limit, the Codex CLI version, the review budget default, a review stage, or a
prompt change meant to find more or fewer defects.
Record the question, the rule, the result and the decision in
[decisions.md](decisions.md).

## Before the run

1. Read [decisions.md](decisions.md). Do not retest a rejected option unless
   its reopen condition has happened.
2. Write the decision entry first: the question, the arms, the sets, the
   decision rule and the cost ceiling. Do not change the rule after you see
   results.
3. Estimate cost from a measured earlier run of the same stage, not from
   token guesses. Any increase in cost per review needs the owner's approval.

## Sets

- Recall sets are JSON manifests of known pre-fix PR heads. They live in each
  consumer repository (`.open-review/recall/*.json`), never in this
  repository.
- Use a development set to screen. Gains on it are optimistic: one tested
  change gained 7 of 33 known defects there and 1 of 10 on a held-out set.
- Use a held-out set, never used for tuning, before a release decision.
- Use fresh merged PRs outside every recall set to measure precision. A later
  fix commit on the default branch confirms a finding.
- Include control PRs without a known defect, to measure invalid findings.

## Running

- Freeze the inputs: the same heads, packets, rule pack, prompts and Codex
  version in every arm.
- Run all arms at the same time, so they see the same upstream load.
- Check upstream load first: the median time-to-first-token and the count of
  server errors in the last hour. A run under heavy load measures timeouts,
  not the change.
- A run where most workers hit their time limit is invalid. Report it as
  invalid and rerun it later.
- Pin the Codex CLI. Search the worker logs for
  ``Model metadata for `<model>` not found``: a model without metadata runs
  with fallback defaults, which is a confound.
- Start light. Rerun only the units that matter (for example, the workers that
  caught known defects) before you run full sets. Scale up only when the
  light result is close to the rule.

## Samples

- Screen with 1 sample per arm. Use 3 paired samples when a screen is close
  to the rule, and before a release.
- Single runs vary. The same worker configuration caught 3 of 3 known
  defects in one run and 1 of 3 in a later run.
- Small gains need many runs. Detecting a 2-defect gain on 33 known defects
  needs about 250 paired defect runs, so one sample cannot settle a small
  prompt change.
- Treat a result whose interval spans both a loss and a gain as inconclusive.

## Cost and time

- Price each arm from the provider's request log, keyed by each Codex
  thread id (the `thread_id` of the `thread.started` event in the `--json`
  output). The `turn.completed` usage misses every run that timed out; in one
  evaluation this undercounted the cost about four times.
- Report list price per review: uncached input, cached input and output
  tokens at the model's rates.
- Report time per worker (first to last request) and per stage (median and
  maximum).

## Grading

- Grade blind. Pool the findings of all arms per PR, shuffle them, and give
  each one an anonymous id. Keep the id-to-arm map outside the folder the
  grader reads.
- Use a grader from a different model family than the arms.
- For each known defect, mark each finding `yes` (same failure mechanism) or
  `partial` (same code path, wrong mechanism or consequence).
- Mark every other finding `plausible_real`, `invalid` or `unclear`, with the
  file and line that decides it.

## Recording

- Write the aggregate result and the decision into the entry, with what would
  reopen it. Update the "Current configuration" table when a value changes.
- Do not commit per-PR evidence, PR numbers, file paths, finding text, code or
  model output from a consumer repository. Keep them with the consumer.
- `eval/run-recall.sh` and `eval/score-recall.cjs` run and score parent
  reviews against a recall manifest.
