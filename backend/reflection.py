"""What the model does during an action launched from the reply box (Corriger,
Vérifier, Proposer une réponse): Trame's steps, the model's own reasoning when the
brain streams it, then the result and the duration.

Local only: runs live in memory, go to the UI over the WebSocket, and never reach the
journal nor Teams. Telemetry gets counts, and the reasoning text only when message
content is allowed there (telemetry.content)."""
from __future__ import annotations
import contextlib
import contextvars
import itertools
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Iterator, Literal, Optional

import telemetry

Kind = Literal["step", "thinking", "error"]
Status = Literal["running", "done", "error", "cancelled"]

TITLES = {"correct": "Corriger", "check": "Vérifier", "suggest": "Proposer une réponse",
          "reply": "Réponse à un message reçu"}
MAX_RUNS = 20
MAX_THINKING_CHARS = 60_000


class Cancelled(RuntimeError):
    """The user stopped the action from the panel."""


@dataclass
class Step:
    at_ms: int
    kind: Kind
    text: str
    # A step with a key is updated in place by the next one with the same key (a counter).
    key: Optional[str] = None


@dataclass
class Run:
    id: str
    action: str
    title: str
    thread_id: Optional[str]
    conversation: Optional[str]
    provider: str
    model: str
    started_at: str
    status: Status = "running"
    steps: list[Step] = field(default_factory=list)
    result: str = ""
    duration_ms: Optional[int] = None
    reasoning: bool = False
    rev: int = 0
    _t0: float = field(default_factory=time.monotonic, repr=False)
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    _on_cancel: list[Callable[[], None]] = field(default_factory=list, repr=False)
    _registry: Optional["Reflections"] = field(default=None, repr=False)

    def elapsed(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    def as_dict(self) -> dict:
        return {
            "id": self.id, "action": self.action, "title": self.title, "threadId": self.thread_id,
            "conversation": self.conversation, "provider": self.provider, "model": self.model,
            "startedAt": self.started_at, "status": self.status, "result": self.result,
            "durationMs": self.duration_ms, "reasoning": self.reasoning, "rev": self.rev,
            "steps": [{"atMs": s.at_ms, "kind": s.kind, "text": s.text} for s in self.steps],
        }


_current: contextvars.ContextVar[Optional[Run]] = contextvars.ContextVar("trame_reflection", default=None)


class Reflections:
    """The last runs, newest first. Every change bumps `seq` (and the run's `rev`): the
    WebSocket sends a run again only when it changed."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: list[Run] = []
        self._ids = itertools.count(1)
        self.seq = 0

    def _touch(self, run: Run) -> None:
        run.rev += 1
        self.seq += 1

    def snapshot(self) -> list[dict]:
        with self._lock:
            return [r.as_dict() for r in self._runs]

    def running(self) -> bool:
        with self._lock:
            return any(r.status == "running" for r in self._runs)

    def changed_since(self, revs: dict[str, int]) -> list[dict]:
        """Runs whose revision differs from `revs` (id -> rev), oldest first."""
        with self._lock:
            return [r.as_dict() for r in reversed(self._runs) if revs.get(r.id) != r.rev]

    def cancel(self, run_id: str) -> bool:
        with self._lock:
            run = next((r for r in self._runs if r.id == run_id), None)
            if run is None or run.status != "running" or run._cancel.is_set():
                return False
            run._cancel.set()
            hooks = list(run._on_cancel)
            run.steps.append(Step(run.elapsed(), "step", "Annulation demandée"))
            self._touch(run)
        for hook in hooks:
            try:
                hook()
            except Exception:
                pass
        return True

    @contextlib.contextmanager
    def track(self, action: str, provider: str, model: str = "", thread_id: Optional[str] = None,
              conversation: Optional[str] = None) -> Iterator[Run]:
        """The action runs inside: steps and reasoning emitted by the watcher and the
        brain in this context land on this run."""
        run = Run(id=f"r{next(self._ids)}", action=action, title=TITLES.get(action, action), thread_id=thread_id,
                  conversation=conversation, provider=provider, model=model,
                  started_at=datetime.now().strftime("%H:%M:%S"), _registry=self)
        with self._lock:
            self._runs.insert(0, run)
            # Only finished runs leave the history: a running one stays cancellable.
            while len(self._runs) > MAX_RUNS and any(r.status != "running" for r in self._runs):
                old = next(r for r in reversed(self._runs) if r.status != "running")
                self._runs.remove(old)
            self._touch(run)
        token = _current.set(run)
        try:
            yield run
        except BaseException as e:
            with self._lock:
                run.status = "cancelled" if run._cancel.is_set() else "error"
                text = "Action annulée" if run.status == "cancelled" else _reason(e)
                run.steps.append(Step(run.elapsed(), "error", text))
                run.duration_ms = run.elapsed()
                self._touch(run)
            _report(run)
            raise
        else:
            with self._lock:
                run.status = "done"
                run.duration_ms = run.elapsed()
                self._touch(run)
            _report(run)
        finally:
            _current.reset(token)

    def _append(self, run: Run, kind: Kind, text: str, key: Optional[str] = None) -> None:
        with self._lock:
            last = run.steps[-1] if run.steps else None
            if key and last is not None and last.key == key:
                last.text = text
            elif kind == "thinking" and last is not None and last.kind == "thinking":
                if len(last.text) < MAX_THINKING_CHARS:
                    last.text = (last.text + text)[:MAX_THINKING_CHARS]
            else:
                run.steps.append(Step(run.elapsed(), kind, text, key))
            if kind == "thinking":
                run.reasoning = True
            self._touch(run)

    def _set_result(self, run: Run, text: str) -> None:
        with self._lock:
            run.result = text
            self._touch(run)


def _reason(e: BaseException) -> str:
    return str(getattr(e, "message", "") or e or type(e).__name__)[:300]


def _report(run: Run) -> None:
    thinking = "".join(s.text for s in run.steps if s.kind == "thinking")
    telemetry.event(
        "info" if run.status == "done" else "warn",
        f"Réflexion ({run.title}) : {run.status}, {len(run.steps)} étape(s) en {run.duration_ms} ms",
        action=run.action, provider=run.provider, model=run.model or None, status=run.status,
        duration_ms=run.duration_ms, thinking_chars=len(thinking),
        thinking=telemetry.content(thinking) if thinking else None,
    )


# --- emitted from inside a tracked action (no-ops anywhere else) ---

def current() -> Optional[Run]:
    return _current.get()


def active() -> bool:
    return _current.get() is not None


def step(text: str, key: Optional[str] = None) -> None:
    run = _current.get()
    if run is not None:
        run._registry._append(run, "step", text, key)


def thinking(chunk: str) -> None:
    run = _current.get()
    if run is not None and chunk:
        run._registry._append(run, "thinking", chunk)


def result(text: str) -> None:
    run = _current.get()
    if run is not None:
        run._registry._set_result(run, text[:2000])


def cancelled() -> bool:
    run = _current.get()
    return run is not None and run._cancel.is_set()


def check_cancelled() -> None:
    if cancelled():
        raise Cancelled("Action annulée")


def on_cancel(hook: Callable[[], None]) -> Callable[[], None]:
    """Run `hook` (kill a brain process) if the user cancels; returns the unregister."""
    run = _current.get()
    if run is None:
        return lambda: None
    run._on_cancel.append(hook)
    if run._cancel.is_set():
        hook()

    def remove() -> None:
        with contextlib.suppress(ValueError):
            run._on_cancel.remove(hook)
    return remove
