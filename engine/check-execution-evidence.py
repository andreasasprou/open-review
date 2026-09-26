#!/usr/bin/env python3
"""Refuse settlement when a local review run shows no execution evidence.

A review run whose sandbox is broken degrades silently: Codex cannot run any
shell command in the prepared worktree, never reads the scoped
`.codex-ci/pr-diff.patch`, and falls back to re-fetching whole files from the
GitHub connector — reviewing repository HEAD instead of the PR's scoped diff
(observed in production: 24 consecutive runs with zero command executions).
This gate makes that mode loud instead of green.

Usage: check-execution-evidence.py <codex-output.jsonl> <pr-diff.patch>

Prints an evidence summary line on stdout. Exits 0 when the transcript shows
at least one completed shell command AND at least one command that references
the prepared scoped diff (`pr-diff.patch` / `pr-diff-full.patch`) and emits
at least one exact `diff --git a/... b/...` header from that prepared patch in
its aggregated output. Exits 1 otherwise.

The evidence predicate is deliberately narrow: filename lists
(changed-files.txt) and generic `git diff`/`git show` matches do not prove
the patch was read — a failed diff, or an unrelated command merely
containing those words, would satisfy a broad regex (an earlier review
finding). The literal scoped path plus a header from the actual prepared patch
is the discriminating signal. A later command in the same shell expression may
fail after the diff has already been read, so the compound exit code is not
proof that the scoped read failed.
"""

import json
import re
import sys

SCOPED_DIFF_PATTERN = re.compile(r"pr-diff(-full)?\.patch")


def load_patch_headers(patch_path: str) -> set[str]:
    with open(patch_path, encoding="utf-8", errors="replace") as patch:
        return {
            line.rstrip("\r\n")
            for line in patch
            if line.startswith("diff --git ")
        }


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: check-execution-evidence.py"
            " <codex-output.jsonl> <pr-diff.patch>",
            file=sys.stderr,
        )
        return 2

    try:
        patch_headers = load_patch_headers(sys.argv[2])
    except OSError as error:
        print(f"error: could not read scoped diff headers: {error}", file=sys.stderr)
        return 2
    if not patch_headers:
        print(
            "error: scoped diff contains no diff --git headers;"
            " refusing settlement.",
            file=sys.stderr,
        )
        return 1

    command_count = 0
    scoped_input_reads = 0
    sandbox_violation_lines = 0

    with open(sys.argv[1], encoding="utf-8", errors="replace") as transcript:
        for line in transcript:
            stripped = line.strip()
            if "codex_sandboxing" in stripped and "violation" in stripped:
                sandbox_violation_lines += 1
            if not stripped.startswith("{"):
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "item.completed":
                continue
            item = event.get("item") or {}
            if item.get("type") != "command_execution":
                continue
            command_count += 1
            command = item.get("command")
            aggregated_output = item.get("aggregated_output")
            output_lines = (
                set(aggregated_output.splitlines())
                if isinstance(aggregated_output, str)
                else set()
            )
            if (
                isinstance(command, str)
                and SCOPED_DIFF_PATTERN.search(command)
                and not patch_headers.isdisjoint(output_lines)
            ):
                scoped_input_reads += 1

    print(
        "Execution evidence: "
        f"commands={command_count} "
        f"scoped_input_reads={scoped_input_reads} "
        f"sandbox_violation_lines={sandbox_violation_lines}"
    )

    if command_count == 0:
        print(
            "error: review transcript contains zero shell command executions;"
            " the sandbox is likely broken (bwrap/user-namespace denial) and"
            " the review could not read the prepared scoped diff. Refusing"
            " settlement.",
            file=sys.stderr,
        )
        return 1
    if scoped_input_reads == 0:
        print(
            "error: review ran shell commands but no command emitted an exact"
            " header from the scoped diff (.codex-ci/pr-diff.patch); the"
            " review is not scoped to the PR diff. Refusing settlement.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
