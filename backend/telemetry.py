from __future__ import annotations
import contextlib
import logging
import os
import re
import threading
from typing import Any, Iterator, Optional

import config as cfgmod

SERVICE = "trame"
FILE_NAME = "otel.jsonl"
FILE_MAX_BYTES = 10 * 1024 * 1024
_LEVELS = {"info": logging.INFO, "draft": logging.INFO, "sent": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}

_lock = threading.Lock()
_state: dict[str, Any] = {"tracer": None, "providers": (), "handler": None, "file": None, "content": False}
_logger = logging.getLogger("trame.events")
_logger.setLevel(logging.INFO)
_logger.propagate = False


def _settings(raw: Optional[dict]) -> dict:
    raw = dict(raw or {})
    if os.environ.get("TRAME_OTEL_FILE") == "1":
        raw.update({"enabled": True, "endpoint": ""})
    return {"enabled": bool(raw.get("enabled")), "endpoint": str(raw.get("endpoint") or "").strip(),
            "include_content": bool(raw.get("include_content"))}


def file_path():
    return cfgmod.HOME / FILE_NAME


def _shutdown() -> None:
    for p in _state["providers"]:
        try:
            p.shutdown()
        except Exception:
            pass
    if _state["handler"] is not None:
        _logger.removeHandler(_state["handler"])
    if _state["file"] is not None:
        try:
            _state["file"].close()
        except Exception:
            pass
    _state.update({"tracer": None, "providers": (), "handler": None, "file": None})


def configure(raw: Optional[dict]) -> Optional[str]:
    """(Re)start OpenTelemetry from the telemetry settings: OTLP/HTTP to `endpoint`, or
    JSON lines in %APPDATA%\\Trame\\otel.jsonl when no endpoint is set. Returns an
    error message when the setup fails (Trame then runs without telemetry)."""
    s = _settings(raw)
    with _lock:
        _shutdown()
        _state["content"] = s["include_content"]
        if not s["enabled"]:
            return None
        try:
            from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
            from opentelemetry.sdk._logs.export import BatchLogRecordProcessor, ConsoleLogRecordExporter
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter

            resource = Resource.create({"service.name": SERVICE, "service.version": os.environ.get("TRAME_VERSION", "dev")})
            tracer_provider = TracerProvider(resource=resource)
            logger_provider = LoggerProvider(resource=resource)
            if s["endpoint"]:
                from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

                base = s["endpoint"].rstrip("/")
                tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{base}/v1/traces")))
                logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{base}/v1/logs")))
            else:
                path = file_path()
                path.parent.mkdir(parents=True, exist_ok=True)
                if path.exists() and path.stat().st_size > FILE_MAX_BYTES:
                    path.replace(path.with_suffix(".jsonl.1"))
                out = open(path, "a", encoding="utf-8", buffering=1)
                _state["file"] = out
                one_line = lambda x: x.to_json(indent=None) + "\n"  # noqa: E731
                tracer_provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter(out=out, formatter=one_line)))
                logger_provider.add_log_record_processor(BatchLogRecordProcessor(ConsoleLogRecordExporter(out=out, formatter=one_line)))
            handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
            _logger.addHandler(handler)
            _state.update({"tracer": tracer_provider.get_tracer("trame"), "providers": (tracer_provider, logger_provider),
                           "handler": handler})
            return None
        except Exception as e:
            _shutdown()
            return f"OpenTelemetry indisponible : {e}"


def flush() -> None:
    for p in _state["providers"]:
        try:
            p.force_flush()
        except Exception:
            pass


_QUOTED = re.compile(r"«.*»", re.DOTALL)


def redact(text: str) -> str:
    """Message text quoted in journal lines (« … ») is dropped unless content is allowed;
    conversation names stay, they are what makes a trace readable."""
    return text if _state["content"] else _QUOTED.sub("«…»", text)


def content(value: Optional[str]) -> Optional[str]:
    return value if _state["content"] else None


def _clean(attrs: dict) -> dict:
    return {f"trame.{k}": v for k, v in attrs.items() if v is not None}


@contextlib.contextmanager
def span(name: str, **attrs: Any) -> Iterator[Any]:
    tracer = _state["tracer"]
    if tracer is None:
        yield None
        return
    with tracer.start_as_current_span(f"trame.{name}", attributes=_clean(attrs)) as s:
        yield s


def set_attrs(s: Any, **attrs: Any) -> None:
    if s is not None:
        s.set_attributes(_clean(attrs))


def event(level: str, text: str, **attrs: Any) -> None:
    if _state["handler"] is None:
        return
    body = redact(text)
    _logger.log(_LEVELS.get(level, logging.INFO), body, extra={**_clean(attrs), "trame.level": level})
