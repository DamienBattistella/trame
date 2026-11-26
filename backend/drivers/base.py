from __future__ import annotations
from abc import ABC, abstractmethod
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator, Optional
from models import IncomingMessage, WatchEntity


class SendUncertain(RuntimeError):
    """Send was pressed but could not be confirmed: the message may have left."""


@dataclass
class Focus:
    """Outcome of a temporary focus: whether the target was confirmed active, the
    conversation that was open before, and whether it was put back (None: nothing to restore)."""

    ok: bool
    previous: Optional[str] = None
    restored: Optional[bool] = None
    reason: Optional[str] = None


class TeamsDriver(ABC):
    last_error: Optional[str] = None
    """Abstraction over the Teams client. Implemented by MockTeamsDriver (any OS,
    for development) and WindowsUIADriver (real UIA driving, Windows only)."""

    @abstractmethod
    def selftest(self) -> bool:
        """Verify selectors resolve: compose box, message list, chat rail. Gates auto mode."""

    @abstractmethod
    def list_conversations(self) -> list[WatchEntity]:
        """Enumerate the left-rail conversations with stable thread-id + display name."""

    @abstractmethod
    def is_screen_sharing(self) -> bool:
        """True while a Teams screen share is active (auto-pause trigger)."""

    @abstractmethod
    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        """Read the last N messages of a thread (sender carried forward across runs)."""

    @abstractmethod
    def open_thread(self, thread_id: str) -> bool:
        """Make thread_id the active conversation. True only once it is confirmed active."""

    @abstractmethod
    def active_thread(self) -> Optional[str]:
        """Thread id of the conversation currently open in Teams, None if none or unknown."""

    def _current(self) -> Optional[str]:
        try:
            return self.active_thread()
        except Exception:
            return None

    @contextmanager
    def focused(self, thread_id: str, restore: bool = True) -> Iterator[Focus]:
        """Open thread_id for the duration of the block, then (restore=True) reopen the
        conversation the user was looking at. Callers must check `focus.ok` before acting."""
        previous = self._current()
        focus = Focus(ok=False, previous=previous)
        self.last_error = None
        try:
            focus.ok = bool(self.open_thread(thread_id))
        except Exception as e:
            focus.ok = False
            self.last_error = str(e)
        if not focus.ok:
            focus.reason = self.last_error or "conversation pas ouverte ou pas confirmée dans Teams"
        try:
            yield focus
        finally:
            if restore and previous is not None and previous != thread_id and self._current() != previous:
                try:
                    focus.restored = bool(self.open_thread(previous))
                except Exception:
                    focus.restored = False

    def show_thread(self, thread_id: str) -> bool:
        """Bring Teams to the front on this conversation, for the user to read it there.
        Nothing is typed, so no strict confirmation is needed. False if not found."""
        return bool(self.open_thread(thread_id))

    # --- presence ---
    PRESENCE_TTL = 90.0
    """A status read longer ago than this is dropped: Teams stopped saying (window
    closed, relay gone), and no dot beats a stale one."""

    def _note_presence(self, thread_id: str, value: Optional[str]) -> None:
        """Record what Teams shows for thread_id right now (None: nothing recognised)."""
        cache = self.__dict__.setdefault("_presence_cache", {})
        if value:
            cache[thread_id] = (time.monotonic(), value)
        else:
            cache.pop(thread_id, None)

    def presence(self) -> dict[str, str]:
        """Presence of the people of 1:1 chats, by thread id, as last seen in the chat
        list the driver already polls (no extra reading of Teams). Empty when the
        driver cannot tell: the UI then shows no status at all."""
        cache = self.__dict__.get("_presence_cache", {})
        now = time.monotonic()
        return {tid: value for tid, (at, value) in list(cache.items()) if now - at <= self.PRESENCE_TTL}

    def diagnose(self, thread_id: Optional[str] = None) -> dict:
        """Calibration report (structure only, no message text)."""
        return {"driver": type(self).__name__}

    @abstractmethod
    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        """Type into the compose box of the active conversation, which must still be
        thread_id (re-checked by the driver). False if it cannot confirm it."""

    def type_reply(self, thread_id: str, text: str, send: bool, restore: bool = False) -> bool:
        """Open thread_id, then type text (send=True also presses Enter). Refuses (False)
        whenever the target conversation cannot be confirmed: never types blind.
        restore=True reopens the previously active conversation afterwards."""
        return self.type_focused(thread_id, text, send, restore).ok

    def type_focused(self, thread_id: str, text: str, send: bool, restore: bool) -> Focus:
        """Like type_reply but returns the Focus; `ok` is True only if the text was typed."""
        with self.focused(thread_id, restore=restore) as focus:
            if focus.ok:
                try:
                    focus.ok = bool(self._type_into_active(thread_id, text, send))
                    if not focus.ok:
                        focus.reason = "texte non saisi dans Teams"
                except SendUncertain:
                    raise
                except Exception as e:
                    focus.ok, focus.reason = False, str(e)
        return focus

    @abstractmethod
    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        """Unread incoming messages, optionally restricted to thread_ids (catch-up)."""

    @abstractmethod
    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        """Block, delivering new messages on watched threads to on_message until should_stop()."""
