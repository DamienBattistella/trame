from __future__ import annotations
from typing import Callable, Iterable, Optional

from drivers import rail_label
from models import IncomingMessage, WatchEntity


class PreviewWatcher:
    """New messages detected from the chat list: the last-message preview of a
    conversation changed and was not written by the user. Shared by the drivers;
    the first pass only records the current state (no flood of old messages)."""

    def __init__(self) -> None:
        self._seen: dict[str, str] = {}
        self._primed = False

    def diff(self, labels: Iterable[tuple[str, str]], conversations: dict[str, WatchEntity]) -> list[IncomingMessage]:
        out: list[IncomingMessage] = []
        current: dict[str, str] = {}
        for thread_id, raw in labels:
            label = rail_label.parse(raw)
            if label.preview is None:
                continue
            # The displayed time changes on its own ("23:41" → "Hier" → "20/11"): only
            # the time of day may tell two identical messages apart.
            clock = label.last_time if label.last_time and ":" in label.last_time else ""
            key = f"{label.preview_sender}|{label.preview}|{clock}"
            current[thread_id] = key
            if not self._primed or self._seen.get(thread_id) == key:
                continue
            # Une ligne que la liste dessine pour la première fois (liste qui défile, conversation
            # sortie de l'écran) n'est nouvelle que si son dernier message est d'aujourd'hui (une
            # heure, pas une date) : jamais l'aperçu d'un message du 10/11 annoncé au démarrage.
            if thread_id not in self._seen and not clock:
                continue
            if self._seen.get(thread_id, "").rsplit("|", 1)[0] == key.rsplit("|", 1)[0] and not clock:
                continue
            if label.preview_sender in (None, "You") or label.is_self:
                continue
            entity = conversations.get(thread_id)
            out.append(IncomingMessage(thread_id=thread_id, sender=label.preview_sender, text=label.preview,
                                       received_at=label.last_time or "",
                                       surface=entity.surface if entity else label.surface))
        self._seen.update(current)
        self._primed = True
        return out
