#!/usr/bin/env python3

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "engine" / "check-execution-evidence.py"
HEADER = "diff --git a/example.txt b/example.txt"
PATCH = HEADER + "\nnew file mode 100644\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+example\n"


class ExecutionEvidenceTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.patch = self.root / ".codex-ci" / "pr-diff.patch"
        self.patch.parent.mkdir()
        self.patch.write_text(PATCH, encoding="utf-8")

    def check(self, events):
        transcript = self.root / "events.jsonl"
        transcript.write_text(
            "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
        )
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(transcript), str(self.patch)],
            capture_output=True,
            text=True,
        )

    def command(self, output, command="cat .codex-ci/pr-diff.patch", exit_code=0):
        return {
            "type": "item.completed",
            "item": {
                "type": "command_execution",
                "command": command,
                "aggregated_output": output,
                "exit_code": exit_code,
            },
        }

    def test_patch_read_after_context_without_final_newline(self):
        (self.root / "context.json").write_text('{"evidence":{}}', encoding="utf-8")
        command = "cat context.json; sed -n '1,180p' .codex-ci/pr-diff.patch"
        execution = subprocess.run(
            ["bash", "-c", command], cwd=self.root, capture_output=True, text=True
        )
        self.assertEqual(execution.returncode, 0, execution.stderr)
        self.assertTrue(execution.stdout.startswith('{"evidence":{}}' + HEADER))

        result = self.check([self.command(execution.stdout, command)])

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("commands=1 scoped_input_reads=1", result.stdout)

    def test_complete_headers_with_different_line_endings(self):
        for output in (HEADER + "\n", HEADER + "\r\n", HEADER, "prefix" + HEADER):
            with self.subTest(output=output):
                result = self.check([self.command(output)])
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_full_scoped_patch_path(self):
        result = self.check([
            self.command(HEADER, "cat .codex-ci/pr-diff-full.patch")
        ])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_later_compound_command_failure_preserves_read_evidence(self):
        result = self.check([
            self.command(HEADER + "\n", "cat .codex-ci/pr-diff.patch; false", 1)
        ])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_truncated_or_extended_headers_do_not_prove_a_read(self):
        for output in (
            "prefixdiff --git a/other.txt b/other.txt\n",
            "prefix" + HEADER[:-1] + "\n",
            "prefix" + HEADER + ".other\n",
            HEADER + " trailing output\n",
            "example.txt\n",
            "",
            None,
            [HEADER],
        ):
            with self.subTest(output=output):
                result = self.check([self.command(output)])
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("scoped_input_reads=0", result.stdout)

    def test_header_requires_a_scoped_path_in_the_same_command(self):
        for command in ("git diff", "git show HEAD", "cat changed-files.txt", None):
            with self.subTest(command=command):
                result = self.check([self.command(HEADER, command)])
                self.assertEqual(result.returncode, 1, result.stderr)

        result = self.check([
            self.command("example.txt\n"),
            self.command(HEADER, "git diff"),
        ])
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("commands=2 scoped_input_reads=0", result.stdout)

    def test_missing_output_does_not_prove_a_read(self):
        event = self.command(HEADER)
        del event["item"]["aggregated_output"]
        result = self.check([event])
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_other_events_do_not_count_as_completed_commands(self):
        started = self.command(HEADER)
        started["type"] = "item.started"
        message = self.command(HEADER)
        message["item"]["type"] = "agent_message"
        for events in ([], [started], [message]):
            with self.subTest(events=events):
                result = self.check(events)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("commands=0 scoped_input_reads=0", result.stdout)

    def test_patch_without_headers_cannot_settle(self):
        self.patch.write_text("", encoding="utf-8")
        result = self.check([self.command(HEADER)])
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("scoped diff contains no diff --git headers", result.stderr)


if __name__ == "__main__":
    unittest.main()
