from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Callable, Optional
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
    def type_reply(self, thread_id: str, text: str, send: bool) -> None:
        """Focus the compose box of thread_id, type text; send=True also presses Enter."""

    @abstractmethod
    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        """Block, delivering new messages on watched threads to on_message until should_stop()."""
