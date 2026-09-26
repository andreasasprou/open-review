"""Reduce raw Codex --json tail lines to sanitized, classified fields.

The failure diagnostic echoed into the hosted job log must never contain raw
event bytes: one event line can embed a tool's entire aggregated_output,
command arguments, or secret-bearing text. Each stdin line is reduced to its
event type plus error/message text, run through progress-reporter's
``shorten`` — the same control-character scrub, SECRET_PATTERNS redaction,
and length cap the hosted progress digest uses.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys


def _load_reporter():
    here = pathlib.Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "progress_reporter", here / "progress-reporter.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Any event line we would ever want to render (error/turn.failed messages)
# is tiny; a line beyond this bound is a payload-bearing event that would be
# omitted anyway — refuse to even decode it, so a multi-megabyte
# aggregated_output cannot consume parse memory in the failure path.
MAX_EVENT_LINE_BYTES = 65536


def sanitize_lines(lines, shorten):
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if len(line) > MAX_EVENT_LINE_BYTES:
            yield f"(oversized event line omitted, {len(line)} bytes)"
            continue
        try:
            event = json.loads(line)
        except ValueError:
            # A line that looks like a (truncated) JSON event must never pass
            # through raw: a crash mid-write can split an event so its tool
            # payload lands outside every whitelisted field. Plain text lines
            # are the CLI's own stderr diagnostics and stay, redacted+bounded.
            if line.startswith("{"):
                yield f"(malformed event line omitted, {len(line)} bytes)"
            else:
                yield shorten(line, 400)
            continue
        if not isinstance(event, dict):
            yield f"(non-object event line omitted, {len(line)} bytes)"
            continue
        kind = event.get("type", "")
        detail = ""
        for source in (event, event.get("error"), event.get("message")):
            if isinstance(source, dict):
                detail = source.get("message") or source.get("error") or detail
            elif isinstance(source, str) and source:
                detail = source
        yield f"{shorten(kind, 80)}: {shorten(detail, 320)}"


def main() -> int:
    reporter = _load_reporter()
    for rendered in sanitize_lines(sys.stdin, reporter.shorten):
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
