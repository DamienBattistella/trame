from __future__ import annotations
import itertools
import threading
import time
from datetime import datetime
from typing import Callable
from models import IncomingMessage, Surface, WatchEntity
from drivers.base import TeamsDriver

_SEED = [
    WatchEntity(thread_id="19:aa11@thread.v2", display_name="Sofia Marino", surface=Surface.dm, watch=True, mode="auto"),
    WatchEntity(thread_id="19:bb22@thread.v2", display_name="Lucas Bernard", surface=Surface.dm, watch=True, mode="draft"),
    WatchEntity(thread_id="19:cc33@thread.v2", display_name="Équipe Interop", surface=Surface.group, watch=True, mode="draft", named_people=["Sofia Marino"]),
    WatchEntity(thread_id="19:dd44@thread.v2", display_name="#prod-incidents", surface=Surface.channel, watch=False, mode="draft"),
    WatchEntity(thread_id="19:ee55@thread.v2", display_name="Chiara Rossi", surface=Surface.dm, watch=False, mode="draft"),
]

_SCRIPT = [
    ("19:bb22@thread.v2", "Lucas Bernard", "Tu peux relire la PR #214 sur le mapping HL7 ? Je bloque sur le segment OBX.", []),
    ("19:cc33@thread.v2", "Sofia Marino", "@Damien dispo pour un point interop demain 10h ?", ["Damien"]),
    ("19:aa11@thread.v2", "Sofia Marino", "Le build passe de ton côté ?", []),
]


class MockTeamsDriver(TeamsDriver):
    def __init__(self, interval: float = 20.0):
        self.interval = interval
        self._convs = [c.model_copy() for c in _SEED]

    def selftest(self) -> bool:
        return True

    def list_conversations(self) -> list[WatchEntity]:
        return [c.model_copy() for c in self._convs]

    def is_screen_sharing(self) -> bool:
        return False

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        now = datetime.now().strftime("%H:%M")
        return [IncomingMessage(thread_id=thread_id, sender="(contexte)", text="…", received_at=now, surface=Surface.dm)]

    def type_reply(self, thread_id: str, text: str, send: bool) -> None:
        action = "ENVOYÉ" if send else "SAISI"
        print(f"[mock] {action} -> {thread_id}: {text[:80]}")

    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        for thread_id, sender, text, mentions in itertools.cycle(_SCRIPT):
            for _ in range(int(self.interval * 2)):
                if should_stop():
                    return
                time.sleep(0.5)
            on_message(IncomingMessage(
                thread_id=thread_id, sender=sender, text=text,
                received_at=datetime.now().strftime("%H:%M"),
                surface=next((c.surface for c in self._convs if c.thread_id == thread_id), Surface.dm),
                mentions=mentions,
            ))
