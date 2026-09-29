#!/usr/bin/env python3

import importlib.util
import io
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
ROOT = TEST_DIR.parent
SCRIPT_DIR = ROOT / "engine"
SCRIPT_PATH = SCRIPT_DIR / "progress-reporter.py"
FIXTURE_PATH = TEST_DIR / "fixtures" / "progress-events.jsonl"
HOSTILE_FIXTURE_PATH = TEST_DIR / "fixtures" / "progress-hostile-events.jsonl"
CODE_REVIEW_WORKFLOW_PATH = ROOT / "action.yml"
RUN_LOCAL_PATH = SCRIPT_DIR / "run-local.sh"
SPEC = importlib.util.spec_from_file_location("progress_reporter", SCRIPT_PATH)
assert SPEC and SPEC.loader
progress_reporter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = progress_reporter
SPEC.loader.exec_module(progress_reporter)


class ManualClock:
    def __init__(self):
        self.value = 1000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class NotifyingOutput(io.StringIO):
    def __init__(self):
        super().__init__()
        self.condition = threading.Condition()

    def write(self, value):
        with self.condition:
            result = super().write(value)
            self.condition.notify_all()
            return result

    def rendered(self):
        with self.condition:
            return super().getvalue()

    def wait_for_lines(self, count, timeout):
        deadline = time.monotonic() + timeout
        with self.condition:
            while super().getvalue().count("\n") < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.condition.wait(remaining)
            return True


class AdvancingQueue:
    def __init__(self, clock):
        self.clock = clock
        self.inner = queue.Queue()
        self.timeouts = []
        self.second_get_started = threading.Event()

    def put(self, value):
        self.inner.put(value)

    def get(self, timeout):
        self.timeouts.append(timeout)
        if len(self.timeouts) == 1:
            self.clock.advance(progress_reporter.HEARTBEAT_SECONDS + 1)
            raise queue.Empty
        self.second_get_started.set()
        return self.inner.get(timeout=timeout)


