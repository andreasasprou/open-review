# open-review

A GitHub Action that reviews pull requests with the Codex CLI. A read-only
parent reviewer delegates bounded investigations to child agents, and then
publishes one summary comment, inline comments on diff lines, and a check run.
Findings carry over between review passes through hidden state comments.

A finding blocks the merge only when its severity is P0 or P1 and its
reachability is not `theoretical`. Trusted code makes that decision from the
structured output, not the model's verdict word.

## Use it

1. Copy [`examples/rules.md`](examples/rules.md), fill in its placeholders,
   and commit it to the default branch, for example `.github/review-rules.md`.
2. Copy [`examples/consumer-workflow.yml`](examples/consumer-workflow.yml) to
   `.github/workflows/`, pin `uses:` to a full commit SHA, and set
   `provider-base-url` to a Responses-API model provider. Put its key, if it
   needs one, in a secret and name the variable in `provider-env-key`.
   ChatGPT `auth.json` is not supported: the reviewer's read-only shell can
   read runner files, so a credential file on the runner would be exposed.
3. Reviews run on PR updates, on `/open-review [full|reset|--since <sha>]`
   comments from members and collaborators, or by manual dispatch from the
   default branch.

| Input | Default | Purpose |
|---|---|---|
| `rules-path` | (required) | Rule pack path. It is read from the default branch. |
| `parent-model` / `parent-reasoning-effort` | `gpt-6-astra` / `high` | Parent reviewer |
| `child-model` / `child-reasoning-effort` | `gpt-6-luna` / `max` | Default for child agents |
| `codex-cli-version` | `0.157.1` | Exact `@openai/codex` version |
| `provider-base-url` / `provider-env-key` | (required) / empty | The Responses-API model provider, with an optional variable that holds a Bearer key |
| `check-name` | `Open Review` | Check run name |
| `command` | `open-review` | Slash command name(s) |
| `decision-owners` | empty | Logins whose replies count as trusted dispositions |
| `framework-decision-owners` | empty | Logins allowed to evolve the review framework; defaults to decision owners |
| `disposition-marker` | `open-review-dispositions:v1:base64` | Marker for disposition-ledger comments |
| `context-keywords` | empty | Extra words that mark a comment as review discussion |
| `session-resume` | `true` | Continues the previous Codex session on incremental reviews |
| `provider-session-resume` | `false` | Allows session resume through a custom provider |
| `focused-workers` | `4` | Advisory Sol workers, one per changed non-test file; findings go to a summary section and never block merge |
| `rules-worker` | `true` | Advisory check of every changed file, tests included, against `AGENTS.md` and the guidance it points to |
| `review-budget-minutes` | `20` | Total hosted Codex budget across attempts (1–120 minutes) |
| `pr-number` | empty | PR number for `workflow_dispatch` |

The action has one output, `rules_changed`. It is `true` when the PR edits the
rule pack. In that case the review used the default-branch version and says so.

## Trust model

- The action's code and prompt come from the pinned action ref. The action
  copies them outside the workspace before it checks out the PR head.
- The rule pack comes from the PR base commit when it targets the default
  branch and has the pack. Otherwise, it comes from the default branch's
  current head. A PR cannot rewrite the rules it is judged by.
- The PR head is checked out without credentials. `GITHUB_TOKEN` never reaches
  Codex.
- Codex runs read-only with web search disabled. The action probes the sandbox
  first. After the run, a transcript gate requires proof that the reviewer
  read the scoped diff, and a dirty-tree check fails the job if Codex changed
  any tracked file.

## Rule packs

The prompt is built from `engine/prompt/core.md`, the rule pack, and
`engine/prompt/contract.md`. The rule pack becomes Part 2. Start it with a
`# Part 2 — <Name> Guidelines` heading. The core prompt and the merge gate rely
on terms that only the rule pack defines: the central claim, the Findings Bar
(including user impact and the failure scenario), reachability
(`normal_path`, `compound_path`, `theoretical`), likelihood, recoverability,
worst credible consequence, and P0/P1/P2 severity.
[`examples/rules.md`](examples/rules.md) defines each of them in generic terms
and leaves placeholders for repo invariants, guidance files and priorities.

A rule pack can also override the slots that `core.md` declares: `role` (the
reviewer framing), `parts` (the prompt overview) and `fail-fast` (a
repository refinement of the fail-fast rules):

```markdown
<!-- open-review:slot role -->
You are acting as a code reviewer for a proposed change to **Acme**...
<!-- open-review:end-slot -->
```

Rule packs and recall sets stay in the consumer repository; this repository
ships only the engine.

To prove behaviour parity in its own CI, a consumer renders the prompt with
`python3 engine/interpolate-code-review.py assemble --rules <path>
--parent-model <model> --child-model <model>` at the pinned action ref and
compares the output with a committed snapshot.

## Local runs and recall evals

`engine/run-local.sh --pr <n> --rules <path>` reviews a PR of the current
checkout with the same prompt, sandbox and settlement as the action. The runner
checks its own engine files against the engine repository's `origin/main`
before it publishes anything.
Set `OPEN_REVIEW_ENGINE_REF` to a full commit SHA when a consumer pins the
engine to its hosted action. In that mode the runner requires the checkout's
`HEAD` and runtime files to match that commit, even for unpublished development
runs, and does not fetch `origin/main`.
The runner needs Node.js with npm, not a particular Codex install: when the
machine's `codex` is another version, it installs the pinned version once into
`${XDG_CACHE_HOME:-~/.cache}/open-review/codex/<version>` and uses it for that
run only. It needs model credentials: `--provider-base-url <url>`, or a
ChatGPT login (`codex login`).

`eval/run-recall.sh --manifest <cases.json> --rules <path> --arm a=<ref> ...`
reviews known pre-fix PR heads and scores how many known defects each rule-pack
version finds.

## Tests

```sh
node --test test/*.test.cjs eval/*.test.cjs
python3 -m unittest discover -s test -p 'test_*.py'
```

## License

MIT

## Sandbox

The reviewer runs read-only under Codex's bubblewrap sandbox; network and all
writes are denied. On GitHub-hosted Ubuntu runners the action lifts the
AppArmor user-namespace restriction on the ephemeral runner first. To run
`engine/run-local.sh` on your own Ubuntu 24.04 machine, give only bwrap the
`userns` permission:

```bash
sudo tee /etc/apparmor.d/bwrap-userns >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns
```
