#!/usr/bin/env python3
"""Render compact, safe progress lines for a Codex ``--json`` stream."""

import hashlib
import json
import math
import os
import queue
import re
import shlex
import sys
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    TextIO,
    Tuple,
    Union,
)


MAX_PAYLOAD_CHARS = 160
HEARTBEAT_SECONDS = 60.0
MIN_QUEUE_TIMEOUT_SECONDS = 0.01
TOKEN_REPORT_THRESHOLD = 50_000
EXIT_CODE_MIN = -128
EXIT_CODE_MAX = 255
TOKEN_COUNTER_LIMIT = 100_000_000_000
MAX_DURATION_SECONDS = 24 * 60 * 60
MAX_DURATION_MILLISECONDS = MAX_DURATION_SECONDS * 1000
MAX_RECEIVER_IDS = 8
MAX_CORRELATIONS = 256
MAX_RAW_ID_CHARS = 256
MAX_RAW_ID_BITS = 1024
MAX_JSONL_LINE_BYTES = 256 * 1024
READ_CHUNK_BYTES = 64 * 1024
MAX_QUEUED_EVENTS = 32
MAX_COMMAND_WRAPPER_DEPTH = 4
MAX_DISTINCT_SUBAGENTS = 100_000
FLEET_MODELS = {
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
    "composer-2.5",
}
EFFORT_PATTERN = re.compile(r"^(?:none|minimal|low|medium|high|xhigh)$")
OpaqueId = Tuple[str, Union[str, int]]
CorrelationKey = Tuple[str, OpaqueId]


@dataclass(frozen=True)
class ParsedInteger:
    value: Optional[int] = None
    invalid: bool = False


@dataclass(frozen=True)
class ParsedDuration:
    seconds: Optional[float] = None
    invalid: bool = False


SECRET_PATTERNS = (
    re.compile(
        r"(?i)\b(?:authorization|bearer|api[_-]?key|access[_-]?token|"
        r"refresh[_-]?token|password|passwd|secret|token)\b\s*[\"']?\s*[:=]"
        r"\s*[\"']?(?:bearer\s+)?[^\s,\"'}]+"
    ),
    re.compile(
        r"(?i)\b(?:"
        r"[\w.-]*(?:secret|password|passwd|api[_-]?key|access[_-]?key)[\w.-]*|"
        r"[\w.-]*token)\s*[:=]\s*[^\s,;]+"
    ),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"\b(?:sk|rk|sess|sk-proj|sk-ant)[-_][A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
)
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
ENV_ASSIGNMENT_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=", re.DOTALL)
SAFE_COMMAND_WORDS = {
    "awk",
    "bash",
    "cat",
    "check",
    "codex",
    "cp",
    "curl",
    "diff",
    "docker",
    "echo",
    "exec",
    "find",
    "git",
    "grep",
    "head",
    "jq",
    "ls",
    "make",
    "node",
    "npm",
    "npx",
    "pnpm",
    "printf",
    "pwd",
    "python",
    "python3",
    "rg",
    "rm",
    "sed",
    "sh",
    "sort",
    "status",
    "tail",
    "test",
    "timeout",
    "true",
    "unittest",
    "wc",
}
SAFE_TOOL_IDENTIFIERS = {
    "apply_patch",
    "exec_command",
    "mcp",
    "read_file",
    "shell",
    "spawn_agent",
    "view_image",
    "wait",
    "web_search",
    "write_file",
}
STATUS_ALIASES = {
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "complete": "completed",
    "completed": "completed",
    "done": "completed",
    "error": "failed",
    "failed": "failed",
    "failure": "failed",
    "in_progress": "in_progress",
    "pending": "in_progress",
    "running": "in_progress",
    "started": "in_progress",
    "success": "completed",
    "succeeded": "completed",
    "timed_out": "timed_out",
    "timeout": "timed_out",
}
AGENT_STATE_ALIASES = {
    "complete": "completed",
    "completed": "completed",
    "done": "completed",
    "error": "failed",
    "errored": "failed",
    "failed": "failed",
    "failure": "failed",
    "not_found": "failed",
    "notfound": "failed",
    "shutdown": "failed",
    "in_progress": "in_progress",
    "interrupted": "in_progress",
    "pending": "in_progress",
    "pending_init": "in_progress",
    "pendinginit": "in_progress",
    "running": "in_progress",
    "started": "in_progress",
    "timed_out": "in_progress",
    "timeout": "in_progress",
}


def shorten(value: Any, limit: int = MAX_PAYLOAD_CHARS) -> str:
    """Make one safe, bounded line of text without serializing payloads."""

    if isinstance(value, str):
        text = str(value)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        text = str(value)
    else:
        return ""
    text = CONTROL_CHARS.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    if len(text) > limit:
        return text[: max(0, limit - 1)] + "…"
    return text


