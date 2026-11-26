"""Activity journal kept across restarts, for the « Activité » panel and its search.

The state stream only carries the last 200 lines of this session. Every line is also
appended to `journal.jsonl` in the Trame folder so older activity stays searchable.
Message text quoted « … » is masked on disk unless content is allowed in telemetry
(`telemetry.redact`): only this session's lines, kept in memory, show it. The file is
bounded: past twice `max_entries` lines it is rewritten with the last `max_entries`.
Matching ignores case and accents, like the search in messages (`search.fold`)."""
from __future__ import annotations
import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

import telemetry
from models import LogItem
from search import fold

LEVELS = ("info", "warn", "sent", "draft")


class Journal:
    def __init__(self, path: Path, max_entries: int = 5000):
        self.path = path  # already a Path: no Path() here, tests fake os.name
        self.max_entries = max_entries
        self._lock = threading.Lock()
        self._lines_on_disk = 0
        self._entries: list[LogItem] = self._load()

    def _load(self) -> list[LogItem]:
        try:
            with open(self.path, encoding="utf-8", errors="replace") as f:
                raw = f.readlines()
        except OSError:
            return []
        self._lines_on_disk = len(raw)
        out: list[LogItem] = []
        for line in raw[-self.max_entries:]:
            try:
                d = json.loads(line)
                if d.get("level") in LEVELS:
                    out.append(LogItem(ts=d["ts"], at=d["ts"][11:19], level=d["level"], text=str(d.get("text", ""))))
            except (ValueError, KeyError, TypeError):
                continue
        return out

    def append(self, item: LogItem) -> None:
        line = json.dumps({"ts": item.ts, "level": item.level, "text": telemetry.redact(item.text)}, ensure_ascii=False)
        with self._lock:
            self._entries.append(item)
            if len(self._entries) > self.max_entries:
                del self._entries[: len(self._entries) - self.max_entries]
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self._lines_on_disk >= 2 * self.max_entries:
                    self._compact()
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
                self._lines_on_disk += 1
            except OSError:
                pass  # the journal is a convenience: never break the engine for it

    def _compact(self) -> None:
        keep = self._entries[:-1][-(self.max_entries - 1):]
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            for e in keep:
                f.write(json.dumps({"ts": e.ts, "level": e.level, "text": telemetry.redact(e.text)}, ensure_ascii=False) + "\n")
        tmp.replace(self.path)
        self._lines_on_disk = len(keep)

    def clear(self) -> None:
        with self._lock:
            self._entries = []
            self._lines_on_disk = 0
            self.path.unlink(missing_ok=True)

    def query(self, q: str = "", levels: Optional[Iterable[str]] = None, since: Optional[str] = None,
              before: Optional[str] = None, limit: int = 100) -> dict:
        """Newest first. `since` / `before` are ISO datetimes (`before` is the paging
        cursor: the `ts` of the last line already shown). Returns the page, the number
        of matching lines in all, and the cursor of the next page (None at the end)."""
        needle = fold(q or "")
        wanted = set(levels or LEVELS)
        with self._lock:
            entries = list(self._entries)
        matches = [e for e in reversed(entries)
                   if e.level in wanted
                   and (not since or e.ts >= since)
                   and (not needle or needle in fold(e.text))]
        total = len(matches)
        if before:
            matches = [e for e in matches if e.ts < before]
        page = matches[:limit]
        return {"items": page, "total": total,
                "next": page[-1].ts if len(matches) > limit else None,
                "oldest": entries[0].ts if entries else None}


def now_item(level: str, text: str) -> LogItem:
    now = datetime.now()
    return LogItem(ts=now.isoformat(timespec="microseconds"), at=now.strftime("%H:%M:%S"), level=level, text=text)


def local_iso(raw: Optional[str]) -> Optional[str]:
    """A datetime from the UI or a tool as the journal writes them: local time, no zone
    (`2026-11-26T14:02:11`), so that comparing the strings compares the moments."""
    if not raw:
        return None
    try:
        d = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is not None:
        d = d.astimezone().replace(tzinfo=None)
    return d.isoformat(timespec="microseconds")


def parse_levels(raw: Optional[str]) -> list[str]:
    return [l for l in (raw or "").split(",") if l in LEVELS] or list(LEVELS)
