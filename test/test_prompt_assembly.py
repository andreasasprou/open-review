#!/usr/bin/env python3
"""Assembly contract for the review prompt and the example rule pack."""

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE_SCRIPT = ROOT / "engine" / "interpolate-code-review.py"
EXAMPLE_RULES = ROOT / "examples" / "rules.md"

SPEC = importlib.util.spec_from_file_location("interpolate_code_review", ENGINE_SCRIPT)
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)


def assemble_cli(rules_path):
    return subprocess.run(
        [
            sys.executable,
            str(ENGINE_SCRIPT),
            "assemble",
            "--rules",
            str(rules_path),
            "--parent-model",
            "gpt-6-astra",
            "--child-model",
            "gpt-6-luna",
        ],
        capture_output=True,
        text=True,
    )


class AssemblyContractTest(unittest.TestCase):
    def core(self):
        return (ROOT / "engine" / "prompt" / "core.md").read_text(encoding="utf-8")

    def contract(self):
        return (ROOT / "engine" / "prompt" / "contract.md").read_text(encoding="utf-8")

    def test_rule_pack_without_slots_uses_core_defaults(self):
        template = engine.assemble(self.core(), self.contract(), "# Part 2 — Example Guidelines\n\nBe kind.\n", "parent-x", "child-y")
        self.assertNotIn("open-review:", template)
        self.assertNotIn("${RULES_SECTION}", template)
        self.assertNotIn("${OUTPUT_CONTRACT}", template)
        self.assertNotIn("\n\n\n", template)
        self.assertIn("---\n\n# Part 2 — Example Guidelines\n\nBe kind.\n\n---\n\n# Part 3", template)
        self.assertIn("configured `child-y` model; use `parent-x` with", template)
        self.assertIn("Part 2 is the\nrepository's own guidance", template)
        # The empty fail-fast slot leaves Part 1 exactly as the generic rubric.
        self.assertIn(
            "7. When uncertain, prefer crashing fast over silent degradation.\n\n## Review priorities",
            template,
        )
        self.assertTrue(template.endswith("Existing finding state belongs to the publisher's v4 ledger.\n"))

    def test_slot_override_replaces_default(self):
        rules = (
            "<!-- open-review:slot fail-fast -->\nProject refinement.\n<!-- open-review:end-slot -->\n\n"
            "# Part 2 — Example\n\nRule.\n"
        )
        template = engine.assemble(self.core(), self.contract(), rules, "p", "c")
        self.assertIn("degradation.\n\nProject refinement.\n\n## Review priorities", template)
        self.assertNotIn("Project refinement.", template.split("# Part 2")[1])

    def test_rejects_unknown_duplicate_and_unterminated_slots(self):
        cases = {
            "unknown": "<!-- open-review:slot nope -->\nx\n<!-- open-review:end-slot -->\nbody\n",
            "duplicate": (
                "<!-- open-review:slot role -->\nx\n<!-- open-review:end-slot -->\n"
                "<!-- open-review:slot role -->\ny\n<!-- open-review:end-slot -->\nbody\n"
            ),
            "unterminated": "<!-- open-review:slot role -->\nx\nbody\n",
            "empty body": "<!-- open-review:slot role -->\nx\n<!-- open-review:end-slot -->\n\n",
        }
        for name, rules in cases.items():
            with self.subTest(name):
                with self.assertRaises(engine.AssemblyError):
                    engine.assemble(self.core(), self.contract(), rules, "p", "c")

    def test_cli_fails_on_missing_rule_pack(self):
        result = assemble_cli(ROOT / "does-not-exist.md")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Could not read rule pack", result.stderr)

    def test_example_rule_pack_defines_the_terms_core_relies_on(self):
        result = assemble_cli(EXAMPLE_RULES)
        self.assertEqual(result.returncode, 0, result.stderr)
        part2 = result.stdout.split("# Part 2 — ", 1)[1].split("# Part 3 — ", 1)[0]
        for term in ("Central claim", "Findings Bar", "`normal_path`", "`compound_path`", "`theoretical`", "**P0**", "**P1**", "**P2**"):
            with self.subTest(term):
                self.assertIn(term, part2)

    def test_dependency_map_and_conditional_investigator_are_assembled(self):
        prompt = engine.assemble(self.core(), self.contract(), "# Part 2 — Rules\n", "parent", "child")
        self.assertIn("dependency map runs first whenever the changed-contracts list is non-empty", prompt)
        self.assertIn("- **Dependency map** (read-only; grep and file reads only)", prompt)
        self.assertIn("For each changed symbol, name the companion files", prompt)
        self.assertIn("run the **contract audit** on the\n   dependency map", prompt)
        self.assertLess(prompt.index("- **Dependency map**"), prompt.index("- **Contract investigator**"))
        self.assertIn("Read `.codex-ci/change-impact.md` if it exists", prompt)
        self.assertIn("If there is at least one obligation, spawn one **contract investigator**", prompt)
        self.assertIn("after the dependency map when it runs, with all obligations", prompt)
        self.assertIn("If the file is missing or has no obligations,\ncontinue with the other briefs", prompt)
        self.assertIn("children only when there are more than 40 obligations", prompt)
        self.assertIn("`model: gpt-6-sol` and `reasoning_effort: high`", prompt)
        self.assertIn("Your primary target is an UNCHANGED consumer or producer", prompt)
        self.assertIn("For a write, also work backward from reader requirements", prompt)
        self.assertIn("result: compatible | counterexample | unresolved", prompt)
        self.assertIn("`unresolved` row under \"Risks Not Raised\"", prompt)


if __name__ == "__main__":
    unittest.main()
