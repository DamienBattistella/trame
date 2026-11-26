from __future__ import annotations
import time
from typing import Callable, Iterable, Optional

from drivers.base import TeamsDriver
from models import IncomingMessage, WatchEntity


class UnavailableDriver(TeamsDriver):
    """Stands in when the real Teams driver cannot load (missing UI Automation, broken
    install). The engine still starts, so the UI shows "Teams non repéré" instead of
    "moteur injoignable"; nothing is read and nothing is ever typed."""

    start_chat_unsupported = "Teams n'est pas repéré"
    search_messages_unsupported = "Teams n'est pas repéré"

    def __init__(self, reason: str):
        self.reason = reason

    def selftest(self) -> bool:
        return False

    def list_conversations(self) -> list[WatchEntity]:
        return []

    def is_screen_sharing(self) -> bool:
        return False

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        return []

    def open_thread(self, thread_id: str) -> bool:
        return False

    def active_thread(self) -> Optional[str]:
        return None

    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        return False

    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        return []

    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        while not should_stop():
            time.sleep(1.0)
