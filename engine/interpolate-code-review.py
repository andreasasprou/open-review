#!/usr/bin/env python3
"""Build the code-review prompt in two phases.

`assemble` joins the engine prompt (`prompt/core.md` + `prompt/contract.md`)
with a repository rule pack and the configured model names, and writes the
review template to stdout. The rule pack becomes Part 2. It may also override
the named slots that `core.md` declares with

    <!-- open-review:slot NAME -->
    ...
    <!-- open-review:end-slot -->

blocks; text outside slot blocks is the Part 2 body. A slot the rule pack does
not override keeps the default text written in `core.md`.

Without arguments, the script interpolates a template with lightweight PR
context, exactly as before the split. Heavy context (repository guidance, the
diff) is NOT inlined — Codex reads those files on demand from the workspace.
Only small metadata (previous state, changed files, commits) is inlined
because it's always useful and tiny. The template is read from
CODE_REVIEW_TEMPLATE_PATH, which the caller assembled from trusted sources.
"""

import argparse
import os
import re
import sys

SLOT_RE = re.compile(
    r"^<!-- open-review:slot ([a-z][a-z0-9-]*) -->\n(.*?)^<!-- open-review:end-slot -->(?:\n|\Z)",
    re.M | re.S,
)
MARKER_RE = re.compile(r"<!-- open-review:")


class AssemblyError(Exception):
    pass


def read_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return ""


def trim_blank_lines(text: str) -> str:
    lines = text.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def split_slots(text: str, source: str):
    """Return ({name: content}, text with every slot block removed)."""
    slots = {}
    for match in SLOT_RE.finditer(text):
        name = match.group(1)
        if name in slots:
            raise AssemblyError(f"{source}: slot '{name}' is defined twice")
        slots[name] = trim_blank_lines(match.group(2))
    remainder = SLOT_RE.sub("", text)
    if MARKER_RE.search(remainder):
        raise AssemblyError(f"{source}: malformed or unterminated open-review slot marker")
    return slots, remainder


def render_slot(content: str) -> str:
    return f"{content}\n\n" if content else ""


def replace_once(text: str, placeholder: str, value: str, source: str) -> str:
    count = text.count(placeholder)
    if count != 1:
        raise AssemblyError(f"{source}: expected {placeholder} exactly once, found {count}")
    return text.replace(placeholder, value)


def assemble(core: str, contract: str, rules: str, parent_model: str, child_model: str) -> str:
    if not core or not contract:
        raise AssemblyError("engine prompt files are missing or empty")
    if not parent_model or not child_model:
        raise AssemblyError("parent and child model names are required")

    rule_slots, rules_body = split_slots(rules, "rule pack")
    rules_body = trim_blank_lines(rules_body)
    if not rules_body:
        raise AssemblyError("rule pack has no Part 2 body")

    core_slots, _ = split_slots(core, "core.md")
    unknown = sorted(set(rule_slots) - set(core_slots))
    if unknown:
        raise AssemblyError(f"rule pack overrides unknown slot(s): {', '.join(unknown)}")

    template = SLOT_RE.sub(
        lambda match: render_slot(rule_slots.get(match.group(1), core_slots[match.group(1)])),
        core,
    )
    for placeholder, value in (("${PARENT_MODEL}", parent_model), ("${CHILD_MODEL}", child_model)):
        template = template.replace(placeholder, value)
        contract = contract.replace(placeholder, value)
    template = replace_once(template, "${OUTPUT_CONTRACT}\n", contract, "core.md")
    # Rules go in last so rule-pack text is never rewritten by the assembly.
    return replace_once(template, "${RULES_SECTION}", rules_body, "core.md")


def assemble_main(argv):
    parser = argparse.ArgumentParser(prog="interpolate-code-review.py assemble")
    parser.add_argument("--rules", required=True, help="rule pack file (from a trusted ref)")
    parser.add_argument("--parent-model", required=True)
    parser.add_argument("--child-model", required=True)
    parser.add_argument(
        "--prompt-dir",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompt"),
    )
    args = parser.parse_args(argv)
    rules = read_file(args.rules)
    if not rules:
        print(f"ERROR: Could not read rule pack {args.rules}", file=sys.stderr)
        sys.exit(1)
    try:
        template = assemble(
            read_file(os.path.join(args.prompt_dir, "core.md")),
            read_file(os.path.join(args.prompt_dir, "contract.md")),
            rules,
            args.parent_model,
            args.child_model,
        )
    except AssemblyError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
    sys.stdout.write(template)


def main():
    template_path = os.environ.get("CODE_REVIEW_TEMPLATE_PATH", "")
    template = read_file(template_path) if template_path else ""
    if not template:
        print(f"ERROR: Could not read {template_path or 'CODE_REVIEW_TEMPLATE_PATH (unset)'}", file=sys.stderr)
        sys.exit(1)
    body_path = os.environ.get("PR_BODY_FILE", "")
    try:
        with open(body_path, "r", encoding="utf-8") as body_file:
            body = body_file.read().encode("utf-8")[:4000].decode("utf-8", errors="ignore")
    except (OSError, UnicodeError) as error:
        print(f"ERROR: Could not read PR body file {body_path or '(unset)'}: {error}", file=sys.stderr)
        sys.exit(1)

    prompt = template

    # Interpolate small env vars (always needed, tiny)
    env_vars = [
        "PR_NUMBER",
        "PR_TITLE",
        "PR_BODY",
        "BASE_REF",
        "HEAD_REF",
        "REVIEW_MODE",
        "REVIEW_SCOPE_REASON",
        "COMMIT_RANGE",
        "COMMIT_COUNT",
        "DIFF_BASE_SHA",
        "MERGE_BASE_SHA",
        "HEAD_SHA",
    ]
    for var in env_vars:
        value = body if var == "PR_BODY" else os.environ.get(var, "")
        prompt = prompt.replace(f"${{{var}}}", value)

    # Inline small metadata (always useful, < 1KB each)
    prompt = prompt.replace(
        "${INLINE_CHANGED_FILES}",
        read_file(".codex-ci/changed-files.txt").strip() or "(none)",
    )
    prompt = prompt.replace(
        "${INLINE_REVIEW_COMMITS}",
        read_file(".codex-ci/review-commits.txt").strip() or "(none)",
    )
    prompt = prompt.replace(
        "${INLINE_PREV_STATE}",
        read_file(".codex-ci/state-prev.json").strip() or "{}",
    )

    sys.stdout.write(prompt)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "assemble":
        assemble_main(sys.argv[2:])
    else:
        main()