class ProgressReporterTest(unittest.TestCase):
    def fixture_lines(self):
        return FIXTURE_PATH.read_text().splitlines()

    def test_synthetic_stream_renders_uniform_safe_lines(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(
            output=output,
            clock=clock,
        )

        advances = [0, 1, 1, 2, 1, 1, 1, 1]
        for index, line in enumerate(self.fixture_lines()):
            if index < len(advances):
                clock.advance(advances[index])
            if index == 8:
                clock.advance(60)
                self.assertTrue(reporter.emit_heartbeat_if_due())
            reporter.process_line(line)
            if index >= 10:
                clock.advance(1)
        reporter.finish()

        lines = output.getvalue().splitlines()
        self.assertTrue(all(line.startswith("[") for line in lines))
        self.assertIn(
            "[00m04s] Command completed: git duration=2.0s status=completed exit=0",
            lines,
        )
        self.assertIn(
            "[00m05s] Subagent spawned id=subagent-1 model=gpt-5.6-luna effort=high count=1",
            lines,
        )
        self.assertIn(
            "[00m08s] Subagent joined id=subagent-1 model=gpt-5.6-luna effort=high duration=3.0s",
            lines,
        )
        self.assertIn(
            "[01m08s] … still reasoning, last event 60s ago, 8 events total",
            lines,
        )
        self.assertEqual(
            [line for line in lines if "Tokens +" in line],
            ["[01m08s] Tokens +60,000 total=60,000"],
        )
        self.assertIn("[01m09s] Turn completed tokens=90,000", lines)
        self.assertIn("[01m10s] task_complete", lines)
        self.assertIn("[01m12s] Unknown event", lines)
        self.assertIn("[01m13s] Malformed event (ignored)", lines)
        self.assertEqual(
            lines[-1],
            "[01m14s] Summary: events=16 tool calls=3 subagents=1 tokens=90,000 wall time=01m14s",
        )
        rendered = output.getvalue()
        self.assertNotIn("SENSITIVE", rendered)
        self.assertNotIn("super-secret", rendered)
        self.assertNotIn("sub-1", rendered)
        self.assertNotIn("label=", rendered)
        self.assertNotIn("explorer", rendered)
        self.assertNotIn("\x1b", rendered)

    def test_malformed_nested_shapes_do_not_stop_processing(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())
        inputs = [
            '{"type":"item.started","item":null}',
            '{"type":"turn.completed","usage":[]}',
            '{"type":"error","error":"not an object"}',
            "[]",
            "null",
            "{\"type\":\"unknown\",\"payload\":{\"secret\":\"SENSITIVE\"}}",
            "[" * 2000 + "]" * 2000,
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "malformed-command",
                        "type": "command_execution",
                        "command": ["TOP_SECRET_FILE_CONTENT"],
                    },
                }
            ),
        ]

        for line in inputs:
            reporter.process_line(line)
        reporter.finish()

        self.assertEqual(reporter.event_count, len(inputs))
        self.assertIn("Malformed item", output.getvalue())
        self.assertIn("Unknown event", output.getvalue())
        self.assertNotIn("SENSITIVE", output.getvalue())
        self.assertNotIn("TOP_SECRET_FILE_CONTENT", output.getvalue())

    def test_direct_subagent_id_is_counted_and_joined(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(
            output=output,
            clock=ManualClock(),
        )
        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": "sub-2",
                        "model": "gpt-5.6-luna",
                        "reasoning_effort": "medium",
                        "label": "worker",
                    },
                }
            )
        )
        reporter.process_line(
            json.dumps({"type": "agent.subagent.completed", "subagent": {"id": "sub-2"}})
        )
        reporter.finish()

        self.assertIn(
            "Subagent spawned id=subagent-1 model=gpt-5.6-luna effort=medium count=1",
            output.getvalue(),
        )
        self.assertIn(
            "Subagent joined id=subagent-1 model=gpt-5.6-luna effort=medium duration=0.0s",
            output.getvalue(),
        )
        self.assertNotIn("label=", output.getvalue())
        self.assertNotIn("worker", output.getvalue())
        self.assertIn("subagents=1", output.getvalue())

    def test_subagent_sequence_ids_pair_out_of_order_joins(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        first_raw_id = "token=worker-one-secret"
        second_raw_id = "token=worker-two-secret"

        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": first_raw_id,
                        "model": "gpt-5.6-luna",
                        "reasoning_effort": "high",
                    },
                }
            )
        )
        clock.advance(1)
        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": second_raw_id,
                        "model": "composer-2.5",
                        "reasoning_effort": "low",
                    },
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.completed",
                    "subagent": {"id": second_raw_id},
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.completed",
                    "subagent": {"id": first_raw_id},
                }
            )
        )

        lines = output.getvalue().splitlines()
        self.assertEqual(
            lines,
            [
                "[00m00s] Subagent spawned id=subagent-1 model=gpt-5.6-luna effort=high count=1",
                "[00m01s] Subagent spawned id=subagent-2 model=composer-2.5 effort=low count=1",
                "[00m03s] Subagent joined id=subagent-2 model=composer-2.5 effort=low duration=2.0s",
                "[00m05s] Subagent joined id=subagent-1 model=gpt-5.6-luna effort=high duration=5.0s",
            ],
        )
        self.assertNotIn(first_raw_id, output.getvalue())
        self.assertNotIn(second_raw_id, output.getvalue())

    def test_batched_join_preserves_per_subagent_correlation(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        first_raw_id = "token=batch-worker-one"
        second_raw_id = "token=batch-worker-two"

        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": first_raw_id,
                        "model": "gpt-5.6-luna",
                        "reasoning_effort": "high",
                    },
                }
            )
        )
        clock.advance(1)
        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": second_raw_id,
                        "model": "composer-2.5",
                        "reasoning_effort": "low",
                    },
                }
            )
        )
        clock.advance(2)
        receiver_ids = [second_raw_id, first_raw_id]
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "wait-batch",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": receiver_ids,
                    },
                }
            )
        )
        clock.advance(1)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": "wait-batch",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": receiver_ids,
                        "agents_states": {
                            second_raw_id: {"status": "completed"},
                            first_raw_id: {"status": "completed"},
                        },
                    },
                }
            )
        )

        joined_lines = [
            line
            for line in output.getvalue().splitlines()
            if "Subagent joined" in line
        ]
        self.assertEqual(
            joined_lines,
            [
                "[00m04s] Subagent joined id=subagent-2 "
                "model=composer-2.5 effort=low duration=3.0s",
                "[00m04s] Subagent joined id=subagent-1 "
                "model=gpt-5.6-luna effort=high duration=4.0s",
            ],
        )
        self.assertTrue(all(len(line) <= 160 for line in joined_lines))
        self.assertNotIn(first_raw_id, output.getvalue())
        self.assertNotIn(second_raw_id, output.getvalue())

    def test_timed_out_wait_keeps_nonterminal_correlation_live(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        raw_id = "private-timed-out-worker"

        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": raw_id,
                        "model": "gpt-5.6-luna",
                        "reasoning_effort": "high",
                    },
                }
            )
        )
        clock.advance(1)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "wait-timed-out",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": [raw_id],
                    },
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": "wait-timed-out",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "status": "completed",
                        "receiver_thread_ids": [],
                        "agents_states": {},
                    },
                }
            )
        )

        normalized_id = progress_reporter.opaque_id(raw_id)
        self.assertIn(
            "[00m03s] Wait completed status=timed_out "
            "still_running=1 duration=2.0s",
            output.getvalue().splitlines(),
        )
        self.assertNotIn("Subagent joined", output.getvalue())
        self.assertEqual(reporter.subagent_local_ids[normalized_id], "subagent-1")
        self.assertIn(normalized_id, reporter.subagent_started_at)
        self.assertNotIn(raw_id, output.getvalue())

    def test_wait_completion_falls_back_to_start_receiver_snapshot(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        raw_id = "private-start-only-worker"

        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": raw_id,
                        "model": "gpt-6-astra",
                        "reasoning_effort": "xhigh",
                    },
                }
            )
        )
        clock.advance(1)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "wait-start-only",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": [raw_id],
                    },
                }
            )
        )
        clock.advance(4)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": "wait-start-only",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "status": "completed",
                        "agents_states": {raw_id: {"status": "completed"}},
                    },
                }
            )
        )

        self.assertIn(
            "[00m05s] Subagent joined id=subagent-1 model=gpt-6-astra "
            "effort=xhigh duration=5.0s",
            output.getvalue().splitlines(),
        )
        self.assertNotIn("subagent-2", output.getvalue())
        self.assertNotIn(raw_id, output.getvalue())

    def test_completed_wait_without_terminal_state_keeps_correlation_live(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        raw_id = "private-unconfirmed-worker"

        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": raw_id,
                        "model": "gpt-5.6-luna",
                        "reasoning_effort": "high",
                    },
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "wait-unconfirmed",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": [raw_id],
                    },
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": "wait-unconfirmed",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "status": "completed",
                    },
                }
            )
        )

        normalized_id = progress_reporter.opaque_id(raw_id)
        self.assertIn(
            "[00m02s] Wait completed status=completed "
            "still_running=1 duration=2.0s",
            output.getvalue().splitlines(),
        )
        self.assertNotIn("Subagent joined", output.getvalue())
        self.assertEqual(reporter.subagent_local_ids[normalized_id], "subagent-1")
        self.assertIn(normalized_id, reporter.subagent_started_at)
        self.assertNotIn(raw_id, output.getvalue())

    def test_mixed_wait_joins_only_completed_receivers(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        completed_id = "private-completed-worker"
        running_id = "private-running-worker"

        for raw_id, model, effort in (
            (completed_id, "gpt-6-astra", "high"),
            (running_id, "composer-2.5", "low"),
        ):
            reporter.process_line(
                json.dumps(
                    {
                        "type": "agent.subagent.started",
                        "subagent": {
                            "id": raw_id,
                            "model": model,
                            "reasoning_effort": effort,
                        },
                    }
                )
            )
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "wait-mixed",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": [completed_id, running_id],
                    },
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": "wait-mixed",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "status": "completed",
                        "receiver_thread_ids": [completed_id],
                        "agents_states": {
                            completed_id: {"status": "completed"},
                        },
                    },
                }
            )
        )

        lines = output.getvalue().splitlines()
        self.assertIn(
            "[00m02s] Subagent joined id=subagent-1 model=gpt-6-astra "
            "effort=high duration=2.0s",
            lines,
        )
        self.assertIn(
            "[00m02s] Wait completed status=completed "
            "still_running=1 duration=2.0s",
            lines,
        )
        self.assertFalse(any("Subagent joined id=subagent-2" in line for line in lines))
        self.assertNotIn(
            progress_reporter.opaque_id(completed_id), reporter.subagent_local_ids
        )
        self.assertEqual(
            reporter.subagent_local_ids[progress_reporter.opaque_id(running_id)],
            "subagent-2",
        )
        self.assertNotIn(completed_id, output.getvalue())
        self.assertNotIn(running_id, output.getvalue())

    def test_batched_join_keeps_known_metadata_with_safe_placeholders(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())

        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {
                        "id": "private-known",
                        "model": "gpt-5.6-luna",
                        "reasoning_effort": "high",
                    },
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.started",
                    "subagent": {"id": "private-unknown"},
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "type": "agent.subagent.completed",
                    "subagent": {
                        "receiver_thread_ids": [
                            "private-unknown",
                            "private-known",
                        ]
                    },
                }
            )
        )

        joined_lines = output.getvalue().splitlines()[-2:]
        self.assertEqual(
            joined_lines,
            [
                "[00m00s] Subagent joined id=subagent-2 duration=0.0s",
                "[00m00s] Subagent joined id=subagent-1 "
                "model=gpt-5.6-luna effort=high duration=0.0s",
            ],
        )
        self.assertNotIn("private-", output.getvalue())

    def test_hostile_receiver_fixture_bounds_output_and_state(self):
        duplicate_sources = [f"duplicate-{index}" for index in range(9)]
        duplicate_sources.extend(["duplicate-8"] * 100)
        bounds_reporter = progress_reporter.ProgressReporter(clock=ManualClock())
        bounded = bounds_reporter._subagent_ids(
            {
                "receiver_thread_ids": duplicate_sources,
                "agents_states": {raw_id: {} for raw_id in duplicate_sources},
            }
        )
        self.assertEqual(len(bounded.ids), 8)
        self.assertEqual(bounded.omitted, 1)

        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())
        raw_ids = [f"token=receiver-{index:06d}-secret" for index in range(100_000)]
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "hostile-large-wait",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": raw_ids,
                    },
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": "hostile-large-wait",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "agents_states": {
                            raw_id: {"status": "completed"} for raw_id in raw_ids
                        },
                    },
                }
            )
        )
        reporter.finish()

        joined_lines = [
            line for line in output.getvalue().splitlines() if "Subagent joined" in line
        ]
        self.assertEqual(len(joined_lines), 9)
        for index, line in enumerate(joined_lines[:8], start=1):
            self.assertEqual(
                line,
                f"[00m00s] Subagent joined id=subagent-{index} "
                "duration=0.0s",
            )
        self.assertEqual(joined_lines[-1], "[00m00s] Subagent joined +99992 more")
        self.assertTrue(all(len(line) <= 160 for line in joined_lines))
        self.assertLess(len(output.getvalue()), 1_000)
        self.assertLessEqual(len(reporter.correlation_fifo), 256)
        self.assertLessEqual(len(reporter.omitted_batches), 256)
        self.assertEqual(
            len(reporter.distinct_subagents.digests),
            progress_reporter.MAX_DISTINCT_SUBAGENTS,
        )
        self.assertFalse(reporter.distinct_subagents.overflowed)
        self.assertTrue(
            all(
                ("batch", fingerprint) in reporter.correlation_fifo
                for fingerprint in reporter.omitted_batches
            )
        )
        self.assertIn(
            "Summary: events=2 tool calls=1 subagents=100000", output.getvalue()
        )
        self.assertNotIn("still_running=99992", output.getvalue())
        self.assertNotIn(raw_ids[0], output.getvalue())
        self.assertNotIn(raw_ids[-1], output.getvalue())

    def test_distinct_subagent_ledger_overflow_is_categorical_and_bounded(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())

        for index in range(progress_reporter.MAX_DISTINCT_SUBAGENTS + 1):
            reporter.distinct_subagents.observe(("s", f"private-overflow-{index}"))
        reporter.finish()

        self.assertTrue(reporter.distinct_subagents.overflowed)
        self.assertEqual(reporter.distinct_subagents.digests, set())
        self.assertIn("subagents=invalid", output.getvalue())
        self.assertNotIn("private-overflow", output.getvalue())

    def test_summary_counts_distinct_concurrent_omitted_wait_batches(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())

        for prefix in ("first", "second"):
            reporter.process_line(
                json.dumps(
                    {
                        "type": "item.started",
                        "item": {
                            "id": f"wait-{prefix}",
                            "type": "collab_tool_call",
                            "tool": "wait",
                            "receiver_thread_ids": [
                                f"private-{prefix}-{index}" for index in range(10)
                            ]
                        },
                    }
                )
            )
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn(
            "Summary: events=2 tool calls=2 subagents=20", rendered
        )
        self.assertNotIn("private-", rendered)

    def test_reordered_repeat_wait_does_not_double_count_promoted_ids(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())
        raw_ids = [f"private-reordered-{index}" for index in range(10)]

        for call_id, receiver_ids in (
            ("wait-forward", raw_ids),
            ("wait-reverse", list(reversed(raw_ids))),
        ):
            reporter.process_line(
                json.dumps(
                    {
                        "type": "item.started",
                        "item": {
                            "id": call_id,
                            "type": "collab_tool_call",
                            "tool": "wait",
                            "receiver_thread_ids": receiver_ids,
                        },
                    }
                )
            )
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn(
            "Summary: events=2 tool calls=2 subagents=10", rendered
        )
        self.assertNotIn("private-", rendered)

    def test_partially_overlapping_omitted_wait_batches_count_distinct_workers(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())

        for call_id, receiver_ids in (
            ("wait-first", [f"private-overlap-{index}" for index in range(10)]),
            (
                "wait-second",
                [f"private-overlap-{index}" for index in range(9)]
                + ["private-overlap-10"],
            ),
        ):
            reporter.process_line(
                json.dumps(
                    {
                        "type": "item.started",
                        "item": {
                            "id": call_id,
                            "type": "collab_tool_call",
                            "tool": "wait",
                            "receiver_thread_ids": receiver_ids,
                        },
                    }
                )
            )
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn("Summary: events=2 tool calls=2 subagents=11", rendered)
        self.assertNotIn("private-", rendered)

    def test_duplicate_wait_completion_does_not_replay_worker_lifecycle(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())
        raw_ids = [f"private-duplicate-{index}" for index in range(10)]
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": "duplicate-wait",
                        "type": "collab_tool_call",
                        "tool": "wait",
                        "receiver_thread_ids": raw_ids,
                    },
                }
            )
        )
        completion = json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "duplicate-wait",
                    "type": "collab_tool_call",
                    "tool": "wait",
                    "agents_states": {
                        raw_id: {"status": "completed"} for raw_id in raw_ids
                    },
                },
            }
        )
        reporter.process_line(completion)
        reporter.process_line(completion)
        reporter.finish()

        rendered = output.getvalue()
        self.assertEqual(rendered.count("Subagent joined id="), 8)
        self.assertEqual(rendered.count("Subagent joined +2 more"), 1)
        self.assertEqual(rendered.count("Duplicate completion ignored"), 1)
        self.assertIn(
            "Summary: events=3 tool calls=1 subagents=10", rendered
        )
        self.assertNotIn("private-", rendered)

    def test_completed_call_evictions_preserve_active_subagent_snapshot(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)

        reporter.process_line(
            json.dumps(
                {
                    "type": "thread.started",
                    "thread_id": "private-target",
                    "parent_thread_id": "root",
                    "model": "gpt-5.6-luna",
                    "reasoning_effort": "high",
                }
            )
        )

        for index in range(progress_reporter.MAX_CORRELATIONS + 32):
            event = {
                "item": {
                    "id": f"completed-call-{index}",
                    "type": "command_execution",
                    "command": "git status",
                }
            }
            reporter.process_line(json.dumps({"type": "item.started", **event}))
            reporter.process_line(json.dumps({"type": "item.completed", **event}))

        self.assertEqual(len(reporter.correlation_fifo), 256)
        target_id = progress_reporter.opaque_id("private-target")
        self.assertIn(("subagent", target_id), reporter.correlation_fifo)
        self.assertNotIn(
            progress_reporter.opaque_id("completed-call-0"),
            reporter.completed_call_ids,
        )

        clock.advance(5)
        reporter.process_line(
            json.dumps(
                {
                    "type": "thread.completed",
                    "thread_id": "private-target",
                }
            )
        )

        self.assertIn(
            "[00m05s] Subagent joined id=subagent-1 "
            "model=gpt-5.6-luna effort=high duration=5.0s",
            output.getvalue().splitlines(),
        )
        self.assertLessEqual(len(reporter.correlation_fifo), 256)
        self.assertNotIn("private-target", output.getvalue())

    def test_long_raw_ids_have_bounded_retained_state(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(
            output=output, clock=ManualClock()
        )
        raw_ids = [
            f"credential-shaped-{index}:" + "x" * 16_384
            for index in range(progress_reporter.MAX_CORRELATIONS + 1)
        ]

        for raw_id in raw_ids:
            reporter.process_line(
                json.dumps(
                    {
                        "type": "item.started",
                        "item": {
                            "id": raw_id,
                            "type": "command_execution",
                            "command": "git status",
                        },
                    }
                )
            )

        first_id = progress_reporter.opaque_id(raw_ids[0])
        last_id = progress_reporter.opaque_id(raw_ids[-1])
        large_integer_id = progress_reporter.opaque_id(10**1000)
        surrogate_id_a = progress_reporter.opaque_id("x" * 257 + "\ud800")
        surrogate_id_b = progress_reporter.opaque_id("x" * 257 + "\ud801")
        self.assertEqual(first_id[0], "string-sha256")
        self.assertEqual(len(first_id[1]), 64)
        self.assertEqual(large_integer_id[0], "integer-sha256")
        self.assertEqual(len(large_integer_id[1]), 64)
        self.assertNotEqual(surrogate_id_a, surrogate_id_b)
        self.assertNotIn(first_id, reporter.pending_calls)
        self.assertIn(last_id, reporter.pending_calls)
        self.assertEqual(
            len(reporter.correlation_fifo), progress_reporter.MAX_CORRELATIONS
        )
        self.assertTrue(
            all(
                not isinstance(raw_id[1], str)
                or len(raw_id[1]) <= progress_reporter.MAX_RAW_ID_CHARS
                for _, raw_id in reporter.correlation_fifo
            )
        )
        self.assertNotIn("credential-shaped", output.getvalue())

    def test_legacy_envelope_and_collab_events_are_supported(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        reporter.process_line(
            json.dumps(
                {
                    "params": {
                        "msg": {
                            "type": "token_count",
                            "info": {"total_token_usage": {"total_tokens": 60000}},
                        }
                    }
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_agent_spawn_begin",
                        "call_id": "spawn-legacy",
                        "model": "gpt-5.6-luna",
                        "reasoning_effort": "high",
                    }
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_agent_spawn_end",
                        "call_id": "spawn-legacy",
                        "new_thread_id": "sub-legacy",
                        "nickname": "legacy-worker",
                    }
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_waiting_begin",
                        "call_id": "wait-legacy",
                        "receiver_thread_ids": ["sub-legacy"],
                    }
                }
            )
        )
        clock.advance(1)
        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_waiting_end",
                        "call_id": "wait-legacy",
                        "agent_statuses": [
                            {
                                "thread_id": "sub-legacy",
                                "agent_nickname": "legacy-worker",
                                "agent_role": "private-role",
                                "status": {"completed": None},
                            }
                        ],
                    }
                }
            )
        )
        reporter.process_line(json.dumps({"msg": {"type": "task_complete"}}))
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn("Tokens +60,000 total=60,000", rendered)
        self.assertIn(
            "Subagent spawn completed id=subagent-1 model=gpt-5.6-luna effort=high count=1 duration=2.0s",
            rendered,
        )
        self.assertIn(
            "Subagent joined id=subagent-1 model=gpt-5.6-luna effort=high duration=3.0s",
            rendered,
        )
        self.assertNotIn("label=", rendered)
        self.assertNotIn("legacy-worker", rendered)
        self.assertNotIn("sub-legacy", rendered)
        self.assertIn("task_complete", rendered)
        self.assertIn("Summary: events=6 tool calls=2 subagents=1", rendered)

    def test_legacy_wait_failure_is_correlated_before_state_is_cleared(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)

        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_agent_spawn_begin",
                        "call_id": "legacy-failed-spawn",
                        "model": "composer-2.5",
                        "reasoning_effort": "medium",
                    }
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_agent_spawn_end",
                        "call_id": "legacy-failed-spawn",
                        "new_thread_id": "private-failed-worker",
                    }
                }
            )
        )
        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_waiting_begin",
                        "call_id": "legacy-failed-wait",
                        "receiver_thread_ids": ["private-failed-worker"],
                    }
                }
            )
        )
        clock.advance(4)
        reporter.process_line(
            json.dumps(
                {
                    "msg": {
                        "type": "collab_waiting_end",
                        "call_id": "legacy-failed-wait",
                        "agent_statuses": [
                            {
                                "thread_id": "private-failed-worker",
                                "status": {
                                    "errored": "ghp_abcdefghijklmnopqrstuvwxyz123456"
                                },
                            }
                        ],
                    }
                }
            )
        )

        rendered = output.getvalue()
        self.assertIn(
            "Subagent failed id=subagent-1 model=composer-2.5 "
            "effort=medium duration=4.0s",
            rendered,
        )
        self.assertNotIn("failed=", rendered)
        self.assertNotIn("private-failed-worker", rendered)
        self.assertNotIn("ghp_", rendered)
        self.assertNotIn(
            progress_reporter.opaque_id("private-failed-worker"),
            reporter.subagent_local_ids,
        )

    def test_call_durations_use_ids_and_ignore_duplicate_completions(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        for call_id in ("call-a", "call-b"):
            reporter.process_line(
                json.dumps(
                    {
                        "type": "item.started",
                        "item": {
                            "id": call_id,
                            "type": "command_execution",
                            "command": "same-command",
                        },
                    }
                )
            )
        clock.advance(2)
        reporter.process_line(
            '{"type":"item.completed","item":{"id":"call-b","type":"command_execution","command":"same-command"}}'
        )
        clock.advance(1)
        reporter.process_line(
            '{"type":"item.completed","item":{"id":"call-a","type":"command_execution","command":"same-command"}}'
        )
        reporter.process_line(
            '{"type":"item.completed","item":{"id":"call-a","type":"command_execution","command":"same-command"}}'
        )
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn("duration=2.0s", rendered)
        self.assertIn("duration=3.0s", rendered)
        self.assertIn("Summary: events=5 tool calls=2", rendered)

    def test_cli_writes_only_stderr_and_never_echoes_input(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH)],
            input=FIXTURE_PATH.read_text(),
            capture_output=True,
            text=True,
            check=True,
        )

        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.startswith("["))
        self.assertNotIn("SENSITIVE", result.stderr)
        self.assertIn("Summary: events=16", result.stderr)

    def test_hostile_scalar_fields_never_reach_hosted_output(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH)],
            input=HOSTILE_FIXTURE_PATH.read_text(),
            capture_output=True,
            text=True,
            check=True,
        )

        self.assertEqual(result.stdout, "")
        for forbidden in (
            "HOSTILE_ARGUMENT_SENTINEL",
            "HOSTILE_QUERY_SENTINEL",
            "HOSTILE_LABEL_SENTINEL",
            "HOSTILE_MODEL_SENTINEL",
            "HOSTILE_EFFORT_SENTINEL",
            "HOSTILE_TOOL_SENTINEL",
            "HOSTILE_SERVER_SENTINEL",
            "HOSTILE_STATUS_SENTINEL",
            "HOSTILE_EVENT_SENTINEL",
            "oauth.token",
            "gpt-deadbeefcafebabefeedface01234567",
            "claude-deadbeefcafebabefeedface01234567",
            "composer-deadbeefcafebabefeedface01234567",
            "o-token",
            "12345678",
            "9182736455463728192837465",
            "9876543210987654321098765",
            "112233445566778899001122",
            "hostile-subagent",
            "eyJhbGciOiJIUzI1NiJ9.eyJjcmVkZW50aWFsIjoic2VjcmV0In0.signature123",
            "ghp_abcdefghijklmnopqrstuvwxyz123456",
        ):
            self.assertNotIn(forbidden, result.stderr)
        self.assertIn("Command started: git", result.stderr)
        self.assertIn(
            "Command completed: git duration=invalid status=unknown exit=invalid",
            result.stderr,
        )
        self.assertIn("Tool started: web_search", result.stderr)
        self.assertIn("Tool started: mcp", result.stderr)
        self.assertIn("Tool started: unknown", result.stderr)
        self.assertIn("Subagent spawned id=subagent-1 count=1", result.stderr)
        self.assertIn(
            "Subagent joined id=subagent-1 duration=0.0s",
            result.stderr,
        )
        self.assertIn(
            "Tool completed: web_search duration=invalid status=completed",
            result.stderr,
        )
        self.assertIn("Tokens total=invalid", result.stderr)
        self.assertIn("tokens=invalid", result.stderr.splitlines()[-1])
        self.assertNotIn("model=", result.stderr)
        self.assertIn("Subagent spawned id=subagent-2 effort=high count=1", result.stderr)
        self.assertNotIn("label=", result.stderr)
        self.assertIn("Unknown event", result.stderr)

    def test_numeric_fields_respect_domain_boundaries(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())

        for index, exit_code in enumerate((-128, 255, -129, 256)):
            reporter.process_line(
                json.dumps(
                    {
                        "type": "item.completed",
                        "item": {
                            "id": f"exit-{index}",
                            "type": "command_execution",
                            "command": "git status",
                            "exit_code": exit_code,
                        },
                    }
                )
            )
        reporter.process_line(
            '{"type":"item.completed","item":{"id":"duration-valid","type":"web_search","duration_ms":86399999}}'
        )
        reporter.process_line(
            '{"type":"item.completed","item":{"id":"duration-invalid","type":"web_search","duration_ms":86400000}}'
        )
        reporter.process_line(
            '{"type":"token_count","info":{"total_token_usage":{"total_tokens":99999999999}}}'
        )
        reporter.process_line(
            '{"type":"token_count","info":{"total_token_usage":{"total_tokens":100000000000}}}'
        )
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn("exit=-128", rendered)
        self.assertIn("exit=255", rendered)
        self.assertEqual(rendered.count("exit=invalid"), 2)
        self.assertIn("duration=1439m59s", rendered)
        self.assertIn("duration=invalid", rendered)
        self.assertIn("Tokens +99,999,999,999 total=99,999,999,999", rendered)
        self.assertIn("Tokens total=invalid", rendered)
        self.assertIn("tokens=invalid", rendered.splitlines()[-1])

    def test_subagent_metadata_uses_exact_owned_allowlists(self):
        self.assertEqual(
            progress_reporter.FLEET_MODELS,
            {
                "gpt-6-astra",
                "gpt-6-sol",
                "gpt-6-luna",
                "gpt-5.6-sol",
                "gpt-5.6-luna",
                "gpt-5.5",
                "composer-2.5",
            },
        )
        for model in progress_reporter.FLEET_MODELS:
            source_value = "".join((model[:-1], model[-1]))
            canonical = progress_reporter.safe_model(source_value)
            self.assertEqual(canonical, model)
            self.assertTrue(
                any(canonical is fleet_model for fleet_model in progress_reporter.FLEET_MODELS)
            )
        for model in (
            "GPT-5.6-LUNA",
            "hostile.model",
            "oauth.token",
            "gpt-5.6-luna password=12345678",
            "gpt-5/6",
            "gpt-deadbeefcafebabefeedface01234567",
            "claude-deadbeefcafebabefeedface01234567",
            "composer-deadbeefcafebabefeedface01234567",
            "o-token",
        ):
            self.assertIsNone(progress_reporter.safe_model(model))

        for effort in ("none", "minimal", "low", "medium", "high", "xhigh"):
            self.assertEqual(progress_reporter.safe_effort(effort), effort)
        for effort in ("HIGH", "max", "high password=12345678", ""):
            self.assertIsNone(progress_reporter.safe_effort(effort))

        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())
        reporter.process_line(
            '{"type":"agent.subagent.started","subagent":{"id":"partial-a","model":"hostile.model","reasoning_effort":"high","label":"drop-me"}}'
        )
        reporter.process_line(
            '{"type":"agent.subagent.started","subagent":{"id":"partial-b","model":"composer-2.5","reasoning_effort":"max","label":"drop-me"}}'
        )

        rendered = output.getvalue()
        self.assertIn(
            "Subagent spawned id=subagent-1 effort=high count=1", rendered
        )
        self.assertIn(
            "Subagent spawned id=subagent-2 model=composer-2.5 count=1",
            rendered,
        )
        self.assertNotIn("hostile.model", rendered)
        self.assertNotIn("effort=max", rendered)
        self.assertNotIn("label=", rendered)
        self.assertNotIn("drop-me", rendered)

        thread_output = io.StringIO()
        thread_reporter = progress_reporter.ProgressReporter(
            output=thread_output, clock=ManualClock()
        )
        thread_reporter.process_line(
            '{"type":"thread.started","thread_id":"thread-child","parent_thread_id":"root","model":"gpt-5.5","reasoning_effort":"low","label":"thread-label"}'
        )
        thread_reporter.process_line(
            '{"type":"thread.completed","thread_id":"thread-child","label":"thread-join-label"}'
        )
        thread_rendered = thread_output.getvalue()
        self.assertIn(
            "Subagent spawned id=subagent-1 model=gpt-5.5 effort=low count=1",
            thread_rendered,
        )
        self.assertIn(
            "Subagent joined id=subagent-1 model=gpt-5.5 effort=low duration=0.0s",
            thread_rendered,
        )
        self.assertNotIn("thread-label", thread_rendered)
        self.assertNotIn("thread-join-label", thread_rendered)
        self.assertNotIn("thread-child", thread_rendered)

    def test_opaque_ids_do_not_cross_wire_durations_or_subagent_metadata(self):
        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        call_ids = ("password=first-secret", "password=second-secret")
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": call_ids[0],
                        "type": "command_execution",
                        "command": "git status",
                    },
                }
            )
        )
        clock.advance(1)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.started",
                    "item": {
                        "id": call_ids[1],
                        "type": "command_execution",
                        "command": "git status",
                    },
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": call_ids[1],
                        "type": "command_execution",
                        "command": "git status",
                    },
                }
            )
        )
        clock.advance(2)
        reporter.process_line(
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "id": call_ids[0],
                        "type": "command_execution",
                        "command": "git status",
                    },
                }
            )
        )

        reporter.process_line(
            '{"type":"agent.subagent.started","subagent":{"id":"token=first-secret","model":"gpt-5.6-luna","reasoning_effort":"high"}}'
        )
        reporter.process_line(
            '{"type":"agent.subagent.started","subagent":{"id":"token=second-secret","model":"composer-2.5","reasoning_effort":"low"}}'
        )
        reporter.process_line(
            '{"type":"agent.subagent.completed","subagent":{"id":"token=first-secret"}}'
        )
        reporter.process_line(
            '{"type":"agent.subagent.completed","subagent":{"id":"token=second-secret"}}'
        )
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn("duration=2.0s", rendered)
        self.assertIn("duration=5.0s", rendered)
        self.assertIn(
            "Subagent joined id=subagent-1 model=gpt-5.6-luna effort=high duration=0.0s",
            rendered,
        )
        self.assertIn(
            "Subagent joined id=subagent-2 model=composer-2.5 effort=low duration=0.0s",
            rendered,
        )
        self.assertIn("Summary: events=8 tool calls=2 subagents=2", rendered)
        for opaque_id in (*call_ids, "token=first-secret", "token=second-secret"):
            self.assertNotIn(opaque_id, rendered)

    def test_typed_and_generated_ids_use_distinct_correlation_namespaces(self):
        self.assertNotEqual(
            progress_reporter.opaque_id(1), progress_reporter.opaque_id("1")
        )
        for unsupported_id in (0.0, -0.0, float("nan"), float("inf")):
            self.assertIsNone(progress_reporter.opaque_id(unsupported_id))

        clock = ManualClock()
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        missing_id = object()

        def process_command(phase, call_id=missing_id):
            item = {
                "type": "command_execution",
                "command": "git status",
            }
            if call_id is not missing_id:
                item["id"] = call_id
            reporter.process_line(
                json.dumps({"type": f"item.{phase}", "item": item})
            )

        process_command("started", 1)
        clock.advance(1)
        process_command("started", "1")
        clock.advance(2)
        process_command("completed", "1")
        clock.advance(2)
        process_command("completed", 1)

        reporter.process_line(
            '{"type":"agent.subagent.started","subagent":{"id":2,"model":"gpt-5.6-luna","reasoning_effort":"high"}}'
        )
        reporter.process_line(
            '{"type":"agent.subagent.started","subagent":{"id":"2","model":"composer-2.5","reasoning_effort":"low"}}'
        )
        reporter.process_line(
            '{"type":"agent.subagent.completed","subagent":{"id":2}}'
        )
        reporter.process_line(
            '{"type":"agent.subagent.completed","subagent":{"id":"2"}}'
        )

        process_command("started", "call-1")
        process_command("started")
        reporter.finish()

        rendered = output.getvalue()
        self.assertIn("duration=2.0s", rendered)
        self.assertIn("duration=5.0s", rendered)
        self.assertIn(
            "Subagent joined id=subagent-1 model=gpt-5.6-luna effort=high duration=0.0s",
            rendered,
        )
        self.assertIn(
            "Subagent joined id=subagent-2 model=composer-2.5 effort=low duration=0.0s",
            rendered,
        )
        self.assertIn("Summary: events=10 tool calls=4 subagents=2", rendered)
        self.assertNotIn("call-1", rendered)

    def test_review_callers_use_fail_open_synchronous_reporter_pipelines(self):
        workflow = CODE_REVIEW_WORKFLOW_PATH.read_text()
        run_local = RUN_LOCAL_PATH.read_text()
        normalized_workflow = " ".join(workflow.split())
        normalized_local = " ".join(run_local.split())

        self.assertIn(
            'exec 9> >(python3 -u "$ENGINE_DIR/'
            'progress-reporter.py" >&2) REPORTER_PID=$!',
            normalized_workflow,
        )
        self.assertIn(
            "drain_progress_pipe() { if cat >&9 2>/dev/null; then "
            "return 0 fi cat >/dev/null }",
            normalized_workflow,
        )
        # The workflow drains through the SAME pipe on every attempt: the codex
        # invocation lives in `run_codex_attempt`, whose raw-log sink is the
        # attempt's own file, and the single reporter spans the whole step.
        self.assertIn(
            '9>&- 2>&1 | tee "$raw_log" '
            ">(drain_progress_pipe) >/dev/null",
            normalized_workflow,
        )
        self.assertIn(
            'ATTEMPT_RAW_LOG="$REVIEW_TMP/codex-output-attempt-${ATTEMPT}.json"',
            normalized_workflow,
        )
        self.assertIn(
            'run_codex_attempt "$ATTEMPT_RAW_LOG" "$ATTEMPT_BUDGET"',
            normalized_workflow,
        )
        self.assertIn(
            'CODEX_PIPE_STATUSES=("${PIPESTATUS[@]}") set -e '
            'CODEX_EXIT_CODE="${CODEX_PIPE_STATUSES[0]}"',
            normalized_workflow,
        )
        self.assertIn('exec 9>&- if ! wait "$REPORTER_PID"', normalized_workflow)
        self.assertIn(
            'exec 9> >(python3 -u "$ENGINE_DIR/'
            'progress-reporter.py" 2>&1 | tee "$PROGRESS_LOG" >&2) '
            "REPORTER_PID=$!",
            normalized_local,
        )
        self.assertIn(
            "drain_progress_pipe() { if cat >&9 2>/dev/null; then "
            "return 0 fi cat >/dev/null }",
            normalized_local,
        )
        self.assertIn(
            '9>&- 2>&1 | tee "$CODEX_LOG" >(drain_progress_pipe)',
            normalized_local,
        )
        self.assertIn(
            '9>&- 2>&1 | tee "$CODEX_LOG" '
            '>(drain_progress_pipe) >/dev/null',
            normalized_local,
        )
        self.assertEqual(
            normalized_local.count(
                'CODEX_PIPE_STATUSES=("${PIPESTATUS[@]}")'
            ),
            2,
        )
        self.assertIn(
            'CODEX_EXIT_CODE="${CODEX_PIPE_STATUSES[0]}"', normalized_local
        )
        self.assertIn('exec 9>&- wait "$REPORTER_PID"', normalized_local)

        # Raw-log sink status handling must exist in BOTH real callers so a
        # tee failure surfaces as degraded observability instead of silence.
        self.assertIn(
            'RAW_LOG_STATUS="${CODEX_PIPE_STATUSES[1]:-0}"',
            normalized_workflow,
        )
        # Each attempt records its own sink failure; the step output is written
        # once, after the loop, so a first-attempt degradation is not lost and
        # the key is not emitted twice.
        self.assertIn(
            'RAW_LOG_DEGRADED=true fi return 0 }',
            normalized_workflow,
        )
        self.assertIn(
            'if [ "$RAW_LOG_DEGRADED" = "true" ]; then '
            'echo "raw_log_degraded=true" >> "$GITHUB_OUTPUT" fi',
            normalized_workflow,
        )
        self.assertIn(
            "Raw review log sink failed (tee exit $RAW_LOG_STATUS)",
            normalized_workflow,
        )
        self.assertIn(
            'RAW_LOG_STATUS="${CODEX_PIPE_STATUSES[1]:-0}"',
            normalized_local,
        )
        self.assertIn(
            "raw review log sink failed (tee exit $RAW_LOG_STATUS)",
            normalized_local,
        )
        # The warning must be CONDITIONAL on the captured tee status in both
        # callers, not merely present somewhere in the file.
        self.assertIn(
            'if [ "$RAW_LOG_STATUS" != "0" ]; then echo '
            '"::warning::Raw review log sink failed (tee exit $RAW_LOG_STATUS)',
            normalized_workflow,
        )
        self.assertIn(
            'if [ "$RAW_LOG_STATUS" != "0" ]; then echo '
            '"Warning: raw review log sink failed (tee exit $RAW_LOG_STATUS)',
            normalized_local,
        )

    def test_workflow_codex_retry_is_bounded_and_always_a_fresh_session(self):
        """The Run Codex retry loop, pinned where it can silently go wrong.

        A retry that is unbounded, that resumes the failed session, that
        inherits the previous attempt's artifact, or that fires on a genuine
        review failure would each be invisible in a green CI run.
        """
        normalized = " ".join(CODE_REVIEW_WORKFLOW_PATH.read_text().split())

        # Bounded: at most two attempts, sharing the one 20m model budget, and
        # never a retry with too little of it left to finish a review.
        self.assertIn(
            "CODEX_BUDGET_SECONDS=$(( REVIEW_BUDGET_MINUTES * 60 )) MIN_RETRY_SECONDS=300 MAX_ATTEMPTS=2",
            normalized,
        )
        self.assertIn(
            "ATTEMPT_BUDGET=$(( CODEX_BUDGET_SECONDS - ($(date +%s) - START_TIME) ))",
            normalized,
        )

        self.assertIn("REVIEW_BUDGET_MINUTES: ${{ inputs.review-budget-minutes }}", CODE_REVIEW_WORKFLOW_PATH.read_text())
        self.assertIn('default: "20"', CODE_REVIEW_WORKFLOW_PATH.read_text().split("  review-budget-minutes:", 1)[1].split("  pr-number:", 1)[0])

        self.assertIn(
            'timeout --kill-after=60s "${budget_seconds}s" codex '
            '"${CODEX_MODE_ARGS[@]}"',
            normalized,
        )
        # `timeout 0` means "no limit" in coreutils: an exhausted budget must
        # never turn the final attempt into an unbounded one.
        self.assertIn(
            'if [ "$ATTEMPT_BUDGET" -lt 60 ]; then ATTEMPT_BUDGET=60 fi',
            normalized,
        )
        self.assertIn(
            'if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ] '
            '|| [ "${ATTEMPT_CLASSIFICATION%%:*}" != "retryable" ] '
            '|| [ "$REMAINING" -lt "$MIN_RETRY_SECONDS" ]; then break fi',
            normalized,
        )

        # Every attempt is judged on its own artifact: the output file is
        # removed at the top of each iteration, before the attempt runs.
        self.assertIn(
            "while true; do ATTEMPT=$((ATTEMPT + 1)) "
            'ATTEMPT_RAW_LOG="$REVIEW_TMP/codex-output-attempt-${ATTEMPT}.json"',
            normalized,
        )
        self.assertIn(
            "rm -f .codex-ci/codex-review-output.json ATTEMPT_BUDGET=",
            normalized,
        )

        # The retry mints a NEW codex session id. Resuming would rebuild the
        # same session state under the same provider sticky key, which is the
        # state the retryable classifications say has failed.
        self.assertIn(
            'preserve_attempt_sessions "$ATTEMPT" '
            'CODEX_MODE_ARGS=("${CODEX_COLD_MODE_ARGS[@]}") '
            'FINAL_SESSION_MODE="cold_retry" '
            "RETRY_COUNT=$((RETRY_COUNT + 1))",
            normalized,
        )
        # A resumed round that fell back cold must report itself truthfully.
        self.assertIn(
            'echo "final_session_mode=${FINAL_SESSION_MODE:-as_resolved}" >> "$GITHUB_OUTPUT"',
            normalized,
        )
        self.assertEqual(
            normalized.count('exec resume "$RESUME_SESSION_ID"'),
            1,
            "`exec resume` may appear only where the first attempt's mode is "
            "chosen — never on the retry path",
        )

        # Classification: only infrastructure failures a fresh session can
        # clear are retryable. A timeout, a missing artifact, and anything
        # unrecognised are this review's real result.
        self.assertIn(
            "grep -qE 'Invalid `previous_response_id`"
            "|previous_response_owner_unavailable'",
            normalized,
        )
        self.assertIn('echo "retryable:previous_response_id"', normalized)
        self.assertIn("grep -qF 'Selected model is at capacity'", normalized)
        self.assertIn('echo "retryable:model_at_capacity"', normalized)
        self.assertIn(
            '[ "$last_event" = \'"type":"turn.failed"\' ] && grep -qE',
            normalized,
        )
        self.assertIn('echo "retryable:stream_error"', normalized)
        self.assertIn(
            'if [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 137 ]; then '
            'echo "fatal:budget_timeout"',
            normalized,
        )
        self.assertIn(
            'if [ "$exit_code" -eq 0 ]; then echo "fatal:no_review_artifact"',
            normalized,
        )
        self.assertIn('echo "fatal:unclassified"', normalized)

        # A failed attempt's raw error text must reach the job log; today a
        # failure reads as a bare "exited with code 1".
        self.assertIn('report_attempt_failure_tail "$ATTEMPT_RAW_LOG"', normalized)
        self.assertIn(
            'tail -n 20 "$raw_log" 2>/dev/null \\ '
            '| python3 "$ENGINE_DIR/sanitize-failure-tail.py" \\ '
            '|| echo "(raw log unreadable)"',
            normalized,
        )
        self.assertIn(
            'echo "codex attempt $ATTEMPT: review produced [success]"',
            normalized,
        )
        self.assertIn(
            'echo "codex attempt $ATTEMPT: failed exit=$CODEX_EXIT_CODE '
            '[$ATTEMPT_CLASSIFICATION]"',
            normalized,
        )
        self.assertIn('echo "retry_count=$RETRY_COUNT" >> "$GITHUB_OUTPUT"', normalized)
        self.assertIn('echo "final_attempt=$ATTEMPT" >> "$GITHUB_OUTPUT"', normalized)

        # Downstream steps read the legacy path, which must carry the FINAL
        # attempt's stream.
        self.assertIn(
            'if ! cp "$ATTEMPT_RAW_LOG" "$REVIEW_TMP/codex-output.json"; then',
            normalized,
        )

        # A discarded attempt's rollouts leave the tree `rollout-usage.cjs`
        # sums, so the round's totals describe the review that was posted —
        # while the discarded spend stays visible and uploadable.
        self.assertIn(
            'PRESERVED_SESSIONS_DIR="${CODEX_HOME:-$RUNNER_TEMP}'
            '/failed-attempt-sessions"',
            normalized,
        )
        self.assertIn(
            'find "$CODEX_HOME/sessions" -mindepth 1 -maxdepth 1 '
            '-exec mv {} "$dest/" \\;',
            normalized,
        )
        self.assertIn(
            'rollout-usage.cjs" "$PRESERVED_SESSIONS_DIR"',
            normalized,
        )
        self.assertIn("${{ runner.temp }}/open-review/codex-output-attempt-*.json", normalized)
        self.assertIn(
            "${{ env.CODEX_HOME }}/failed-attempt-sessions/",
            normalized,
        )

    def test_raw_log_sink_failure_preserves_producer_status(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_dir = Path(directory)
            events_path = temp_dir / "events.jsonl"
            events_path.write_text('{"type":"task_complete"}\n' * 4)
            unwritable_raw_log = temp_dir / "missing-dir" / "raw.jsonl"
            progress_log = temp_dir / "progress.log"
            shell_script = """
set +e
set -o pipefail
drain_progress_pipe() {
  if cat >&9 2>/dev/null; then
    return 0
  fi
  cat >/dev/null
}
exec 9> >(python3 -u "$3" 2>&1 | tee "$4" >&2)
reporter_pid=$!
(cat "$2"; exit 23) 9>&- 2>/dev/null | tee "$1" >(drain_progress_pipe) >/dev/null 2>/dev/null
pipeline_status=("${PIPESTATUS[@]}")
producer_status="${pipeline_status[0]}"
raw_log_status="${pipeline_status[1]:-0}"
exec 9>&-
wait "$reporter_pid"
if [ "$raw_log_status" != "0" ]; then
  echo "raw-log-degraded" >&2
fi
exit "$producer_status"
"""
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    shell_script,
                    "bash",
                    str(unwritable_raw_log),
                    str(events_path),
                    str(SCRIPT_PATH),
                    str(progress_log),
                ],
                capture_output=True,
                text=True,
            )

            # The producer's own status survives the failed raw-log sink, and
            # the degraded sink is surfaced instead of silently ignored.
            self.assertEqual(result.returncode, 23)
            self.assertIn("raw-log-degraded", result.stderr)

    def test_synchronous_shell_pipeline_returns_after_summary_is_flushed(self):
        event_count = progress_reporter.MAX_QUEUED_EVENTS * 4
        with tempfile.TemporaryDirectory() as directory:
            temp_dir = Path(directory)
            events_path = temp_dir / "events.jsonl"
            events_path.write_text('{"type":"task_complete"}\n' * event_count)
            for stream_raw in (False, True):
                suffix = "raw" if stream_raw else "hosted"
                raw_log = temp_dir / f"{suffix}-raw.jsonl"
                progress_log = temp_dir / f"{suffix}-progress.log"
                visible_output = temp_dir / f"{suffix}-stdout.log"
                tee_stage = 'tee "$1" >(drain_progress_pipe)'
                if not stream_raw:
                    tee_stage += " >/dev/null"
                shell_script = f"""
set +e
set -o pipefail
drain_progress_pipe() {{
  if cat >&9 2>/dev/null; then
    return 0
  fi
  cat >/dev/null
}}
exec >"$5"
printf 'before\\n'
exec 9> >(python3 -u "$3" 2>&1 | tee "$4" >&2)
reporter_pid=$!
(cat "$2"; sleep 3 >/dev/null 2>&1 & exit 23) 9>&- | {tee_stage}
pipeline_status=("${{PIPESTATUS[@]}}")
producer_status="${{pipeline_status[0]}}"
exec 9>&-
wait "$reporter_pid"
reporter_status=$?
printf 'after\\n'
if [ "$reporter_status" -ne 0 ]; then
  exit "$reporter_status"
fi
exit "$producer_status"
"""
                started_at = time.monotonic()
                result = subprocess.run(
                    [
                        "bash",
                        "-c",
                        shell_script,
                        "bash",
                        str(raw_log),
                        str(events_path),
                        str(SCRIPT_PATH),
                        str(progress_log),
                        str(visible_output),
                    ],
                    capture_output=True,
                    text=True,
                )
                elapsed = time.monotonic() - started_at

                self.assertEqual(result.returncode, 23)
                self.assertLess(elapsed, 1.5)
                self.assertEqual(raw_log.read_text(), events_path.read_text())
                self.assertIn(
                    f"Summary: events={event_count}",
                    progress_log.read_text().splitlines()[-1],
                )
                self.assertIn(
                    f"Summary: events={event_count}",
                    result.stderr.splitlines()[-1],
                )
                expected_visible = "before\n"
                if stream_raw:
                    expected_visible += events_path.read_text()
                expected_visible += "after\n"
                self.assertEqual(visible_output.read_text(), expected_visible)

    def test_shell_pipeline_preserves_producer_and_raw_log_when_reporter_exits_early(self):
        with tempfile.TemporaryDirectory() as directory:
            temp_dir = Path(directory)
            events_path = temp_dir / "events.jsonl"
            events_path.write_text(
                '{"type":"task_complete","padding":"' + "x" * 512 + '"}\n'
            )
            events_path.write_text(events_path.read_text() * 4096)
            producer_path = temp_dir / "producer.py"
            producer_path.write_text(
                "import os\n"
                "import sys\n"
                "payload = open(sys.argv[1], 'rb').read()\n"
                "for offset in range(0, len(payload), 4096):\n"
                "    os.write(1, payload[offset:offset + 4096])\n"
                "raise SystemExit(23)\n"
            )
            reporter_path = temp_dir / "reporter.sh"
            reporter_path.write_text("#!/usr/bin/env bash\nexit 42\n")

            for stream_raw in (False, True):
                suffix = "raw" if stream_raw else "hosted"
                raw_log = temp_dir / f"{suffix}-early-exit.jsonl"
                visible_output = temp_dir / f"{suffix}-early-exit.stdout"
                tee_stage = 'tee "$1" >(drain_progress_pipe)'
                if not stream_raw:
                    tee_stage += " >/dev/null"
                shell_script = f"""
set +e
set -o pipefail
drain_progress_pipe() {{
  if cat >&9 2>/dev/null; then
    return 0
  fi
  cat >/dev/null
}}
exec >"$5"
exec 9> >(bash "$4")
reporter_pid=$!
python3 "$2" "$3" 9>&- | {tee_stage}
pipeline_status=("${{PIPESTATUS[@]}}")
producer_status="${{pipeline_status[0]}}"
exec 9>&-
wait "$reporter_pid"
exit "$producer_status"
"""
                result = subprocess.run(
                    [
                        "bash",
                        "-c",
                        shell_script,
                        "bash",
                        str(raw_log),
                        str(producer_path),
                        str(events_path),
                        str(reporter_path),
                        str(visible_output),
                    ],
                    capture_output=True,
                    text=True,
                )

                self.assertEqual(result.returncode, 23)
                self.assertEqual(raw_log.read_bytes(), events_path.read_bytes())
                expected_visible = events_path.read_text() if stream_raw else ""
                self.assertEqual(visible_output.read_text(), expected_visible)

    def test_shorten_bounds_and_redacts_payload_metadata(self):
        self.assertEqual(progress_reporter.safe_command("git diff --stat"), "git")
        self.assertEqual(
            progress_reporter.safe_command("/bin/bash -lc 'git diff --stat'"),
            "git",
        )
        self.assertEqual(
            progress_reporter.safe_command("/bin/sh -c 'rg safe_command file.py'"),
            "rg",
        )
        self.assertEqual(
            progress_reporter.safe_command(
                "env REVIEW_MODE=hosted bash -lc 'sed -n 1,20p file.py'"
            ),
            "sed",
        )
        self.assertEqual(
            progress_reporter.safe_command(
                "env TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 "
                "bash -lc 'unknown-secret-tool password=12345678'"
            ),
            "unknown",
        )
        self.assertEqual(
            progress_reporter.safe_command("bash -lc 'unterminated"), "unknown"
        )
        self.assertNotIn(
            "SUPER_SECRET", progress_reporter.safe_command("echo SUPER_SECRET")
        )
        self.assertNotIn(
            "TOP_SECRET", progress_reporter.safe_command("python3 -c 'print(\"TOP_SECRET\")'")
        )
        credentials = (
            ("Authorization: Bearer super-secret", "super-secret"),
            ("AWS_SECRET_ACCESS_KEY=rawsecret", "rawsecret"),
            ("password=12345678", "12345678"),
            ("token=87654321", "87654321"),
            ("sk-proj-abcdefghijklmnop", "sk-proj-abcdefghijklmnop"),
            (
                "ghp_abcdefghijklmnopqrstuvwxyz123456",
                "ghp_abcdefghijklmnopqrstuvwxyz123456",
            ),
            (
                "eyJhbGciOiJIUzI1NiJ9.eyJjcmVkZW50aWFsIjoic2VjcmV0In0.signature123",
                "eyJhbGciOiJIUzI1NiJ9.eyJjcmVkZW50aWFsIjoic2VjcmV0In0.signature123",
            ),
        )
        for value, credential in credentials:
            self.assertNotIn(credential, progress_reporter.shorten(value))
        self.assertEqual(
            progress_reporter.shorten("tokens=90,000"),
            "tokens=90,000",
        )
        shortened = progress_reporter.shorten("x" * 200)
        self.assertLessEqual(len(shortened), 160)
        self.assertNotIn("\x1b", progress_reporter.shorten("echo \x1b[31mred"))
        self.assertTrue(shortened.endswith("…"))

    def test_run_stream_processes_live_pipe_without_buffered_event_loss(self):
        output = NotifyingOutput()
        reporter = progress_reporter.ProgressReporter(output=output)
        read_fd, write_fd = os.pipe()
        stream = os.fdopen(read_fd, "r")
        reporter_thread = threading.Thread(
            target=progress_reporter.run_stream,
            args=(stream, reporter),
        )
        reporter_thread.start()
        try:
            os.write(
                write_fd,
                b'{"type":"turn.started"}\n'
                b'{"type":"turn.completed","usage":{"input_tokens":60000}}\n'
                b'{"type":"task_complete"}\n',
            )
            self.assertTrue(output.wait_for_lines(3, timeout=2.0))
            self.assertEqual(reporter.event_count, 3)
            self.assertNotIn("still reasoning", output.rendered())
            self.assertTrue(reporter_thread.is_alive())
        finally:
            os.close(write_fd)
            reporter_thread.join(timeout=2.0)
            stream.close()

        self.assertFalse(reporter_thread.is_alive())
        self.assertNotIn("still reasoning", output.rendered())
        self.assertIn(
            "Summary: events=3 tool calls=0 subagents=0 tokens=60,000",
            output.rendered(),
        )

    def test_raw_ingestion_bounds_queue_and_discards_oversized_lines(self):
        production_queue = progress_reporter._new_line_queue()
        self.assertEqual(
            production_queue.maxsize, progress_reporter.MAX_QUEUED_EVENTS
        )
        self.assertGreater(production_queue.maxsize, 0)
        for _ in range(production_queue.maxsize):
            production_queue.put_nowait(b"{}")
        with self.assertRaises(queue.Full):
            production_queue.put_nowait(b"{}")

        output = NotifyingOutput()
        reporter = progress_reporter.ProgressReporter(output=output)
        read_fd, write_fd = os.pipe()
        stream = os.fdopen(read_fd, "r")
        reporter_thread = threading.Thread(
            target=progress_reporter.run_stream,
            args=(stream, reporter),
        )
        reporter_thread.start()
        oversized_secret = b"ghp_abcdefghijklmnopqrstuvwxyz123456"
        oversized = (
            b'{"type":"turn.started","payload":"'
            + oversized_secret
            * (progress_reporter.MAX_JSONL_LINE_BYTES // len(oversized_secret) + 2)
            + b'"}\n'
        )
        valid = b'{"type":"task_complete"}\n'
        try:
            payload = oversized + valid
            written = 0
            while written < len(payload):
                written += os.write(write_fd, payload[written:])
            self.assertTrue(output.wait_for_lines(2, timeout=3.0))
            self.assertIn("Oversized event (ignored)", output.rendered())
            self.assertIn("task_complete", output.rendered())
            self.assertNotIn(oversized_secret.decode(), output.rendered())
            self.assertEqual(reporter.event_count, 2)
            self.assertTrue(reporter_thread.is_alive())
        finally:
            os.close(write_fd)
            reporter_thread.join(timeout=3.0)
            stream.close()

        self.assertFalse(reporter_thread.is_alive())

    def test_initial_silence_heartbeats_with_positive_queue_timeouts(self):
        clock = ManualClock()
        output = NotifyingOutput()
        reporter = progress_reporter.ProgressReporter(output=output, clock=clock)
        lines = AdvancingQueue(clock)
        read_fd, write_fd = os.pipe()
        stream = os.fdopen(read_fd, "r")
        reporter_thread = threading.Thread(
            target=progress_reporter.run_stream,
            args=(stream, reporter, lines),
        )
        reporter_thread.start()
        try:
            self.assertTrue(output.wait_for_lines(1, timeout=2.0))
            self.assertIn(
                "[01m01s] … still reasoning, last event 61s ago, 0 events total",
                output.rendered(),
            )
            self.assertTrue(lines.second_get_started.wait(timeout=2.0))
            self.assertEqual(len(lines.timeouts), 2)
            self.assertAlmostEqual(
                lines.timeouts[0], progress_reporter.HEARTBEAT_SECONDS
            )
            self.assertAlmostEqual(
                lines.timeouts[1], progress_reporter.HEARTBEAT_SECONDS
            )
            self.assertTrue(all(timeout > 0 for timeout in lines.timeouts))
        finally:
            os.close(write_fd)
            reporter_thread.join(timeout=2.0)
            stream.close()

        self.assertFalse(reporter_thread.is_alive())
        self.assertTrue(all(timeout > 0 for timeout in lines.timeouts))

    def test_turn_usage_accumulates_when_no_cumulative_token_events_exist(self):
        output = io.StringIO()
        reporter = progress_reporter.ProgressReporter(output=output, clock=ManualClock())
        for _ in range(2):
            reporter.process_line(
                '{"type":"turn.completed","usage":{"input_tokens":40000,"output_tokens":20000}}'
            )
        reporter.finish()

        lines = output.getvalue().splitlines()
        self.assertTrue(any("Turn completed tokens=60,000" in line for line in lines))
        self.assertTrue(any("Turn completed tokens=120,000" in line for line in lines))
        self.assertIn("Summary: events=2 tool calls=0 subagents=0 tokens=120,000", lines[-1])


    def test_custom_provider_resume_is_an_explicit_opt_in(self):
        workflow = CODE_REVIEW_WORKFLOW_PATH.read_text()
        self.assertIn("provider-session-resume:\n    description:", workflow)
        self.assertIn('default: "false"', workflow.split("  provider-session-resume:", 1)[1].split("  pr-number:", 1)[0])
        expression = workflow.split("    - name: Restore prior review session", 1)[1].split("      if: ", 1)[1].splitlines()[0]
        python_expression = re.sub(r"(?:inputs|steps)\.[\w.-]+", lambda match: f"values[{match.group()!r}]",
                                   expression.replace("&&", "and").replace("||", "or"))
        base = {"steps.skip.outputs.skip": "false", "steps.scope.outputs.review_mode": "incremental",
                "inputs.session-resume": "true", "inputs.provider-base-url": "https://provider",
                "inputs.provider-session-resume": "false"}
        for overrides, expected in [({}, False), ({"inputs.provider-session-resume": "true"}, True),
                                    ({"inputs.session-resume": "false", "inputs.provider-session-resume": "true"}, False),
                                    ({"steps.scope.outputs.review_mode": "full"}, False)]:
            values = {**base, **overrides}
            self.assertEqual(eval(python_expression, {"__builtins__": {}}, {"values": values}), expected)

    def test_review_budget_input_bounds_the_shared_attempt_budget(self):
        workflow = CODE_REVIEW_WORKFLOW_PATH.read_text()
        condition = next(line.strip() for line in workflow.splitlines()
                         if line.strip().startswith('if [[ ! "$REVIEW_BUDGET_MINUTES"'))
        assignment = next(line.strip() for line in workflow.splitlines()
                          if line.strip().startswith("CODEX_BUDGET_SECONDS=$(("))
        script = f'{condition}\nexit 8\nfi\n{assignment}\nprintf "%s" "$CODEX_BUDGET_SECONDS"'
        for minutes, expected in [("20", "1200"), ("40", "2400"), ("0", None),
                                  ("121", None), ("999999999999999999999", None)]:
            result = subprocess.run(["bash", "-c", script], env={**os.environ, "REVIEW_BUDGET_MINUTES": minutes},
                                    text=True, capture_output=True)
            self.assertEqual(result.stdout if result.returncode == 0 else None, expected)


class SanitizeFailureTailTest(unittest.TestCase):
    """The failure diagnostic must never echo raw event bytes to the job log."""

    def _sanitize(self, lines):
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "sanitize_failure_tail", SCRIPT_DIR / "sanitize-failure-tail.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        reporter = module._load_reporter()
        return list(module.sanitize_lines(lines, reporter.shorten))

    def test_drops_tool_payloads_and_redacts_secrets(self):
        rendered = self._sanitize(
            [
                '{"type":"error","message":"stream disconnected before completion"}',
                '{"type":"item.completed","item":{"aggregated_output":'
                '"api_key=sk-not-a-real-secret-但-shape rest of a huge tool dump"}}',
                "stderr line with token ghp_ABCDEF1234567890abcdef1234567890abcd",
                "plain stderr diagnostic without json",
                # A crash mid-write can truncate an event so payload text sits
                # outside every whitelisted field — it must be omitted, not
                # echoed.
                '{"type":"item.completed","item":{"aggregated_output":"secret-bearing prefix that got trunc',
                '["array-shaped line, not an event object"]',
            ]
        )
        self.assertEqual(rendered[0], "error: stream disconnected before completion")
        # The tool payload is dropped entirely — only the event type survives.
        self.assertNotIn("tool dump", " ".join(rendered))
        self.assertNotIn("api_key", " ".join(rendered))
        # Secrets in non-JSON stderr lines are redacted by SECRET_PATTERNS.
        self.assertIn("[REDACTED]", rendered[2])
        self.assertNotIn("ghp_ABCDEF", " ".join(rendered))
        # Plain stderr diagnostics survive, bounded.
        self.assertEqual(rendered[3], "plain stderr diagnostic without json")
        # Truncated/brace-prefixed and non-object lines are omitted wholesale.
        self.assertTrue(rendered[4].startswith("(malformed event line omitted"))
        self.assertTrue(rendered[5].startswith("(non-object event line omitted"))
        self.assertNotIn("secret-bearing", " ".join(rendered))

    def test_oversized_lines_are_omitted_before_decoding(self):
        huge = '{"type":"item.completed","item":{"aggregated_output":"' + "x" * 70000 + '"}}'
        rendered = self._sanitize([huge])
        self.assertEqual(len(rendered), 1)
        self.assertTrue(rendered[0].startswith("(oversized event line omitted"))
        self.assertNotIn("xxxx", rendered[0])


if __name__ == "__main__":
    unittest.main()
