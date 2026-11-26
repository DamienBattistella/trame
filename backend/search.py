"""Search in the messages Trame has already read.

Every message the engine reads (a conversation opened in Trame, a reply proposed, a
summary, a message received) is kept here, in memory only: nothing is written to disk
nor sent anywhere, and the archive ends with the engine. Matching ignores case and
accents, like the names of the Entourage (`people._key`)."""
from __future__ import annotations
import threading
import unicodedata
from datetime import datetime
from typing import Callable, Iterable, Optional

from models import IncomingMessage


def _fold_char(c: str) -> str:
    decomposed = unicodedata.normalize("NFD", c)
    return "".join(x for x in decomposed if unicodedata.category(x) != "Mn").casefold()


def fold_map(text: str) -> tuple[str, list[int]]:
    """Text without accents nor case, runs of spaces as one, and for each folded
    character the index of the original character it comes from."""
    out: list[str] = []
    origin: list[int] = []
    for i, c in enumerate(text or ""):
        if c.isspace():
            if out and out[-1] == " ":
                continue
            out.append(" ")
            origin.append(i)
            continue
        for f in _fold_char(c):
            out.append(f)
            origin.append(i)
    return "".join(out), origin


def fold(text: str) -> str:
    return fold_map(text)[0].strip()


def excerpt(flat: str, start: int, end: int, width: int = 140) -> tuple[str, int, int]:
    """A window of `flat` (one-line text) around [start, end), cut on spaces, with « … »
    where something was left out. Returns the excerpt and the match position inside it."""
    if len(flat) <= width:
        return flat, start, end
    lo = max(0, start - max(0, width - (end - start)) // 3)
    hi = min(len(flat), lo + width)
    lo = max(0, min(lo, hi - width))
    if lo > 0:
        cut = flat.find(" ", lo, start)
        lo = cut + 1 if cut != -1 else lo
    if hi < len(flat):
        cut = flat.rfind(" ", end, hi)
        hi = cut if cut != -1 else hi
    prefix = "…" if lo > 0 else ""
    suffix = "…" if hi < len(flat) else ""
    return prefix + flat[lo:hi] + suffix, start - lo + len(prefix), end - lo + len(prefix)


def locate(flat: str, query: str) -> Optional[tuple[int, int]]:
    """Position [start, end) of the folded query in `flat`, None if absent."""
    q = fold(query)
    if len(q) < 2:
        return None
    folded, origin = fold_map(flat)
    pos = folded.find(q)
    if pos == -1:
        return None
    return origin[pos], origin[pos + len(q) - 1] + 1


def hit(thread_id: Optional[str], conversation: str, sender: str, at: str, mine: bool, text: str,
        query: str) -> dict:
    """One search result. `match` is None when the text itself does not contain the
    query (Teams' search also matches word forms): the excerpt is then its beginning."""
    flat = " ".join((text or "").split())
    where = locate(flat, query)
    if where is None:
        snippet = excerpt(flat, 0, 0)[0]
        match = None
    else:
        snippet, s, e = excerpt(flat, *where)
        match = [s, e]
    return {"thread_id": thread_id, "conversation": conversation, "sender": sender, "at": at, "mine": mine,
            "text": text, "excerpt": snippet, "match": match}


class MessageArchive:
    """Messages already read, per conversation, in the order Trame saw them."""

    PER_THREAD = 2000

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._threads: dict[str, dict[tuple[str, str], dict]] = {}
        self._seq = 0
        self.since = datetime.now()

    def add(self, thread_id: str, messages: Iterable[IncomingMessage]) -> None:
        with self._lock:
            bucket = self._threads.setdefault(thread_id, {})
            for m in messages:
                text = (m.text or "").strip()
                if not text:
                    continue
                key = (m.sender or "", text)
                known = bucket.get(key)
                if known is not None:
                    # Teams' own time beats the one noted when the message arrived.
                    if m.received_at:
                        known["at"] = m.received_at
                    continue
                self._seq += 1
                bucket[key] = {"sender": m.sender or "", "text": text, "at": m.received_at or "",
                               "seq": self._seq, "folded": fold(text)}
            while len(bucket) > self.PER_THREAD:
                bucket.pop(next(iter(bucket)))

    def clear(self) -> None:
        with self._lock:
            self._threads.clear()
            self._seq = 0
            self.since = datetime.now()

    def thread_of(self, text: str) -> Optional[str]:
        """The one conversation where this exact message was read, None if none or several."""
        folded = fold(text)
        with self._lock:
            found = {t for t, bucket in self._threads.items() if any(m["folded"] == folded for m in bucket.values())}
        return found.pop() if len(found) == 1 else None

    def scope(self) -> dict:
        with self._lock:
            threads = [b for b in self._threads.values() if b]
            return {"conversations": len(threads), "messages": sum(len(b) for b in threads),
                    "since": self.since.isoformat(timespec="seconds")}

    def search(self, query: str, names: dict[str, str], is_mine: Callable[[str], bool],
               limit: int = 50) -> list[dict]:
        """Messages containing the query, newest seen first. `names` gives each
        conversation's display name (unknown conversations keep their id)."""
        q = fold(query)
        if len(q) < 2:
            return []
        hits: list[tuple[int, dict]] = []
        with self._lock:
            for thread_id, bucket in self._threads.items():
                for m in bucket.values():
                    if q not in m["folded"]:
                        continue
                    hits.append((m["seq"], hit(thread_id, names.get(thread_id, thread_id), m["sender"], m["at"],
                                               is_mine(m["sender"]), m["text"], query)))
        hits.sort(key=lambda h: h[0], reverse=True)
        return [h for _, h in hits[:limit]]

