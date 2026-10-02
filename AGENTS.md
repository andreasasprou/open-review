# Agent instructions

## This repository is public

- Never commit code, diffs, PR numbers, file paths, findings or model output
  from a consumer repository. Use synthetic fixtures and names.
- Before you push, search the diff for consumer names, paths and identifiers.

## Model and architecture changes

These rules apply when you change a model, a reasoning effort, a worker count,
a time limit, the Codex CLI version or the review budget default; when you add
or remove a review stage; and when you change a prompt to find more or fewer
defects. Prompt wording and bug fixes are out of scope.

1. Read `docs/decisions.md`. Do not retest a rejected option unless its reopen
   condition has happened.
2. Before you run an evaluation, add a decision entry with the question and
   the decision rule.
3. Evaluate as `docs/evaluation-protocol.md` says.
4. Record the aggregate result and the decision in the entry. Update the
   "Current configuration" table in the same PR as the code.

## Tests

```sh
node --test test/*.test.cjs eval/*.test.cjs
python3 -m unittest discover -s test -p 'test_*.py'
```
