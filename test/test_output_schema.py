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
        "stable_id": "OR-1",
        "severity": "P2",
        "reachability": "normal_path",
        "likelihood": "low",
        "likely_consequence": "A request fails.",
        "worst_credible_consequence": "A request fails.",
        "recoverability": "routine",
        "proof_strength": "deterministic_static_proof",
        "attribution": "introduced",
        "risk_rationale": "A supported caller fails.",
        "disposition": "FIX_IN_PR",
        "autonomous_eligibility": "YES",
        "title": "Failure",
        "failure_scenario": "A supported request fails.",
        "approved_invariant": "Preserve request behavior.",
        "where": "src/example.ts:1-1",
        "evidence": "The changed route rejects the request.",
        "affected_lifecycle_planes": [],
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
        },
        "new_findings": [{**issue, "stable_id": f"OR-{i}"} for i in range(count)],
        "prior_issue_evaluations": [],
    }


class OutputSchemaTest(unittest.TestCase):
    def test_every_object_meets_strict_output_schema_rules(self):
        def visit(value, path="$", seen=None):
            if seen is None:
                seen = set()
            if isinstance(value, dict):
                if value.get("type") == "object":
                    self.assertIs(value.get("additionalProperties"), False, path)
                    self.assertEqual(set(value.get("required", [])), set(value.get("properties", {})), path)
                    self.assertEqual(len(value.get("required", [])), len(set(value.get("required", []))), path)
                    seen.add(path)
                for key, child in value.items():
                    visit(child, f"{path}.{key}", seen)
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    visit(child, f"{path}[{index}]", seen)
            return seen

        self.assertGreaterEqual(len(visit(SCHEMA)), 4)

    def test_eight_and_twenty_five_findings_validate_but_twenty_six_do_not(self):
        jsonschema.validate(output_with_findings(8), SCHEMA)
        jsonschema.validate(output_with_findings(25), SCHEMA)
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(output_with_findings(26), SCHEMA)
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(output_with_findings(51), SCHEMA)


if __name__ == "__main__":
    unittest.main()
