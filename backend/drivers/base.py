from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Callable, Iterable, Optional
from models import IncomingMessage, WatchEntity


class TeamsDriver(ABC):
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
    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        """Type into the compose box of the active conversation, which must still be
        thread_id (re-checked by the driver). False if it cannot confirm it."""

    def type_reply(self, thread_id: str, text: str, send: bool) -> bool:
        """Open thread_id, then type text (send=True also presses Enter). Refuses (False)
        whenever the target conversation cannot be confirmed: never types blind."""
        if not self.open_thread(thread_id):
            return False
        return self._type_into_active(thread_id, text, send)

    @abstractmethod
    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        """Unread incoming messages, optionally restricted to thread_ids (catch-up)."""

    @abstractmethod
    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        """Block, delivering new messages on watched threads to on_message until should_stop()."""