def opaque_id(value: Any) -> Optional[OpaqueId]:
    """Normalize an internal correlation ID into bounded retained state."""

    if isinstance(value, str):
        if not value:
            return None
        if len(value) > MAX_RAW_ID_CHARS:
            digest = hashlib.sha256(
                value.encode("utf-8", errors="surrogatepass")
            ).hexdigest()
            return ("string-sha256", digest)
        return ("string", value)
    if isinstance(value, int) and not isinstance(value, bool):
        if value.bit_length() > MAX_RAW_ID_BITS:
            byte_count = max(1, (value.bit_length() + 8) // 8)
            digest = hashlib.sha256(
                value.to_bytes(byte_count, byteorder="big", signed=True)
            ).hexdigest()
            return ("integer-sha256", digest)
        return ("integer", value)
    return None


def opaque_id_digest(value: OpaqueId) -> bytes:
    kind, raw_value = value
    payload = kind.encode("ascii") + b"\0" + str(raw_value).encode(
        "utf-8", errors="surrogatepass"
    )
    return hashlib.sha256(payload).digest()


class BoundedDistinctIdLedger:
    """Count opaque IDs exactly within a fixed operational domain."""

    def __init__(self) -> None:
        self.digests = set()
        self.overflowed = False

    def observe(self, value: OpaqueId) -> None:
        if self.overflowed:
            return
        digest = opaque_id_digest(value)
        if digest in self.digests:
            return
        if len(self.digests) >= MAX_DISTINCT_SUBAGENTS:
            self.digests.clear()
            self.overflowed = True
            return
        self.digests.add(digest)

    @property
    def count(self) -> int:
        return len(self.digests)


def opaque_batch_fingerprint(values: Iterable[OpaqueId]) -> OpaqueId:
    """Build an order-independent fixed-size identity for a recipient batch."""

    member_digests = [opaque_id_digest(value) for value in values]
    digest = hashlib.sha256()
    for member_digest in sorted(member_digests):
        digest.update(member_digest)
    return ("batch-sha256", digest.hexdigest())


def _safe_command_tokens(tokens: List[str], depth: int = 0) -> str:
    if not tokens or depth >= MAX_COMMAND_WRAPPER_DEPTH:
        return "unknown"

    command = os.path.basename(tokens[0])
    if command == "env":
        index = 1
        while index < len(tokens):
            token = tokens[index]
            if token == "--":
                index += 1
                break
            if ENV_ASSIGNMENT_PATTERN.match(token):
                index += 1
                continue
            if token in ("-i", "--ignore-environment"):
                index += 1
                continue
            if token in ("-u", "--unset", "-C", "--chdir"):
                index += 2
                continue
            if token.startswith("--unset=") or token.startswith("--chdir="):
                index += 1
                continue
            if token.startswith("-"):
                return "unknown"
            break
        return _safe_command_tokens(tokens[index:], depth + 1)

    if command in ("bash", "sh") and len(tokens) >= 3:
        if tokens[1] in ("-c", "-lc"):
            try:
                inner_tokens = shlex.split(tokens[2], posix=True)
            except ValueError:
                return "unknown"
            return _safe_command_tokens(inner_tokens, depth + 1)

    return command if command in SAFE_COMMAND_WORDS else "unknown"


def safe_command(value: Any) -> str:
    """Return an allowlisted inner executable without arguments."""

    if not isinstance(value, str):
        return "unknown"
    try:
        tokens = shlex.split(value, posix=True)
    except ValueError:
        return "unknown"
    return _safe_command_tokens(tokens)


def safe_tool_identifier(value: Any) -> str:
    """Return a fixed tool identifier without rendering provider-controlled names."""

    if not isinstance(value, str):
        return "unknown"
    identifier = value.strip().lower()
    return identifier if identifier in SAFE_TOOL_IDENTIFIERS else "unknown"


def safe_status(value: Any, default: str = "completed") -> str:
    """Collapse provider status text into a fixed enum."""

    if value is None:
        return default
    if not isinstance(value, str):
        return "unknown"
    return STATUS_ALIASES.get(value.strip().lower(), "unknown")


def safe_agent_state(value: Any) -> str:
    """Collapse a producer agent state into terminal or live categories."""

    if not isinstance(value, str):
        return "unknown"
    return AGENT_STATE_ALIASES.get(value.strip().lower(), "unknown")


def safe_agent_state_payload(value: Any) -> str:
    """Normalize current and legacy producer state shapes without rendering them."""

    if isinstance(value, str):
        return safe_agent_state(value)
    state_mapping = as_mapping(value)
    if not state_mapping:
        return "unknown"
    nested_state = first_value((state_mapping,), ("status", "state"))
    if nested_state is not None:
        return safe_agent_state(nested_state)
    if "completed" in state_mapping:
        return "completed"
    if "errored" in state_mapping:
        return "failed"
    return "unknown"


def safe_model(value: Any) -> Optional[str]:
    """Return the reporter-owned literal for an exact fleet-model match."""

    if not isinstance(value, str):
        return None
    return next((model for model in FLEET_MODELS if value == model), None)


def safe_effort(value: Any) -> Optional[str]:
    """Return a fixed reasoning-effort value."""

    if not isinstance(value, str) or not EFFORT_PATTERN.fullmatch(value):
        return None
    return value


def as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def bounded_integer(value: Any, minimum: int, maximum: int) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, float):
        if (
            not math.isfinite(value)
            or not value.is_integer()
            or not minimum <= value <= maximum
        ):
            return None
        parsed = int(value)
    elif isinstance(value, str):
        stripped = value.strip()
        if not re.fullmatch(r"[+-]?\d+", stripped):
            return None
        digits = stripped.lstrip("+-")
        max_digits = len(str(max(abs(minimum), abs(maximum))))
        if len(digits) > max_digits:
            return None
        try:
            parsed = int(stripped)
        except ValueError:
            return None
    else:
        return None
    return parsed if minimum <= parsed <= maximum else None


def parse_exit_code(value: Any) -> ParsedInteger:
    parsed = bounded_integer(value, EXIT_CODE_MIN, EXIT_CODE_MAX)
    return ParsedInteger(value=parsed, invalid=parsed is None)


def parse_token_counter(value: Any) -> ParsedInteger:
    parsed = bounded_integer(value, 0, TOKEN_COUNTER_LIMIT - 1)
    return ParsedInteger(value=parsed, invalid=parsed is None)


def parse_duration_milliseconds(value: Any) -> ParsedDuration:
    parsed = bounded_integer(value, 0, MAX_DURATION_MILLISECONDS - 1)
    if parsed is None:
        return ParsedDuration(invalid=True)
    return ParsedDuration(seconds=parsed / 1000)


def parse_duration_seconds(value: Any) -> ParsedDuration:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ParsedDuration(invalid=True)
    seconds = float(value)
    if not math.isfinite(seconds) or not 0 <= seconds < MAX_DURATION_SECONDS:
        return ParsedDuration(invalid=True)
    return ParsedDuration(seconds=seconds)


def first_value(mappings: Iterable[Mapping[str, Any]], keys: Iterable[str]) -> Any:
    for mapping in mappings:
        for key in keys:
            value = mapping.get(key)
            if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                if str(value).strip():
                    return value
    return None


def first_present_value(
    mappings: Iterable[Mapping[str, Any]], keys: Iterable[str]
) -> Tuple[bool, Any]:
    for mapping in mappings:
        for key in keys:
            if key in mapping:
                return True, mapping[key]
    return False, None


def format_elapsed(seconds: float) -> str:
    parsed = parse_duration_seconds(seconds)
    if parsed.invalid or parsed.seconds is None:
        return "invalid"
    total_seconds = int(parsed.seconds)
    minutes, remainder = divmod(total_seconds, 60)
    return f"{minutes:02d}m{remainder:02d}s"


def format_duration(duration: ParsedDuration) -> str:
    if duration.invalid:
        return "invalid"
    if duration.seconds is None:
        return "0.0s"
    seconds = duration.seconds
    if seconds < 60:
        return f"{seconds:.1f}s"
    return format_elapsed(seconds)


def format_count(value: int) -> str:
    parsed = parse_token_counter(value)
    if parsed.invalid or parsed.value is None:
        return "invalid"
    return f"{parsed.value:,}"


@dataclass(frozen=True)
class SubagentMetadata:
    model: Optional[str] = None
    effort: Optional[str] = None

    def with_fallback(self, fallback: "SubagentMetadata") -> "SubagentMetadata":
        return SubagentMetadata(
            model=self.model or fallback.model,
            effort=self.effort or fallback.effort,
        )


@dataclass(frozen=True)
class BoundedOpaqueIds:
    ids: Tuple[OpaqueId, ...]
    omitted: int = 0
    fingerprint: Optional[OpaqueId] = None

@dataclass(frozen=True)
class AgentStateSummary:
    retained: Dict[OpaqueId, str]
    omitted_completed: int = 0
    omitted_failed: int = 0
    omitted_in_progress: int = 0
    omitted_unknown: int = 0

    @property
    def omitted_terminal(self) -> int:
        return self.omitted_completed + self.omitted_failed

    @property
    def omitted_still_running(self) -> int:
        return self.omitted_in_progress + self.omitted_unknown


