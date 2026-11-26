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
            key = f"{label.preview_sender}|{label.preview}|{label.last_time}"
            current[thread_id] = key
            if not self._primed or self._seen.get(thread_id) == key:
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
