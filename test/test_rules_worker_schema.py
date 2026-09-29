"""The rules worker contract is strict at every object boundary."""
import json
import unittest
from pathlib import Path

import jsonschema

SCHEMA = json.loads((Path(__file__).resolve().parents[1] / 'engine' / 'rules-worker-schema.json').read_text())


def output():
    return {'findings': [{'title': 'Stub the logger', 'file': 'src/a.test.ts', 'line': 9, 'severity': 'P3',
                          'rule_source': 'docs/logging.md:4', 'change': 'imports the real logger',
                          'violation': 'tests must stub the logger'}],
            'files_read': ['AGENTS.md']}


class RulesWorkerSchemaTest(unittest.TestCase):
    def test_objects_are_closed_and_complete(self):
        for node in (SCHEMA, SCHEMA['properties']['findings']['items']):
            self.assertIs(node['additionalProperties'], False)
            self.assertEqual(set(node['required']), set(node['properties']))

    def test_contract_accepts_full_object_and_rejects_bad_values(self):
        jsonschema.validate(output(), SCHEMA)
        for mutate in (
            lambda v: v['findings'][0].update(severity='P1'),
            lambda v: v['findings'][0].update(title='x' * 201),
            lambda v: v['findings'][0].update(extra=1),
            lambda v: v['findings'][0].pop('rule_source'),
            lambda v: v.update(findings=[v['findings'][0]] * 9),
        ):
            value = output()
            mutate(value)
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(value, SCHEMA)


if __name__ == '__main__':
    unittest.main()
