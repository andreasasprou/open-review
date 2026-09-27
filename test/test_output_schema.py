"""The output schema must preserve every supported finding up to its safety limit."""

import json
import unittest
from pathlib import Path

import jsonschema


SCHEMA = json.loads(
    (Path(__file__).resolve().parents[1] / "engine" / "output-schema.json").read_text()
)


def output_with_findings(count):
    issue = {
        "id": "OR-1",
        "severity": "P2",
        "reachability": "normal_path",
        "likelihood": "low",
        "worst_credible_consequence": "A request fails.",
        "recoverability": "routine",
        "area": "Code",
        "category": "correctness",
        "title": "Failure",
        "location": "src/example.ts:1-1",
        "status": "open",
        "notes": "",
        "first_seen_head_sha": "a" * 40,
        "last_seen_head_sha": "a" * 40,
    }
    return {
        "review_markdown": "## Verdict: ATTENTION\n",
        "inline_comments": [],
        "state": {
            "schema_version": 1,
            "last_reviewed_head_sha": "a" * 40,
            "review_count": 1,
            "updated_at": "2026-09-26T00:00:00Z",
            "pr_summary": "Example",
            "open_issues": [{**issue, "id": f"OR-{i}"} for i in range(count)],
            "recently_resolved_issues": [],
            "review_dispositions": [],
        },
    }


class OutputSchemaTest(unittest.TestCase):
    def test_eight_and_twenty_five_findings_validate_but_twenty_six_do_not(self):
        jsonschema.validate(output_with_findings(8), SCHEMA)
        jsonschema.validate(output_with_findings(25), SCHEMA)
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(output_with_findings(26), SCHEMA)
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(output_with_findings(51), SCHEMA)


if __name__ == "__main__":
    unittest.main()
