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
| `parent-model` | `auto`: review level (floor-high `gpt-6.2-astra`, locally for at most 2 settled rounds and then `gpt-6.2-sol` at `high`; model-high `gpt-6.2-sol` at `high`; normal `gpt-6.2-sol` at `medium`, no child threads) | [risk-triage](#risk-triage), [astra-round-cap](#astra-round-cap), [gpt-6-2-models](#gpt-6-2-models) |
| Review-level triage | `gpt-6.1-sol` at `medium`, prompt `risk-triage-v2`; any failure is model-high | [risk-triage](#risk-triage) |
| `parent-reasoning-effort` | `high` | [parent-model](#parent-model), [parent-model-risk-gated](#parent-model-risk-gated) |
| Child threads open at once | `2` | [child-thread-cap](#child-thread-cap) |
| `child-model` | `gpt-6-luna` | [gpt-6-children](#gpt-6-children) |
| `child-reasoning-effort` | `max` | [gpt-6-children](#gpt-6-children) |
| `contract-investigator-model` | `gpt-6-sol` | [finder-models](#finder-models) |
| `contract-investigator-reasoning-effort` | `high` | [finder-models](#finder-models) |
| `worker-model` | `gpt-6.1-sol` | [focused-workers-risk-gated](#focused-workers-risk-gated) |
| `worker-reasoning-effort` | `medium` | [focused-workers-risk-gated](#focused-workers-risk-gated) |
| `focused-workers` | `auto` (2 at floor-high, else 0); none on incremental reviews | [focused-workers-risk-gated](#focused-workers-risk-gated), [review-scope](#review-scope), [risk-triage](#risk-triage) |
| `focused-worker-limit` | `8m` | [focused-workers](#focused-workers) |
| `rules-worker` | `true`; skipped on incremental reviews, at the normal level and on PRs without a production change | [rules-worker](#rules-worker), [review-scope](#review-scope), [review-cost-trims](#review-cost-trims), [risk-triage](#risk-triage) |
| Rules worker input | production-file hunks and the rule pack | [review-cost-trims](#review-cost-trims) |
| Codex skill list (parent, children, workers) | off (`skills.include_instructions=false`) | [review-cost-trims](#review-cost-trims) |
| `rules-worker-limit` | `12m` | [rules-worker](#rules-worker) |
| `worker-stage-deadline-minutes` | `13` | [rules-worker](#rules-worker) |
| `codex-cli-version` | `0.169.1` | [codex-cli-version](#codex-cli-version), [gpt-6-2-models](#gpt-6-2-models) |
| `review-budget-minutes` | `30` | [review-budget](#review-budget), [gpt-6-2-models](#gpt-6-2-models) |
| Local scope after a passed review | carry an unchanged patch; otherwise incremental from a passed ancestor | [review-scope](#review-scope) |
| `OPEN_REVIEW_INCREMENTAL_REASONING` (local) | `high` | [review-scope](#review-scope) |
| `OPEN_REVIEW_INCREMENTAL_TIMEOUT` (local) | `15m` | [review-scope](#review-scope), [gpt-6-2-models](#gpt-6-2-models) |
| `--docs-only-paths` (local) | none | [review-scope](#review-scope) |

## Decisions

Newest first. Each entry gives the question, the evidence, the decision, and
what would reopen it.

### gpt-6-2-models

**2026-11-18.** Owner request. GPT-6.2 Astra and GPT-6.2 Sol shipped on
2026-11-17. GPT-6.2 Astra lists at 20% below GPT-6 Astra; GPT-6.2 Sol keeps
GPT-6.1 Sol's price. Do they replace the current parent at each review level?

- Codex 0.157.1 has no metadata for either model. Codex 0.169.1 is the first
  release with it, so every arm runs on 0.169.1 (reopens
  [codex-cli-version](#codex-cli-version)). The CLI change alone is read from
  the `astra6` and `sol61` arms against their 0.157.1 results in
  [parent-model](#parent-model); it has no arm of its own.
- Arms, parent only: an explicit `parent-model` at `high`, `focused-workers`
  0, no rules worker, children unchanged (GPT-6 Luna `max`; the contract
  investigator GPT-6 Sol `high`):
  - `astra6`: `gpt-6-astra`, today's floor-high parent;
  - `astra62`: `gpt-6.2-astra`;
  - `sol61`: `gpt-6.1-sol`, today's model-high and normal parent;
  - `sol62`: `gpt-6.2-sol`.
- Sets: screen on the development set (14 PRs, 33 known defects). Decide on
  two other consumers' held-out manifests: 18 PRs, 38 known defects. Part of
  one held-out manifest was adjudicated from an earlier GPT-6 Astra
  reviewer's findings, which favours `astra6`.
- Model traffic goes through the consumers' pooling provider, as in
  production. Every arm of a set runs at the same time.
- Grading: `eval/score-recall.cjs` for known defects; a blind Claude grader
  for every other finding (`plausible_real`, `invalid` or `unclear`).
- Rule, declared before the run, applied to the held-out set. An arm within 2
  known defects of its baseline gets 3 paired samples.
  1. Floor-high parent: adopt the cheaper of `sol62` and `astra62` that finds
     at least as many known defects as `astra6`, with no more invalid P0 or P1
     findings, no higher list-price cost per review, and a median review time
     at most 20% longer.
  2. Model-high and normal parent: adopt `sol62` if it meets the same bar
     against `sol61`.
  3. Otherwise keep the current model for that level.
- Cost ceiling: about 2,500 credits for the screen and 3,200 per held-out
  sample, estimated from the measured parent in
  [review-cost-trims](#review-cost-trims) and the quarter ratio in
  [parent-model-risk-gated](#parent-model-risk-gated). Stop at 15,000
  credits.
- Out of scope: focused and rules workers, the triage model (a change needs a
  recalibration; see [risk-triage](#risk-triage)) and the contract
  investigator. Each is evaluated only after its level's parent switches.
- Screen, 2026-11-18, development set, 1 sample, Codex 0.169.1. Known defects
  by the blind grader (`yes` only); "real" is known defects plus
  `plausible_real`; cost is list price per review from the provider log:

  | Arm | Known (of 33) | Real / findings | Invalid | Invalid P0/P1 | Cost | Median time |
  |---|---|---|---|---|---|---|
  | `astra6` | 15 | 26 / 33 (79%) | 2 | 2 of 10 | $10.79 | 9.8 min |
  | `astra62` | 22 | 107 / 133 (80%) | 11 | 5 of 61 | $6.98 | 15.6 min |
  | `sol61` | 12 | 20 / 29 (69%) | 1 | 1 of 8 | $1.39 | 9.9 min |
  | `sol62` | 17 | 72 / 91 (79%) | 7 | 5 of 35 | $2.13 | 16.0 min |

  - Both 6.2 models find more known defects and about four times as many real
    findings at equal or higher precision. `astra62` costs 35% less than `astra6`;
    `sol62` costs 53% more than `sol61`, mostly from child threads (it
    delegates about twice as many requests).
  - Times are not comparable. The models launched the day before: each 6.2
    request took about twice as long as the 6.0 and 6.1 requests in the same
    hour (median 16.6 s against 8.0 s for Astra).
  - Capacity: of 47 attempts on the 6.2 models, 17 failed with `Selected
    model is at capacity` (upstream `server_is_overloaded`, spread across
    accounts and plans) and 2 timed out at 30 minutes; no 6.0 or 6.1 attempt
    failed. Failed pairs were rerun on their own, up to four attempts, so
    those reviews ran under lighter local load than their baselines. Codex
    does not retry that error; the action retries once within
    `review-budget-minutes`.
  - The CLI change shows no loss: on 0.169.1 `astra6` finds 15 and `sol61` 12,
    against 9 and 6 on 0.157.1 in [parent-model](#parent-model). The grader
    and prompt have changed since, so this rules out a loss and measures
    nothing more. On 0.169.1,
    Codex warns that the repository's AGENTS.md is truncated at 32 KiB, and
    the progress log prints `unknown` for commands; both are the same in every
    arm.
  - Cost: about 8,600 credits, above the 2,500 estimated. The parent-only
    `astra6` review costs about 270 credits, not the estimate's quarter ratio.
  - As declared, the rule rejects both 6.2 models: an absolute count of
    invalid P0/P1 findings penalises a reviewer that raises four to six times
    as many, and the cost bar rejects `sol62` at the model-high and normal
    levels.
- Owner, 2026-11-18, after the screen: more findings per review are
  acceptable when they are real; judge a reviewer on its true positives and
  precision, not on volume. Any amendment to the rule follows from this and is
  recorded here before the decision run.
- Rule, amended by the owner on 2026-11-18 before the decision run; it
  replaces the declared rule above. An arm within 2 known defects of its
  baseline gets 3 paired samples.
  1. Floor-high parent: adopt the cheaper of `sol62` and `astra62` that finds
     at least as many known defects and at least as many real findings as
     `astra6`, has at most 10% of its findings graded `invalid`, costs no
     more per review at list price, and has a median review time at most 20%
     longer.
  2. Model-high and normal parent: adopt `sol62` if it meets the same quality
     and time bars against `sol61` and costs at most $0.80 more per review at
     list price.
  3. Otherwise keep the current model for that level.
- Budget, amended by the owner on 2026-11-18: stop at 20,000 credits.
- Decision run: every review has a 45-minute limit, the same for all arms. The
  screen's 30 minutes timed out a GPT-6.2 Astra review that GPT-6 Astra
  finished in 26.
- Before the held-out results, the owner was asked whether to replace the
  time bar with a count of reviews over the 20-minute production budget, and
  whether floor-high should prefer more known defects to lower cost. No answer
  had come when grading finished, so the amended rule applies as written.
- Held-out result, 2026-11-18, 1 sample, Codex 0.169.1. All four arms ran at
  once per consumer, with the rule pack pinned to one commit per consumer.
  Known defects are graded by the blind grader (`yes` only): the location
  matcher in `eval/score-recall.cjs` credited two findings that sit nine
  lines from a defect they do not describe. "Real" is known defects plus
  `plausible_real`. Cost is list price per review, including the
  long-context rate above 272K input tokens and the failed review:

  | Arm | Known (of 38) | Real / findings | Invalid | Invalid P0/P1 | Cost | Median time | Over 20 min or failed |
  |---|---|---|---|---|---|---|---|
  | `astra6` | 10 | 24 / 25 | 1 (4%) | 0 of 3 | $7.71 | 5.5 min | 0 of 18 |
  | `astra62` | 16 | 83 / 87 | 3 (3%) | 0 of 13 | $7.27 | 11.5 min | 4 of 18 |
  | `sol61` | 10 | 25 / 27 | 2 (7%) | 0 of 2 | $1.50 | 7.4 min | 4 of 18 |
  | `sol62` | 16 | 72 / 73 | 1 (1%) | 0 of 12 | $2.33 | 14.9 min | 4 of 18 |

  - Both 6.2 models find 6 more known defects than either baseline and about
    three times as many real findings, at an equal or lower invalid rate. The
    held-out set agrees with the screen. No arm is within 2 known defects of
    its baseline, so no repeats ran.
  - No capacity failures in 72 reviews. One `astra62` review reached the
    45-minute limit and counts as a failure with no findings; `astra6`
    finished that PR in 19 minutes.
  - Time: a 6.2 review takes about twice as long. Each request is slower
    (median 12.0 s against 8.0 s for Astra, 11.5 s against 8.8 s for Sol),
    and a review makes about 1.4 times as many requests. Times run from first
    to last request in the provider log, with 8 reviews running at once.
  - Cost: `sol62` adds $0.83 per review over `sol61`. $0.15 of it is the
    long-context rate (50 requests above 272K, against 20); without that rate
    it adds $0.74.
  - Spend: about 8,500 credits, about 17,100 in all.
- Result:
  1. Floor-high: both 6.2 models pass the quality, precision and cost bars
     against `astra6` and fail the time bar (`astra62` +109%, `sol62` +171%,
     against 20%). `astra6` stays.
  2. Model-high and normal: `sol62` passes the quality and precision bars and
     fails the time bar (+101%) and, by $0.03, the cost bar. `sol61` stays.
  3. Configuration unchanged.
- Owner decision, 2026-11-18, after the held-out result: switch; twice the
  review time is worth 6 more known defects of 38.
  - Floor-high: `gpt-6.2-astra`, which found the most known defects over both
    sets (38 of 71, against 33 for `sol62` and 25 for `astra6`).
  - Model-high, normal and the round cap's later floor-high rounds:
    `gpt-6.2-sol`.
  - Codex 0.169.1. The full-review time limit rises from 20 to 30 minutes
    (`review-budget-minutes` and the local default), and the local
    incremental limit from 10 to 15 minutes in the same proportion.
  - Triage, workers, children and the contract investigator keep their
    models.
  - Untested: `sol62` ran only at `high`; the normal level runs it at
    `medium`.
- Reopen when reviews at the new levels time out more often than before the
  switch, or when a cheaper model finds as many known defects.

### astra-round-cap

**2026-11-05.** Owner decision on cost, without an evaluation run. GPT-6 Astra
was about 80% of one consumer pool's review credits. In 20 local GPT-6 Astra
review runs over the last hours of that consumer's retained run logs, 17 were
at the model-high level, and one small stored-data fix took 3 GPT-6 Astra
rounds.

- Decision: GPT-6 Astra reviews only the floor (stored data, security,
  infrastructure, CI, review policy and the engine;
  [risk-triage](#risk-triage)). A model-high PR, a high, failed or missing
  triage answer, gets GPT-6.1 Sol at `high` with its child threads and the
  rules worker, without focused workers (`LEVELS` in
  `engine/risk-triage.cjs`). Hosted and local.
- Round cap, local runs: once a floor-high PR has 2 settlements by writers
  whose recorded parent model is GPT-6 Astra, later rounds (usually
  incremental) use GPT-6.1 Sol at `high`. Carried and skipped settlements are
  not rounds. The hosted action keeps no per-PR round count and is not
  capped.
- Saving, estimated: GPT-6.1 Sol at `high` cost about a quarter of GPT-6
  Astra as a parent ([parent-model-risk-gated](#parent-model-risk-gated)), so
  moving the model-high share saves roughly 40–50% of review credits at the
  measured mix. The cap affects only floor-high PRs with 3 or more rounds.
- Accepted loss: a weaker parent on model-high PRs. On the development set
  GPT-6.1 Sol found 6 of 33 known defects (+3 partial) against GPT-6 Astra's
  9. In the [risk-triage](#risk-triage) calibration, 10 of the 49 PRs whose
  review blocked were outside the floor, so model-high; those now get GPT-6.1
  Sol. A third or later round on a floor-high PR loses GPT-6 Astra.
- An explicit `parent-model` keeps its model and effort, without a cap.
- Considered and rejected for now: carrying another PR's pass to a re-land
  with the same patch. It saves about one review per rare re-land but adds a
  GitHub search dependency, an indexing race and a question of whose
  settlement may be reused.
- Reopen when a model-high PR or a capped round ships a blocking defect that
  GPT-6 Astra would have found, or when the pool has capacity for GPT-6 Astra
  again.

### risk-triage

**2026-11-04.** Owner idea: set each PR's review level with a deterministic
check and a quick model triage instead of the path rule alone, and pass
trivial PRs without a model review. The levels below were calibrated as
first proposed; the owner's decision after the calibration sets the routing
(the "Decision" item).

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
  alone marks 39 of the 49 required PRs high, 37 of the 80 sampled PRs (46%),
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
- As proposed, a trivial PR would still get an exact-head PASS settlement
  that a consumer's merge gate re-derives. The engine dropped this level (see
  the Decision item).
- Result, `risk-triage-v1` (digest `51c2f4f7fd66`): high on 49 of 49
  required PRs (the model alone on 49 of 49, the path rule on 39) and on all
  14 cleared ones; 81% of the sample high; 2 of 28 low-risk PRs high; 7 of 17
  docs PRs docs, 10 high; no agent-instruction PR docs; no failed call.
  Mean 3,090 input and 79 output tokens, 0.174 credits per call; latency
  median 4.2 s, 90th percentile 6.9 s. Fails rule 2.
- Result, `risk-triage-v2` (digest `b5580e8edfc4`; tuned on this set, so
  optimistic): high on 49 of 49 required PRs (the model alone on 49 of 49)
  and on all 14 cleared ones; 78% of the sample high (76% after the trivial
  level); no low-risk PR high; 16 of 17 docs PRs docs; all 10
  agent-instruction PRs normal; no failed call. 0.174 credits per call;
  latency median 3.8 s, 90th percentile 6.6 s, maximum 11.8 s. Fails rule 2.
  The `confidence` field carries no signal: means of 0.96 to 0.99 for every
  tier.
- Why the share stays high: the path rule alone covers 46% of the sample, and
  the model marks 65% of the remaining non-trivial PRs high. 7 of the 10
  required PRs outside the path rule were blocked over a compatibility path,
  which the prompt must therefore treat as high; most other PRs in this
  consumer also change contracts between separately deployed parts. Adding a
  size cut to the model's high answers gives 71% high at 135 lines with no
  loss, and 56% at 500 lines while losing 4 of the 13 blocked PRs outside the
  path rule.
- Credits per review on that consumer (771 measured runs, list rates): today
  167 on average. Proposed: trivial 0; normal 19 with a GPT-6.1 Sol single
  pass, or 9 with GPT-6.1 Terra, both estimated from the parent's measured
  tokens, plus 0.17 for the triage call; high 141 to 165 with 2 GPT-6.1 Sol
  workers. With the v2 shares (75% high, 17% normal, 8% trivial) a week costs
  65% to 76% of today, before the savings of [review-scope](#review-scope).
  Reviewing the trivial share at the normal level adds about 1% of today.
- The share rule failed in both runs. A 40–50% high share would cost
  blocking-defect recall on this consumer, so the owner chose a cheaper
  review for PRs that only the model marks high.
- Decision (owner, 2026-11-04): `parent-model: auto` routes by review level,
  with `risk-triage-v2` as the triage prompt (`engine/risk-triage.cjs`
  `LEVELS`):
  - floor-high, the path rule: GPT-6 Astra, 2 focused workers, the rules
    worker;
  - model-high, a high, failed or missing triage answer: GPT-6 Astra with its
    child threads and the rules worker, no focused workers;
  - normal: one GPT-6.1 Sol pass at `medium`, without child threads, focused
    workers or the rules worker;
  - An explicit `parent-model` keeps the configured model, workers and effort.
    An explicit `focused-workers` count overrides the level's.
- No trivial level in the engine. An independent review of the first wiring
  found that a no-model pass reopened bypasses that one consumer's own gate
  had to close: binary, mode and symlink changes counted as 0 lines;
  minified lines; code and MDX under `docs/` exempt from the floor; quoted
  paths missing the floor; review-policy files passing unreviewed; and an
  unreadable comment history read as "no BLOCK". Other consumers accept
  engine settlements without re-checking them. Tiny PRs therefore get the
  normal pass. A consumer may skip review for trivial PRs only in its own
  merge gate, which must re-derive the level from base-owned code; one
  consumer does. An engine-level trivial pass is reconsidered only together
  with a gate-side re-check in every consumer that uses it.
- The floor (`sensitivePaths` in `engine/focused-workers.cjs`) also covers
  review and merge machinery, prompts, rule packs (the configured rule-pack
  path included), agent instructions, `.github/`, `engine/` and `action.yml`,
  even as Markdown, because a PR could weaken its own review through them.
  Only tests and Markdown prose are exempt, so code and MDX under `docs/`
  count. Paths are read NUL-delimited, so quoted names still match.
- The floor wins over a consumer's docs-only paths: a PR or a push after a
  pass that changes a floor file is neither skipped nor carried as docs-only.
  Floor files stay eligible for focused workers and in the rules worker's
  patch even when they are docs or tests.
- `risk-triage.cjs` and its prompt are trusted runner files. A `risk` that is
  not exactly one of the strings is an invalid answer, which counts as high.
  Unreadable PR comments give a full review, never "no earlier settlement".
- Measured shares at that consumer before the wider floor: about 42%
  floor-high, 32% model-high and 25% normal of merged PRs.
- The normal-level reviewer comparison above (GPT-6.1 Terra against GPT-6.1
  Sol) runs when pool capacity allows.
- Reopen when a review blocks on a P0 or P1 finding in a PR the triage marked
  normal, when the normal-level comparison favours another model, or when the
  calibration drifts (see the [evaluation protocol](evaluation-protocol.md#risk-triage-calibration)).

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
