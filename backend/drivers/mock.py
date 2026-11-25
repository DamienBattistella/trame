from __future__ import annotations
import itertools
import time
from datetime import datetime
from typing import Callable, Iterable, Optional
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

_UNREAD = {
    "19:aa11@thread.v2": ("Sofia Marino", "Tu as vu mon mail sur la recette de jeudi ?", []),
    "19:bb22@thread.v2": ("Lucas Bernard", "J'ai poussé un correctif sur la branche, tu me dis si c'est bon pour toi.", []),
    "19:cc33@thread.v2": ("Sofia Marino", "@Damien on garde le créneau de 14h pour la démo interop ?", ["Damien"]),
    "19:dd44@thread.v2": ("Alerte Prod", "Latence élevée sur le connecteur HL7 depuis 9h12.", []),
    "19:ee55@thread.v2": ("Chiara Rossi", "Bonjour Damien, tu aurais 5 minutes cet après-midi ?", []),
}


class MockTeamsDriver(TeamsDriver):
    def __init__(self, interval: float = 20.0):
        self.interval = interval
        self._convs = [c.model_copy() for c in _SEED]
        self.active_thread: Optional[str] = None
        self.typed: list[tuple[str, str, bool]] = []

    def selftest(self) -> bool:
        return True

    def list_conversations(self) -> list[WatchEntity]:
        return [c.model_copy() for c in self._convs]

    def is_screen_sharing(self) -> bool:
        return False

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        now = datetime.now().strftime("%H:%M")
        return [IncomingMessage(thread_id=thread_id, sender="(contexte)", text="…", received_at=now, surface=Surface.dm)]

    def open_thread(self, thread_id: str) -> bool:
        if not any(c.thread_id == thread_id for c in self._convs):
            return False
        self.active_thread = thread_id
        return True

    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        if self.active_thread != thread_id:
            return False
        self.typed.append((thread_id, text, send))
        action = "ENVOYÉ" if send else "SAISI"
        print(f"[mock] {action} -> {thread_id}: {text[:80]}")
        return True

    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        wanted = set(thread_ids) if thread_ids is not None else None
        now = datetime.now().strftime("%H:%M")
        out: list[IncomingMessage] = []
        for c in self._convs:
            if c.thread_id not in _UNREAD or (wanted is not None and c.thread_id not in wanted):
                continue
            sender, text, mentions = _UNREAD[c.thread_id]
            out.append(IncomingMessage(
                thread_id=c.thread_id, sender=sender, text=text,
                received_at=now, surface=c.surface, mentions=list(mentions),
            ))
        return out

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
