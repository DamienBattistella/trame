"""Graph objects (chat, chatMessage, presence) to Trame's models, without guessing:
anything unknown is dropped rather than shown wrong."""
from __future__ import annotations
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, Optional

from models import DELETED_TEXT, REACTIONS, CardRef, FileRef, IncomingMessage, LinkRef, Surface, WatchEntity

MAX_LINKS, MAX_FILES, MAX_CARDS = 20, 10, 5
HOSTED = re.compile(r'<img[^>]+src="(https://graph\.microsoft\.com/v1\.0/chats/[^"]+/hostedContents/[^"/]+/\$value)"',
                    re.IGNORECASE)
WEB_URL = re.compile(r"^https?://[^\s/?#@]+[^\s]*$", re.IGNORECASE)
FILE_HOSTS = re.compile(r"^https://([a-z0-9-]+\.)*(sharepoint\.com|onedrive\.(live\.)?com|1drv\.ms)(/|$)", re.IGNORECASE)

SURFACES = {"oneOnOne": Surface.dm, "group": Surface.group, "meeting": Surface.group}

# Graph presence → Trame presence. Activity is more precise than availability, so it wins.
_ACTIVITY = {
    "InACall": "in_call", "InAConferenceCall": "in_call", "InAMeeting": "in_meeting", "Presenting": "presenting",
    "OutOfOffice": "ooo", "Focusing": "dnd", "UrgentInterruptionsOnly": "dnd",
}
_AVAILABILITY = {
    "Available": "available", "AvailableIdle": "available", "Busy": "busy", "BusyIdle": "busy",
    "DoNotDisturb": "dnd", "BeRightBack": "brb", "Away": "away", "Offline": "offline",
}


def presence(p: Optional[dict]) -> Optional[str]:
    p = p or {}
    return _ACTIVITY.get(str(p.get("activity") or "")) or _AVAILABILITY.get(str(p.get("availability") or ""))


def _one_line(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


class _Html(HTMLParser):
    """chatMessage body (HTML) to plain text, keeping link targets and line breaks."""

    BLOCKS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[LinkRef] = []
        self._href: Optional[str] = None
        self._anchor: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self.BLOCKS:
            self.parts.append("\n")
        if tag == "a":
            href = dict(attrs).get("href") or ""
            self._href, self._anchor = (href if WEB_URL.match(href) else None), []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href is not None:
            text = _one_line("".join(self._anchor), 300) or self._href
            if len(self.links) < MAX_LINKS:
                self.links.append(LinkRef(text=text, url=self._href[:2000]))
            self._href = None
        if tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)
        if self._href is not None:
            self._anchor.append(data)

    def text(self) -> str:
        lines = [" ".join(line.split()) for line in "".join(self.parts).replace(" ", " ").split("\n")]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def body_text(body: Optional[dict]) -> "tuple[str, list[LinkRef]]":
    body = body or {}
    content = str(body.get("content") or "")
    if str(body.get("contentType") or "").lower() != "html":
        return content.strip(), []
    parser = _Html()
    parser.feed(content)
    parser.close()
    return parser.text(), parser.links


def hosted_images(body: Optional[dict]) -> list[str]:
    """Graph URLs of the images pasted in a message (hostedContents), in order."""
    content = str((body or {}).get("content") or "")
    return list(dict.fromkeys(HOSTED.findall(content)))


_DAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
           "novembre", "décembre")


def meeting_when(start: Optional[str], end: Optional[str]) -> str:
    """« mardi 24 novembre 2026 11:00 - 11:45 », as on Teams' recap cards (local time)."""
    try:
        a = datetime.fromisoformat(str(start).replace("Z", "+00:00")).astimezone()
    except ValueError:
        return ""
    out = f"{_DAYS[a.weekday()]} {a.day} {_MONTHS[a.month - 1]} {a.year} {a:%H:%M}"
    try:
        b = datetime.fromisoformat(str(end).replace("Z", "+00:00")).astimezone()
        out += f" - {b:%H:%M}"
    except ValueError:
        pass
    return out