@dataclass(frozen=True)
class OmittedBatchState:
    total: int
    live: int


@dataclass(frozen=True)
class PendingCall:
    started_at: float
    metadata: SubagentMetadata
    receivers: BoundedOpaqueIds = BoundedOpaqueIds(ids=())


@dataclass(frozen=True)
class SubagentSnapshot:
    local_id: str
    metadata: SubagentMetadata
    started_at: Optional[float]


class ProgressReporter:
    """Stateful projection of a Codex JSONL stream into stderr lines."""

    def __init__(
        self,
        output: TextIO = sys.stderr,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.output = output
        self.clock = clock
        self.started_at = clock()
        self.last_event_at = self.started_at
        self.last_heartbeat_at: Optional[float] = None
        self.event_count = 0
        self.tool_call_count = 0
        self.correlation_fifo: OrderedDict[CorrelationKey, None] = OrderedDict()
        self.subagent_ids = set()
        self.anonymous_subagent_count = 0
        self.distinct_subagents = BoundedDistinctIdLedger()
        self.live_omitted_subagent_count = 0
        self.omitted_batches: Dict[OpaqueId, OmittedBatchState] = {}
        self.subagent_metadata: Dict[OpaqueId, SubagentMetadata] = {}
        self.subagent_local_ids: Dict[OpaqueId, str] = {}
        self.subagent_started_at: Dict[OpaqueId, float] = {}
        self.subagent_sequence = 0
        self.pending_calls: Dict[OpaqueId, PendingCall] = {}
        self.completed_call_ids = set()
        self.call_sequence = 0
        self.tokens_total = 0
        self.turn_usage_total = 0
        self.cumulative_token_total: Optional[int] = None
        self.last_token_report = 0
        self.tokens_invalid = False
        self.finished = False

    def emit(self, detail: str, now: Optional[float] = None) -> None:
        elapsed = format_elapsed((self.clock() if now is None else now) - self.started_at)
        safe_detail = shorten(detail) or "Event"
        try:
            self.output.write(f"[{elapsed}] {safe_detail}\n")
            self.output.flush()
        except (OSError, ValueError):
            # A closed diagnostic stream must not stop the review process.
            pass

    def _contexts(
        self, event: Mapping[str, Any], item: Optional[Mapping[str, Any]] = None
    ) -> List[Mapping[str, Any]]:
        contexts: List[Mapping[str, Any]] = [event]
        if item:
            contexts.insert(0, item)
        for mapping in list(contexts):
            for key in (
                "metadata",
                "thread",
                "subagent",
                "agent",
                "tool_call",
                "collab_tool_call",
            ):
                nested = as_mapping(mapping.get(key))
                if nested:
                    contexts.append(nested)
        return contexts

    def _event_subagent_metadata(
        self,
        event: Mapping[str, Any],
        item: Optional[Mapping[str, Any]] = None,
    ) -> SubagentMetadata:
        contexts = self._contexts(event, item)
        return SubagentMetadata(
            model=safe_model(
                first_value(contexts, ("model", "model_name", "model_id"))
            ),
            effort=safe_effort(
                first_value(
                    contexts,
                    ("reasoning_effort", "model_reasoning_effort", "effort"),
                )
            ),
        )

    def _drop_correlation_state(self, key: CorrelationKey) -> None:
        namespace, raw_id = key
        if namespace == "call":
            self.pending_calls.pop(raw_id, None)
            self.completed_call_ids.discard(raw_id)
            return
        if namespace == "batch":
            state = self.omitted_batches.pop(raw_id, None)
            if state:
                self.live_omitted_subagent_count = max(
                    0, self.live_omitted_subagent_count - state.live
                )
            return
        self.subagent_ids.discard(raw_id)
        self.subagent_metadata.pop(raw_id, None)
        self.subagent_local_ids.pop(raw_id, None)
        self.subagent_started_at.pop(raw_id, None)

    def _track_correlation(self, namespace: str, raw_id: OpaqueId) -> None:
        key = (namespace, raw_id)
        if key in self.correlation_fifo:
            return
        self.correlation_fifo[key] = None
        if len(self.correlation_fifo) > MAX_CORRELATIONS:
            evicted_key = self._correlation_eviction_candidate()
            self.correlation_fifo.pop(evicted_key, None)
            self._drop_correlation_state(evicted_key)

    def _correlation_eviction_candidate(self) -> CorrelationKey:
        for namespace, raw_id in self.correlation_fifo:
            if namespace == "call" and raw_id in self.completed_call_ids:
                return (namespace, raw_id)
        for namespace, raw_id in self.correlation_fifo:
            if namespace == "batch":
                state = self.omitted_batches.get(raw_id)
                if state and state.live == 0:
                    return (namespace, raw_id)
        return next(iter(self.correlation_fifo))

    def _forget_correlation(self, namespace: str, raw_id: OpaqueId) -> None:
        key = (namespace, raw_id)
        self.correlation_fifo.pop(key, None)
        self._drop_correlation_state(key)

    def _new_local_subagent_id(self) -> str:
        self.subagent_sequence += 1
        return f"subagent-{self.subagent_sequence}"

    def _untracked_subagent_count(self, ids: Iterable[OpaqueId]) -> int:
        return sum(raw_id not in self.subagent_local_ids for raw_id in ids)

    def _observe_omitted_subagents(
        self, batch: BoundedOpaqueIds, newly_retained: int = 0
    ) -> None:
        if batch.omitted <= 0:
            return
        fingerprint = batch.fingerprint
        state = self.omitted_batches.get(fingerprint) if fingerprint else None
        if state is not None:
            promoted = min(max(0, newly_retained), state.total)
            if promoted:
                promoted_live = min(promoted, state.live)
                self.live_omitted_subagent_count -= promoted_live
                self.omitted_batches[fingerprint] = OmittedBatchState(
                    total=state.total - promoted,
                    live=state.live - promoted_live,
                )
            return
        self.live_omitted_subagent_count += batch.omitted
        if fingerprint is not None:
            self._track_correlation("batch", fingerprint)
            self.omitted_batches[fingerprint] = OmittedBatchState(
                total=batch.omitted,
                live=batch.omitted,
            )

    def _resolve_omitted_subagents(
        self, batch: BoundedOpaqueIds, count: int
    ) -> None:
        if count <= 0:
            return
        self._observe_omitted_subagents(batch)
        fingerprint = batch.fingerprint
        state = self.omitted_batches.get(fingerprint) if fingerprint else None
        if state is None:
            resolved = min(count, self.live_omitted_subagent_count)
            self.live_omitted_subagent_count -= resolved
            return
        resolved = min(count, state.live)
        self.live_omitted_subagent_count -= resolved
        self.omitted_batches[fingerprint] = OmittedBatchState(
            total=state.total,
            live=state.live - resolved,
        )

    def _local_subagent_id(self, raw_id: OpaqueId) -> str:
        self.distinct_subagents.observe(raw_id)
        local_id = self.subagent_local_ids.get(raw_id)
        if local_id is None:
            self._track_correlation("subagent", raw_id)
            local_id = self._new_local_subagent_id()
            self.subagent_ids.add(raw_id)
            self.subagent_local_ids[raw_id] = local_id
        return local_id

    def _subagent_suffix(
        self, metadata: SubagentMetadata, ids: List[OpaqueId], count: int
    ) -> str:
        fields = []
        local_ids = [self._local_subagent_id(raw_id) for raw_id in ids]
        if len(local_ids) == 1:
            fields.append(f"id={local_ids[0]}")
        elif local_ids:
            fields.append(f"ids={','.join(local_ids)}")
        if metadata.model:
            fields.append(f"model={metadata.model}")
        if metadata.effort:
            fields.append(f"effort={metadata.effort}")
        fields.append(f"count={count}")
        return " ".join(fields)

    def _remember_subagents(
        self,
        ids: Iterable[OpaqueId],
        metadata: SubagentMetadata,
        started_at: Optional[float] = None,
    ) -> None:
        for subagent_id in ids:
            self._local_subagent_id(subagent_id)
            previous = self.subagent_metadata.get(subagent_id, SubagentMetadata())
            self.subagent_metadata[subagent_id] = metadata.with_fallback(previous)
            if started_at is not None:
                self.subagent_started_at.setdefault(subagent_id, started_at)

    def _take_subagent(
        self, raw_id: OpaqueId, event_metadata: SubagentMetadata
    ) -> SubagentSnapshot:
        self.distinct_subagents.observe(raw_id)
        local_id = self.subagent_local_ids.get(raw_id)
        if local_id is None:
            local_id = self._new_local_subagent_id()
        metadata = self.subagent_metadata.get(
            raw_id, SubagentMetadata()
        ).with_fallback(event_metadata)
        snapshot = SubagentSnapshot(
            local_id=local_id,
            metadata=metadata,
            started_at=self.subagent_started_at.get(raw_id),
        )
        self._forget_correlation("subagent", raw_id)
        return snapshot

    def _subagent_duration(
        self, started_at: Optional[float], fallback: ParsedDuration
    ) -> ParsedDuration:
        if fallback.invalid:
            return fallback
        if started_at is None:
            return fallback
        return parse_duration_seconds(self.clock() - started_at)

    def _emit_subagent_lines(
        self,
        category: str,
        batch: BoundedOpaqueIds,
        metadata: SubagentMetadata,
        suffix: str = "",
    ) -> None:
        if batch.ids:
            for raw_id in batch.ids:
                self.emit(
                    f"{category} "
                    + self._subagent_suffix(metadata, [raw_id], 1)
                    + suffix
                )
        else:
            self.emit(
                f"{category} "
                + self._subagent_suffix(metadata, [], 1)
                + suffix
            )
        if batch.omitted:
            self.emit(f"{category} +{batch.omitted} more")

    def _emit_subagent_joins(
        self,
        batch: BoundedOpaqueIds,
        event_metadata: SubagentMetadata,
        fallback_duration: ParsedDuration,
    ) -> None:
        self._observe_omitted_subagents(
            batch, self._untracked_subagent_count(batch.ids)
        )
        if not batch.ids:
            fields = []
            if event_metadata.model:
                fields.append(f"model={event_metadata.model}")
            if event_metadata.effort:
                fields.append(f"effort={event_metadata.effort}")
            fields.append(f"duration={format_duration(fallback_duration)}")
            self.emit("Subagent joined " + " ".join(fields))
        for raw_id in batch.ids:
            snapshot = self._take_subagent(raw_id, event_metadata)
            duration = self._subagent_duration(
                snapshot.started_at, fallback_duration
            )
            fields = [f"id={snapshot.local_id}"]
            if snapshot.metadata.model:
                fields.append(f"model={snapshot.metadata.model}")
            if snapshot.metadata.effort:
                fields.append(f"effort={snapshot.metadata.effort}")
            fields.append(f"duration={format_duration(duration)}")
            self.emit("Subagent joined " + " ".join(fields))
        if batch.omitted:
            self._resolve_omitted_subagents(batch, batch.omitted)
            self.emit(f"Subagent joined +{batch.omitted} more")

    def _emit_subagent_failure(
        self,
        raw_id: OpaqueId,
        event_metadata: SubagentMetadata,
        fallback_duration: ParsedDuration,
    ) -> None:
        snapshot = self._take_subagent(raw_id, event_metadata)
        duration = self._subagent_duration(snapshot.started_at, fallback_duration)
        fields = [f"id={snapshot.local_id}"]
        if snapshot.metadata.model:
            fields.append(f"model={snapshot.metadata.model}")
        if snapshot.metadata.effort:
            fields.append(f"effort={snapshot.metadata.effort}")
        fields.append(f"duration={format_duration(duration)}")
        self.emit("Subagent failed " + " ".join(fields))

    def _is_subagent(self, event: Mapping[str, Any]) -> bool:
        event_type = str(event.get("type", ""))
        if event_type.startswith("agent.subagent"):
            return True
        if event.get("parent_thread_id") or event.get("parentThreadId"):
            return True
        thread_id = first_value((event,), ("thread_id", "threadId"))
        if opaque_id(thread_id) in self.subagent_ids:
            return True
        return bool(event.get("is_subagent") or event.get("isSubagent"))

    def _extract_id(
        self, event: Mapping[str, Any], item: Optional[Mapping[str, Any]] = None
    ) -> Optional[OpaqueId]:
        mappings = self._contexts(event, item)
        value = first_value(mappings, ("call_id", "callId", "tool_call_id", "id"))
        return opaque_id(value)

    def _next_anonymous_id(self, prefix: str) -> OpaqueId:
        self.call_sequence += 1
        return (f"generated-{prefix}", self.call_sequence)

    def _tool_name(
        self, event: Mapping[str, Any], item: Optional[Mapping[str, Any]] = None
    ) -> str:
        mappings = self._contexts(event, item)
        value = first_value(mappings, ("name", "tool", "command", "server"))
        return safe_tool_identifier(value)

    def _item_type(self, item: Mapping[str, Any]) -> str:
        return shorten(item.get("type")) or "unknown"

    def _item_tool(self, item: Mapping[str, Any]) -> str:
        return safe_tool_identifier(item.get("tool"))

    def _is_tool_item(self, item_type: str) -> bool:
        return item_type in {
            "command_execution",
            "mcp_tool_call",
            "collab_tool_call",
            "web_search",
            "tool_call",
        }

    def _display_name(self, event: Mapping[str, Any], item: Mapping[str, Any]) -> str:
        item_type = self._item_type(item)
        if item_type == "command_execution":
            return safe_command(item.get("command") or item.get("cmd"))
        if item_type == "mcp_tool_call":
            return "mcp"
        if item_type == "collab_tool_call":
            return self._item_tool(item)
        if item_type == "web_search":
            return "web_search"
        return self._tool_name(event, item)

    def _duration_from_event(
        self, event: Mapping[str, Any], item: Mapping[str, Any]
    ) -> ParsedDuration:
        present, value = first_present_value(
            (item, event), ("duration_ms", "durationMs")
        )
        return parse_duration_milliseconds(value) if present else ParsedDuration()

    def _start_call(
        self,
        event: Mapping[str, Any],
        item: Mapping[str, Any],
    ) -> PendingCall:
        call_id = self._extract_id(event, item)
        key = call_id or self._next_anonymous_id("call")
        if key not in self.pending_calls:
            if key in self.completed_call_ids:
                self._forget_correlation("call", key)
            self._track_correlation("call", key)
            self.pending_calls[key] = PendingCall(
                started_at=self.clock(),
                metadata=self._event_subagent_metadata(event, item),
                receivers=self._subagent_ids(item),
            )
            self.tool_call_count += 1
        return self.pending_calls[key]

    def _complete_call(
        self, event: Mapping[str, Any], item: Mapping[str, Any]
    ) -> Tuple[Optional[PendingCall], ParsedDuration, bool]:
        call_id = self._extract_id(event, item)
        event_duration = self._duration_from_event(event, item)
        if call_id and call_id in self.pending_calls:
            pending = self.pending_calls.pop(call_id)
            self.completed_call_ids.add(call_id)
            if event_duration.invalid:
                return pending, event_duration, False
            return (
                pending,
                parse_duration_seconds(self.clock() - pending.started_at),
                False,
            )
        if call_id is not None and call_id in self.completed_call_ids:
            return None, event_duration, True
        if call_id is None:
            self.tool_call_count += 1
        else:
            self.tool_call_count += 1
            self._track_correlation("call", call_id)
            self.completed_call_ids.add(call_id)
        return None, event_duration, False

    def _status(
        self,
        event: Mapping[str, Any],
        item: Mapping[str, Any],
        default: str = "completed",
    ) -> str:
        return safe_status(
            first_value((item, event), ("status", "state")), default=default
        )

    def _exit_suffix(
        self, event: Mapping[str, Any], item: Mapping[str, Any]
    ) -> str:
        present, value = first_present_value(
            (item, event), ("exit_code", "exitCode")
        )
        if not present:
            return ""
        parsed = parse_exit_code(value)
        rendered = "invalid" if parsed.invalid else str(parsed.value)
        return f" exit={rendered}"

    def _completion_suffix(
        self,
        event: Mapping[str, Any],
        item: Mapping[str, Any],
        duration: ParsedDuration,
    ) -> str:
        return (
            f"duration={format_duration(duration)} "
            f"status={self._status(event, item)}"
            f"{self._exit_suffix(event, item)}"
        )

    def _bounded_subagent_ids(self, values: Iterable[Any]) -> BoundedOpaqueIds:
        ids: List[OpaqueId] = []
        seen = set()
        omitted = 0

        for value in values:
            normalized = opaque_id(value)
            if normalized is None or normalized in seen:
                continue
            seen.add(normalized)
            self.distinct_subagents.observe(normalized)
            if len(ids) < MAX_RECEIVER_IDS:
                ids.append(normalized)
            else:
                omitted += 1

        fingerprint = opaque_batch_fingerprint(seen) if omitted else None
        return BoundedOpaqueIds(
            ids=tuple(ids),
            omitted=omitted,
            fingerprint=fingerprint,
        )

    def _receiver_ids(
        self, item: Mapping[str, Any]
    ) -> Optional[BoundedOpaqueIds]:
        for key in ("receiver_thread_ids", "receiverThreadIds", "thread_ids", "threadIds"):
            values = item.get(key)
            if isinstance(values, list):
                return self._bounded_subagent_ids(values)
        return None

    def _state_ids(self, item: Mapping[str, Any]) -> BoundedOpaqueIds:
        return self._bounded_subagent_ids(
            raw_id for raw_id, _ in self._iter_agent_state_entries(item)
        )

    def _agent_state_container(self, item: Mapping[str, Any]) -> Optional[Any]:
        for key in ("agents_states", "agentsStates"):
            states = item.get(key)
            if isinstance(states, dict):
                return states
        statuses = item.get("agent_statuses")
        if isinstance(statuses, list):
            return statuses
        return None

    def _iter_agent_state_entries(
        self, item: Mapping[str, Any]
    ) -> Iterable[Tuple[Any, Any]]:
        states = self._agent_state_container(item)
        if isinstance(states, dict):
            for raw_id, details in states.items():
                yield raw_id, details
            return
        if not isinstance(states, list):
            return
        for entry in states:
            mapping = as_mapping(entry)
            raw_id = first_value((mapping,), ("thread_id", "threadId"))
            if raw_id is None or "status" not in mapping:
                continue
            yield raw_id, mapping["status"]

    def _subagent_ids(self, item: Mapping[str, Any]) -> BoundedOpaqueIds:
        receivers = self._receiver_ids(item)
        return receivers if receivers is not None else self._state_ids(item)

    def _agent_state_summary(
        self, item: Mapping[str, Any], batch: BoundedOpaqueIds
    ) -> AgentStateSummary:
        targets = set(batch.ids)
        retained: Dict[OpaqueId, str] = {}
        omitted_counts = {
            "completed": 0,
            "failed": 0,
            "in_progress": 0,
            "unknown": 0,
        }
        omitted_seen = 0
        seen = set()

        for value, details in self._iter_agent_state_entries(item):
            normalized = opaque_id(value)
            if normalized is None or normalized in seen:
                continue
            seen.add(normalized)
            state = safe_agent_state_payload(details)
            if normalized in targets:
                retained.setdefault(normalized, state)
                continue
            if omitted_seen >= batch.omitted:
                continue
            omitted_seen += 1
            omitted_counts[state] += 1

        omitted_counts["unknown"] += batch.omitted - omitted_seen
        return AgentStateSummary(
            retained=retained,
            omitted_completed=omitted_counts["completed"],
            omitted_failed=omitted_counts["failed"],
            omitted_in_progress=omitted_counts["in_progress"],
            omitted_unknown=omitted_counts["unknown"],
        )

    def _wait_receiver_batch(
        self, item: Mapping[str, Any], pending: Optional[PendingCall]
    ) -> BoundedOpaqueIds:
        if pending and pending.receivers.ids:
            return pending.receivers
        receivers = self._receiver_ids(item)
        if receivers is not None and receivers.ids:
            return receivers
        return self._state_ids(item)

    def _wait_status(
        self,
        event: Mapping[str, Any],
        item: Mapping[str, Any],
        pending: Optional[PendingCall],
    ) -> str:
        status = self._status(event, item, default="unknown")
        completion_receivers = self._receiver_ids(item)
        completion_states = self._agent_state_container(item)
        if (
            status == "completed"
            and pending
            and pending.receivers.ids
            and completion_receivers is not None
            and not completion_receivers.ids
            and completion_states is not None
            and not completion_states
        ):
            return "timed_out"
        return status

    def _remember_wait_receivers(self, pending: PendingCall) -> None:
        self._observe_omitted_subagents(
            pending.receivers,
            self._untracked_subagent_count(pending.receivers.ids),
        )
        if pending.receivers.ids:
            self._remember_subagents(pending.receivers.ids, pending.metadata)

    def _handle_wait_completion(
        self,
        event: Mapping[str, Any],
        item: Mapping[str, Any],
        pending: Optional[PendingCall],
        duration: ParsedDuration,
    ) -> None:
        batch = self._wait_receiver_batch(item, pending)
        metadata = self._event_subagent_metadata(event, item)
        if pending:
            metadata = metadata.with_fallback(pending.metadata)
        call_status = self._wait_status(event, item, pending)
        state_summary = self._agent_state_summary(item, batch)
        self._observe_omitted_subagents(
            batch, self._untracked_subagent_count(batch.ids)
        )

        completed = []
        failed = []
        still_running = []
        for raw_id in batch.ids:
            state = state_summary.retained.get(raw_id, "unknown")
            if state == "completed":
                completed.append(raw_id)
            elif state == "failed":
                failed.append(raw_id)
            else:
                still_running.append(raw_id)

        if completed:
            self._emit_subagent_joins(
                BoundedOpaqueIds(ids=tuple(completed)), metadata, duration
            )
        for raw_id in failed:
            self._emit_subagent_failure(raw_id, metadata, duration)
        terminal_count = len(completed) + len(failed)
        if terminal_count:
            self._resolve_anonymous_subagents(terminal_count)

        if state_summary.omitted_completed:
            self.emit(
                f"Subagent joined +{state_summary.omitted_completed} more"
            )
        self._resolve_omitted_subagents(batch, state_summary.omitted_terminal)

        still_running_count = (
            len(still_running) + state_summary.omitted_still_running
        )
        if (
            failed
            or state_summary.omitted_failed
            or still_running_count
            or not completed
        ):
            fields = [f"status={call_status}"]
            if state_summary.omitted_failed:
                fields.append(
                    f"terminal_unattributed={state_summary.omitted_failed}"
                )
            fields.extend(
                (
                    f"still_running={still_running_count}",
                    f"duration={format_duration(duration)}",
                )
            )
            self.emit("Wait completed " + " ".join(fields))

    def _direct_subagent_id(
        self, event: Mapping[str, Any], subagent: Mapping[str, Any]
    ) -> Optional[OpaqueId]:
        value = first_value(
            (subagent, event),
            ("thread_id", "threadId", "agent_id", "agentId", "id"),
        )
        return opaque_id(value)

    def _register_subagents(
        self,
        event: Mapping[str, Any],
        item: Optional[Mapping[str, Any]] = None,
        metadata: Optional[SubagentMetadata] = None,
        started_at: Optional[float] = None,
    ) -> BoundedOpaqueIds:
        batch = self._subagent_ids(item or event)
        if not batch.ids:
            self.anonymous_subagent_count += 1
            return batch
        if metadata is None:
            metadata = self._event_subagent_metadata(event, item)
        self._observe_omitted_subagents(
            batch, self._untracked_subagent_count(batch.ids)
        )
        self._remember_subagents(batch.ids, metadata, started_at=started_at)
        return batch

    def _resolve_anonymous_subagents(self, count: int) -> None:
        self.anonymous_subagent_count = max(
            0, self.anonymous_subagent_count - max(0, count)
        )

    def _handle_item(self, event: Mapping[str, Any], phase: str) -> None:
        item = as_mapping(event.get("item"))
        if not item:
            self.emit("Malformed item")
            return
        item_type = self._item_type(item)
        if phase == "started" and self._is_tool_item(item_type):
            name = self._display_name(event, item)
            pending = self._start_call(event, item)
            if item_type == "collab_tool_call" and self._item_tool(item) == "spawn_agent":
                batch = self._register_subagents(
                    event,
                    item,
                    pending.metadata,
                    started_at=pending.started_at,
                )
                self._emit_subagent_lines(
                    "Subagent spawned", batch, pending.metadata
                )
            else:
                if (
                    item_type == "collab_tool_call"
                    and self._item_tool(item) == "wait"
                ):
                    self._remember_wait_receivers(pending)
                prefix = "Command" if item_type == "command_execution" else "Tool"
                self.emit(f"{prefix} started: {name}")
            return

        if phase == "completed" and self._is_tool_item(item_type):
            name = self._display_name(event, item)
            pending, duration, duplicate = self._complete_call(event, item)
            if duplicate:
                self.emit("Duplicate completion ignored")
                return
            if item_type == "collab_tool_call" and self._item_tool(item) == "spawn_agent":
                batch = self._subagent_ids(item)
                fallback = pending.metadata if pending else SubagentMetadata()
                metadata = self._event_subagent_metadata(
                    event, item
                ).with_fallback(fallback)
                self._observe_omitted_subagents(
                    batch, self._untracked_subagent_count(batch.ids)
                )
                if batch.ids:
                    self._resolve_anonymous_subagents(len(batch.ids))
                    started_at = pending.started_at if pending else None
                    self._remember_subagents(
                        batch.ids, metadata, started_at=started_at
                    )
                self._emit_subagent_lines(
                    "Subagent spawn completed",
                    batch,
                    metadata,
                    " " + self._completion_suffix(event, item, duration),
                )
                return
            if item_type == "collab_tool_call" and self._item_tool(item) == "wait":
                self._handle_wait_completion(event, item, pending, duration)
            else:
                prefix = "Command" if item_type == "command_execution" else "Tool"
                self.emit(
                    f"{prefix} completed: {name} "
                    f"{self._completion_suffix(event, item, duration)}"
                )
            return

        if item_type == "reasoning":
            self.emit(f"Reasoning {phase}")
        elif item_type == "message":
            self.emit(f"Message {phase}")
        elif item_type == "file_change":
            changes = item.get("changes")
            count = len(changes) if isinstance(changes, list) else 0
            self.emit(f"File change {phase} files={count}")
        else:
            self.emit(f"Item {phase}")

    def _usage_token_total(self, usage: Mapping[str, Any]) -> ParsedInteger:
        values: List[int] = []
        for keys in (
            ("input_tokens", "inputTokens"),
            ("output_tokens", "outputTokens"),
        ):
            present, value = first_present_value((usage,), keys)
            if not present:
                continue
            parsed = parse_token_counter(value)
            if parsed.invalid or parsed.value is None:
                return ParsedInteger(invalid=True)
            values.append(parsed.value)
        if not values:
            return ParsedInteger()
        return parse_token_counter(sum(values))

    def _token_total(self, event: Mapping[str, Any]) -> ParsedInteger:
        candidates: List[Mapping[str, Any]] = [event]
        for key in (
            "info",
            "usage",
            "total_token_usage",
            "totalTokenUsage",
            "token_usage",
            "tokenUsage",
        ):
            nested = as_mapping(event.get(key))
            if nested:
                candidates.append(nested)
        info = as_mapping(event.get("info"))
        for key in ("total_token_usage", "totalTokenUsage", "usage"):
            nested = as_mapping(info.get(key))
            if nested:
                candidates.append(nested)
        for mapping in candidates:
            for key in (
                "total_tokens",
                "totalTokens",
                "total",
                "token_count",
                "tokenCount",
            ):
                if key in mapping:
                    return parse_token_counter(mapping[key])
        usage = as_mapping(event.get("usage"))
        return self._usage_token_total(usage)

    def _handle_token_count(self, event: Mapping[str, Any]) -> None:
        total = self._token_total(event)
        if total.invalid:
            self.tokens_invalid = True
            self.emit("Tokens total=invalid")
            return
        if total.value is None:
            self.emit("Token count update unavailable")
            return
        value = total.value
        if (
            self.cumulative_token_total is not None
            and value < self.cumulative_token_total
        ):
            return
        self.cumulative_token_total = value
        self.tokens_total = max(self.tokens_total, value)
        if value - self.last_token_report >= TOKEN_REPORT_THRESHOLD:
            delta = value - self.last_token_report
            self.last_token_report = value
            self.emit(f"Tokens +{format_count(delta)} total={format_count(value)}")

    def _usage_total(self, event: Mapping[str, Any]) -> ParsedInteger:
        usage = as_mapping(event.get("usage"))
        return self._usage_token_total(usage)

    def _mark_tokens_invalid(self, category: str) -> None:
        self.tokens_invalid = True
        self.emit(f"{category} tokens=invalid")

    def _handle_turn_completed(self, event: Mapping[str, Any]) -> None:
        usage_total = self._usage_total(event)
        if usage_total.invalid:
            self._mark_tokens_invalid("Turn completed")
            return
        if usage_total.value is not None:
            accumulated = parse_token_counter(
                self.turn_usage_total + usage_total.value
            )
            if accumulated.invalid or accumulated.value is None:
                self._mark_tokens_invalid("Turn completed")
                return
            self.turn_usage_total = accumulated.value
            self.tokens_total = max(self.tokens_total, self.turn_usage_total)
        else:
            total = self._token_total(event)
            if total.invalid:
                self._mark_tokens_invalid("Turn completed")
                return
            if total.value is not None:
                self.tokens_total = max(self.tokens_total, total.value)
        rendered_total = (
            "invalid" if self.tokens_invalid else format_count(self.tokens_total)
        )
        suffix = f" tokens={rendered_total}"
        self.emit(f"Turn completed{suffix}")

    def _handle_direct_tool(self, event: Mapping[str, Any], phase: str) -> None:
        tool_call = as_mapping(event.get("tool_call"))
        name = safe_tool_identifier(
            first_value((tool_call, event), ("name", "tool", "server"))
        )
        item = tool_call or event
        if phase == "started":
            self._start_call(event, item)
            self.emit(f"Tool started: {name}")
            return
        _, duration, duplicate = self._complete_call(event, item)
        if duplicate:
            self.emit("Duplicate completion ignored")
            return
        self.emit(
            f"Tool completed: {name} "
            f"{self._completion_suffix(event, item, duration)}"
        )

    def _handle_subagent_event(self, event: Mapping[str, Any], joined: bool) -> None:
        subagent = as_mapping(event.get("subagent"))
        event_metadata = self._event_subagent_metadata(event, subagent or None)
        batch = self._subagent_ids(subagent or event)
        if not batch.ids:
            direct_id = self._direct_subagent_id(event, subagent)
            if direct_id:
                batch = BoundedOpaqueIds(ids=(direct_id,))
        if joined:
            if batch.ids:
                self._resolve_anonymous_subagents(len(batch.ids))
            fallback = self._duration_from_event(event, subagent or event)
            self._emit_subagent_joins(batch, event_metadata, fallback)
            return
        self._observe_omitted_subagents(
            batch, self._untracked_subagent_count(batch.ids)
        )
        if batch.ids:
            self._remember_subagents(
                batch.ids, event_metadata, started_at=self.clock()
            )
        else:
            self.anonymous_subagent_count += 1
        self._emit_subagent_lines("Subagent spawned", batch, event_metadata)

    def _legacy_collab_item(
        self, event: Mapping[str, Any], tool: str
    ) -> Dict[str, Any]:
        item: Dict[str, Any] = {
            "id": first_value((event,), ("call_id", "callId", "id")),
            "type": "collab_tool_call",
            "tool": tool,
        }
        receiver_ids = event.get("receiver_thread_ids") or event.get("receiverThreadIds")
        if isinstance(receiver_ids, list):
            item["receiver_thread_ids"] = receiver_ids
        statuses = event.get("statuses")
        if isinstance(statuses, dict):
            item["agents_states"] = statuses
            if not statuses:
                item["status"] = "timed_out"
        agent_statuses = event.get("agent_statuses")
        if isinstance(agent_statuses, list) and "agents_states" not in item:
            item["agent_statuses"] = agent_statuses
            if not agent_statuses:
                item["status"] = "timed_out"
        return item

    def _handle_legacy_collab(self, event: Mapping[str, Any], joined: bool) -> None:
        event_type = str(event.get("type", ""))
        is_spawn = "spawn" in event_type
        tool = "spawn_agent" if is_spawn else "wait"
        item = self._legacy_collab_item(event, tool)
        if not joined:
            pending = self._start_call(event, item)
            if is_spawn:
                batch = self._register_subagents(
                    event,
                    item,
                    pending.metadata,
                    started_at=pending.started_at,
                )
                self._emit_subagent_lines(
                    "Subagent spawned", batch, pending.metadata
                )
            else:
                self._remember_wait_receivers(pending)
                self.emit("Tool started: wait")
            return

        pending, duration, duplicate = self._complete_call(event, item)
        if duplicate:
            self.emit("Duplicate completion ignored")
            return
        event_metadata = self._event_subagent_metadata(event, item)
        if pending:
            event_metadata = event_metadata.with_fallback(pending.metadata)
        if is_spawn:
            batch = BoundedOpaqueIds(ids=())
            new_thread_id = first_value(
                (event,), ("new_thread_id", "newThreadId", "agent_id", "agentId")
            )
            if new_thread_id is not None:
                self._resolve_anonymous_subagents(1)
                subagent_id = opaque_id(new_thread_id)
                if subagent_id is not None:
                    batch = BoundedOpaqueIds(ids=(subagent_id,))
                    started_at = pending.started_at if pending else None
                    self._remember_subagents(
                        batch.ids, event_metadata, started_at=started_at
                    )
            self._observe_omitted_subagents(
                batch, self._untracked_subagent_count(batch.ids)
            )
            self._emit_subagent_lines(
                "Subagent spawn completed",
                batch,
                event_metadata,
                f" duration={format_duration(duration)}",
            )
            return

        self._handle_wait_completion(event, item, pending, duration)

    def _unwrap_event(self, event: Mapping[str, Any]) -> Mapping[str, Any]:
        nested = as_mapping(event.get("msg"))
        if not nested:
            params = as_mapping(event.get("params"))
            nested = as_mapping(params.get("msg"))
        return nested if isinstance(nested.get("type"), str) else event

    def _handle_event(self, event: Mapping[str, Any]) -> None:
        event = self._unwrap_event(event)
        event_type = event.get("type")
        if not isinstance(event_type, str) or not event_type:
            self.emit("Unknown event")
            return

        if event_type == "thread.started":
            if self._is_subagent(event):
                self._handle_subagent_event(event, joined=False)
            else:
                self.emit("Thread started")
        elif event_type in ("thread.completed", "thread.joined"):
            if self._is_subagent(event):
                self._handle_subagent_event(event, joined=True)
            else:
                self.emit("Thread completed")
        elif event_type in ("turn.started", "task_started"):
            self.emit("Turn started")
        elif event_type in ("turn.completed", "turn_complete"):
            self._handle_turn_completed(event)
        elif event_type == "turn.failed":
            self.emit("Turn failed")
        elif event_type in ("task_complete", "task.completed"):
            self.emit("task_complete")
        elif event_type in (
            "collab_agent_spawn_begin",
            "collab_waiting_begin",
        ):
            self._handle_legacy_collab(event, joined=False)
        elif event_type in (
            "collab_agent_spawn_end",
            "collab_waiting_end",
        ):
            self._handle_legacy_collab(event, joined=True)
        elif event_type in ("token_count", "token.count", "thread.token_count"):
            self._handle_token_count(event)
        elif event_type in ("item.started", "item_started"):
            self._handle_item(event, "started")
        elif event_type in ("item.completed", "item.updated", "item_completed"):
            phase = "updated" if event_type == "item.updated" else "completed"
            self._handle_item(event, phase)
        elif event_type in ("agent.tool_call.started", "tool.started"):
            self._handle_direct_tool(event, "started")
        elif event_type in ("agent.tool_call.completed", "tool.completed"):
            self._handle_direct_tool(event, "completed")
        elif event_type == "agent.subagent.started":
            self._handle_subagent_event(event, joined=False)
        elif event_type in ("agent.subagent.completed", "agent.subagent.joined"):
            self._handle_subagent_event(event, joined=True)
        elif event_type == "agent.reasoning.summary":
            self.emit("Reasoning summary")
        elif event_type == "error":
            self.emit("Error event")
        else:
            self.emit("Unknown event")

    def process_line(self, line: Any) -> None:
        if isinstance(line, bytes):
            line = line.decode("utf-8", errors="replace")
        if not isinstance(line, str) or not line.strip():
            return
        now = self.clock()
        self.event_count += 1
        self.last_event_at = now
        try:
            event = json.loads(line)
        except Exception:
            self.emit("Malformed event (ignored)", now)
            return
        if not isinstance(event, dict):
            self.emit("Unknown event", now)
            return
        try:
            self._handle_event(event)
        except Exception:
            # Keep an unfamiliar schema from taking down a forty-minute review.
            self.emit("Event handling failed (ignored)", now)

    def process_oversized_line(self) -> None:
        now = self.clock()
        self.event_count += 1
        self.last_event_at = now
        self.emit("Oversized event (ignored)", now)

    def emit_heartbeat_if_due(self) -> bool:
        now = self.clock()
        if now - self.last_event_at < HEARTBEAT_SECONDS:
            return False
        if self.last_heartbeat_at is not None and now - self.last_heartbeat_at < HEARTBEAT_SECONDS:
            return False
        self.last_heartbeat_at = now
        age_duration = parse_duration_seconds(now - self.last_event_at)
        age = (
            "invalid"
            if age_duration.invalid or age_duration.seconds is None
            else f"{int(age_duration.seconds)}s"
        )
        self.emit(
            f"… still reasoning, last event {age} ago, {self.event_count} events total",
            now,
        )
        return True

    def heartbeat_timeout(self) -> float:
        heartbeat_anchor = self.last_event_at
        if self.last_heartbeat_at is not None:
            heartbeat_anchor = max(heartbeat_anchor, self.last_heartbeat_at)
        remaining = heartbeat_anchor + HEARTBEAT_SECONDS - self.clock()
        return max(MIN_QUEUE_TIMEOUT_SECONDS, remaining)

    def finish(self) -> None:
        if self.finished:
            return
        self.finished = True
        wall_time = format_elapsed(self.clock() - self.started_at)
        subagent_count = (
            self.distinct_subagents.count + self.anonymous_subagent_count
        )
        rendered_subagents = (
            "invalid"
            if self.distinct_subagents.overflowed
            or subagent_count > MAX_DISTINCT_SUBAGENTS
            else str(subagent_count)
        )
        rendered_tokens = (
            "invalid" if self.tokens_invalid else format_count(self.tokens_total)
        )
        self.emit(
            f"Summary: events={self.event_count} tool calls={self.tool_call_count} "
            f"subagents={rendered_subagents} tokens={rendered_tokens} "
            f"wall time={wall_time}"
        )


def _new_line_queue() -> queue.Queue:
    return queue.Queue(maxsize=MAX_QUEUED_EVENTS)


def run_stream(
    stream: TextIO, reporter: ProgressReporter, line_queue: Optional[Any] = None
) -> None:
    """Read bounded records while keeping heartbeat timing independent."""

    end_of_stream = object()
    oversized_line = object()
    lines = line_queue if line_queue is not None else _new_line_queue()

    def read_stream() -> None:
        buffer = bytearray()
        discarding_oversized_line = False
        try:
            descriptor = stream.fileno()
            while True:
                chunk = os.read(descriptor, READ_CHUNK_BYTES)
                if not chunk:
                    break
                offset = 0
                while offset < len(chunk):
                    newline_at = chunk.find(b"\n", offset)
                    fragment_end = len(chunk) if newline_at < 0 else newline_at
                    fragment = chunk[offset:fragment_end]
                    if not discarding_oversized_line:
                        if len(buffer) + len(fragment) <= MAX_JSONL_LINE_BYTES:
                            buffer.extend(fragment)
                        else:
                            buffer.clear()
                            discarding_oversized_line = True
                    if newline_at < 0:
                        break
                    if discarding_oversized_line:
                        lines.put(oversized_line)
                    else:
                        lines.put(bytes(buffer))
                    buffer.clear()
                    discarding_oversized_line = False
                    offset = newline_at + 1
            if discarding_oversized_line:
                lines.put(oversized_line)
            elif buffer:
                lines.put(bytes(buffer))
        except Exception:
            # A broken input stream still needs a clean bracketed summary.
            pass
        finally:
            lines.put(end_of_stream)

    threading.Thread(target=read_stream, daemon=True).start()
    try:
        while True:
            try:
                line = lines.get(timeout=reporter.heartbeat_timeout())
            except queue.Empty:
                reporter.emit_heartbeat_if_due()
                continue
            if line is end_of_stream:
                break
            if line is oversized_line:
                reporter.process_oversized_line()
            else:
                reporter.process_line(line)
    finally:
        reporter.finish()


def main() -> None:
    reporter = ProgressReporter(output=sys.stderr)
    run_stream(sys.stdin, reporter)


if __name__ == "__main__":
    main()
