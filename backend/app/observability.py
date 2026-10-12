"""Bounded operational events. Never serialize a request, exception, or settings."""
from __future__ import annotations

import json
import logging
import re
import sys
import uuid
from datetime import datetime, timezone

LOGGER_NAME = "local_assistant"
LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_FIELDS = {
    "trace_id", "http_request_id", "request_id", "job_id", "method", "route",
    "status_code", "duration_ms", "bytes", "content_type", "purpose", "chars",
    "kind", "plan_kind", "state", "code", "version", "component", "port", "command_text",
}
_IDS = {"trace_id": r"http_[0-9a-f]{32}", "http_request_id": r"http_[0-9a-f]{32}",
        "request_id": r"req_[0-9a-f]{32}", "job_id": r"job_[0-9a-f]{32}"}


def new_trace_id() -> str:
    return "http_" + uuid.uuid4().hex


def configure_logging(level: str = "INFO") -> None:
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(level.upper())
    logger.propagate = False
    # Only manage our own handler. Test/application handlers remain intact.
    for handler in list(logger.handlers):
        if getattr(handler, "local_assistant_handler", False):
            logger.removeHandler(handler)
            handler.close()
    handler = logging.StreamHandler(sys.stderr)
    handler.local_assistant_handler = True
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)


def safe_code(value: str | None, default: str = "internal_error") -> str:
    return value if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value) else default


def http_route(path: str) -> str:
    """Classify paths without logging untrusted path/query/filename content."""
    exact = {"/": "static", "/health": "/health", "/docs": "/docs", "/openapi.json": "/openapi.json",
             "/v1/chat": "/v1/chat", "/v1/audio": "/v1/audio", "/v1/notes": "/v1/notes",
             "/v1/actions": "/v1/actions"}
    if path in exact:
        return exact[path]
    if path.startswith("/js/") or path.startswith("/css/") or path.startswith("/assets/"):
        return "static"
    if path.startswith("/v1/auth/"):
        last = path.removeprefix("/v1/auth/")
        return path if last in {"pairing-codes", "pair", "session", "logout", "me", "revoke-device"} else "unmatched"
    for base, pattern in (("audio", "job"), ("requests", "req"), ("actions", "act"), ("notes", "note")):
        match = re.fullmatch(rf"/v1/{base}/{pattern}_[0-9a-f]{{32}}(?:/(select-contact|select-note|confirm|cancel|result|actions))?", path)
        if match:
            return f"/v1/{base}/{{id}}" + ("/" + match[1] if match[1] else "")
    return "unmatched"


def event(application_state, name: str, *, level: int = logging.INFO, **fields) -> None:
    """Callers pass explicit metadata only; unknown fields cannot escape to logs."""
    logger = logging.getLogger(LOGGER_NAME)
    if not logger.isEnabledFor(level):
        return
    payload = {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
               "level": logging.getLevelName(level), "event": name}
    for key, value in fields.items():
        if key not in _FIELDS or value is None:
            continue
        if key in _IDS:
            if isinstance(value, str) and re.fullmatch(_IDS[key], value):
                payload[key] = value
            continue
        if key == "command_text":
            settings = getattr(application_state, "settings", None)
            if getattr(settings, "log_command_text", False) and isinstance(value, str):
                payload[key] = value[:200]
                payload["command_text_truncated"] = len(value) > 200
            continue
        if key == "code":
            payload[key] = safe_code(value)
            continue
        if isinstance(value, (int, float, bool, str)):
            payload[key] = value[:128] if isinstance(value, str) else value
    # JSON escapes CR/LF; one user command can never inject another log line.
    logger.log(level, json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