def when(iso: Optional[str], now: Optional[datetime] = None) -> str:
    """« 13:37 » today, « 25/11 13:37 » before: like the times read on the Teams page."""
    if not iso:
        return ""
    try:
        at = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return ""
    now = (now or datetime.now(timezone.utc)).astimezone()
    return at.strftime("%H:%M") if at.date() == now.date() else at.strftime("%d/%m %H:%M")


def _card(att: dict) -> Optional[CardRef]:
    try:
        content = json.loads(att.get("content") or "{}") if isinstance(att.get("content"), str) else (att.get("content") or {})
    except ValueError:
        content = {}
    title = _one_line(content.get("title") or att.get("name") or "", 200)
    url = str(content.get("url") or att.get("contentUrl") or "")
    if not (title or url):
        return None
    source = _one_line(content.get("subtitle") or att.get("contentType", "").rsplit(".", 1)[-1], 40)
    return CardRef(source=source, title=title, url=url if WEB_URL.match(url) else "")


def message(chat_id: str, raw: dict, surface: Surface, me_id: str = "") -> Optional[IncomingMessage]:
    """One chatMessage. System events (members added, call started…) are not messages."""
    if raw.get("messageType") not in (None, "message"):
        return None
    sender = ((raw.get("from") or {}).get("user") or {})
    deleted = bool(raw.get("deletedDateTime"))
    text, links = body_text(raw.get("body"))
    files: list[FileRef] = []
    cards: list[CardRef] = []
    for att in raw.get("attachments") or []:
        kind = str(att.get("contentType") or "")
        if kind == "reference" and len(files) < MAX_FILES:
            url = str(att.get("contentUrl") or "")
            name = _one_line(att.get("name"), 200)
            if name:
                files.append(FileRef(name=name, url=url if FILE_HOSTS.match(url) else ""))
        elif kind.startswith("application/vnd.microsoft.card") and len(cards) < MAX_CARDS:
            card = _card(att)
            if card:
                cards.append(card)
    if not (text or files or cards or deleted):
        return None
    reactions = []
    for r in raw.get("reactions") or []:
        kind = str(r.get("reactionType") or "")
        key = kind if kind in REACTIONS else next((k for k, v in REACTIONS.items() if v == kind), None)
        if key and key not in reactions:
            reactions.append(key)
    return IncomingMessage(
        thread_id=chat_id, sender=_one_line(sender.get("displayName"), 200), text=DELETED_TEXT if deleted else text,
        received_at=when(raw.get("createdDateTime")), surface=surface, id=str(raw.get("id") or "") or None,
        reactions=reactions, files=[] if deleted else files, deleted=deleted,
        links=[] if deleted else links, cards=[] if deleted else cards,
        mentions=[_one_line(((m.get("mentioned") or {}).get("user") or {}).get("displayName"), 200)
                  for m in raw.get("mentions") or [] if ((m.get("mentioned") or {}).get("user") or {}).get("id") == me_id
                  and me_id],
    )


def chat_name(chat: dict, me_id: str) -> str:
    if chat.get("topic"):
        return _one_line(chat["topic"], 200)
    others = [m for m in chat.get("members") or [] if m.get("userId") != me_id]
    return _one_line(", ".join(m.get("displayName") or "" for m in others if m.get("displayName")), 200)


def conversation(chat: dict, me_id: str, rank: int) -> Optional[WatchEntity]:
    name = chat_name(chat, me_id)
    if not name or not chat.get("id"):
        return None
    preview = chat.get("lastMessagePreview") or {}
    mine = ((preview.get("from") or {}).get("user") or {}).get("id") == me_id
    text, _ = body_text(preview.get("body"))
    viewed = ((chat.get("viewpoint") or {}).get("lastMessageReadDateTime") or "")
    unread = bool(preview.get("createdDateTime") and not mine and preview["createdDateTime"] > viewed)
    return WatchEntity(thread_id=chat["id"], display_name=name, surface=SURFACES.get(chat.get("chatType"), Surface.group),
                       rank=rank, last_activity=when(preview.get("createdDateTime")) or None, unread=unread,
                       own_preview=text[:200] if mine and text else None)
