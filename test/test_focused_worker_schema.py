"""The focused worker contract is strict at every object boundary."""
import json
import unittest
from pathlib import Path

import jsonschema

SCHEMA = json.loads((Path(__file__).resolve().parents[1] / 'engine' / 'focused-worker-schema.json').read_text())


def output():
    return {
        'slice': 'src/a.ts', 'status': 'candidates',
        'candidates': [{
            'title': 'Missing guard', 'file': 'src/a.ts', 'line': 5,
            'property': 'Keep writes safe', 'property_source': 'src/rules.ts:1',
            'initial_state': 'empty', 'input': 'a write', 'trace': 'writer enters',
            'violation': 'write fails', 'pr_causality': 'new branch',
            'guard_checked': 'none', 'severity': 'P2',
        }],
        'inputs_tried': [], 'open_suspicions': [],
    }


class FocusedWorkerSchemaTest(unittest.TestCase):
    def test_every_string_is_bounded(self):
        def visit(node, name=''):
            if isinstance(node, dict):
                if node.get('type') == 'string':
                    self.assertEqual(node.get('maxLength'), 200 if name == 'title' else 2000)
                for key, child in node.get('properties', {}).items():
                    visit(child, key)
                if 'items' in node:
                    visit(node['items'])
        visit(SCHEMA)
        value = output()
        value['candidates'][0]['title'] = 'x' * 201
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(value, SCHEMA)

    def test_all_objects_have_complete_required_sets_and_no_extra_properties(self):
        seen = 0
        def visit(value):
            nonlocal seen
            if isinstance(value, dict):
                if value.get('type') == 'object':
                    seen += 1
                    self.assertIs(value.get('additionalProperties'), False)
                    self.assertEqual(set(value.get('required', [])), set(value.get('properties', {})))
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(SCHEMA)
        self.assertEqual(seen, 2)

    def test_contract_accepts_full_object_and_rejects_missing_extra_and_bad_types(self):
        jsonschema.validate(output(), SCHEMA)
        for mutate in (
            lambda o: o.pop('inputs_tried'),
            lambda o: o.update(extra=True),
            lambda o: o['candidates'][0].pop('guard_checked'),
            lambda o: o['candidates'][0].update(extra=True),
            lambda o: o['candidates'][0].update(line='5'),
            lambda o: o['candidates'][0].update(severity='P0'),
        ):
            value = output(); mutate(value)
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(value, SCHEMA)


if __name__ == '__main__':
    unittest.main()
