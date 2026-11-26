from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Optional

from models import Surface

# Teams v2 exposes each chat-list item as one accessibility label, e.g.
#   "Chat Bertrand GAUTHIER Offline Last message voir ça demain 25/11"
#   "Group chat Projet FHIR Has pinned messages Last message Lucas: ok 10:02"
#   "Chat Damien Battistella (You) You: test 04:49"
# The display name sits between the kind prefix and the first status / preview marker.

_PREFIXES: list[tuple[str, Surface]] = [
    ("group chat ", Surface.group),
    ("meeting chat ", Surface.group),
    ("conversation de groupe ", Surface.group),
    ("conversation de réunion ", Surface.group),
    ("conversation de groupe ", Surface.group),
    ("channel ", Surface.channel),
    ("canal ", Surface.channel),
    ("chat ", Surface.dm),
    ("conversation ", Surface.dm),
]

_MARKERS = [
    # presence
    "Available", "Away", "Busy", "Offline", "Do not disturb", "Be right back", "Appear away",
    "Out of office", "In a call", "In a meeting", "Presenting", "Focusing", "Status unknown",
    "Disponible", "Absent", "Occupé", "Hors connexion", "Ne pas déranger", "De retour bientôt",
    "Absent du bureau", "En communication", "En réunion", "En présentation", "Statut inconnu",
    # flags and preview
    "Has pinned messages", "Pinned", "Muted", "Unread", "Has unread messages", "Draft",
    "Contient des messages épinglés", "Épinglé", "Muet", "Non lu", "Messages non lus", "Brouillon",
    "Last message", "Dernier message", "You:", "Vous :", "Vous:",
]
_MARKER_RE = re.compile(r"\s(?:" + "|".join(re.escape(m) for m in sorted(_MARKERS, key=len, reverse=True)) + r")(?=\s|$)")
_UNREAD_RE = re.compile(r"\b(?:unread|non lus?)\b", re.IGNORECASE)
_PREVIEW_RE = re.compile(r"\b(?:Last message|Dernier message)\s+(.*)$")
_TRAILING_TIME_RE = re.compile(r"\s+(?:\d{1,2}:\d{2}|\d{1,2}/\d{1,2}(?:/\d{2,4})?|yesterday|hier|[A-Z][a-z]{2,8})\s*$")
_TIME_RE = re.compile(r"\s(\d{1,2}:\d{2}|\d{1,2}/\d{1,2}(?:/\d{2,4})?|[Yy]esterday|[Hh]ier)\s*$")
# Teams web (« Teams intégré ») gives the visible text of the item instead: no kind
# prefix and no "Last message" marker, only name, time, then the preview.
#   "Romain CUREAU 25/11 je vais préparer ça"
#   "Hexagone 10 - Developers 24/11 Chloé: merci je regarde ça"
#   "Hugo Lannes 25/11"
_WEB_RE = re.compile(r"^(?P<name>.+?)\s+(?P<time>\d{1,2}:\d{2}|\d{1,2}/\d{1,2}(?:/\d{2,4})?|[Yy]esterday|[Hh]ier)(?:\s+(?P<preview>.+))?$")
_WEB_UNREAD_RE = re.compile(r"^(?:Non lus?|Unread)\s+(?=\S)")
_SELF_SENDERS = {"you", "vous", "moi"}
_SELF_RE = re.compile(r"\s*\((?:You|Vous|Moi)\)\s*$")


@dataclass
class RailLabel:
    name: str
    surface: Surface
    unread: bool
    is_self: bool
    preview_sender: Optional[str]
    preview: Optional[str]
    last_time: Optional[str] = None


def parse(label: str) -> RailLabel:
    text = " ".join((label or "").split())
    surface = Surface.dm
    low = text.lower()
    prefixed = False
    for prefix, kind in _PREFIXES:
        if low.startswith(prefix):
            text, surface, prefixed = text[len(prefix):], kind, True
            break
    m = _MARKER_RE.search(text)
    # Teams web puts "Non lu" / "Unread" in front of the name of an unread conversation.
    lead = None if prefixed else _WEB_UNREAD_RE.match(text)
    if lead:
        text = text[lead.end():]
        m = _MARKER_RE.search(text)
    # A marker word found after the time belongs to the preview ("… 10:41 Vous : ok").
    web = None if prefixed else _WEB_RE.match(text)
    if web and m and m.start() < web.end("time"):
        web = None
    if web:
        name, rest = web.group("name"), " " + web.group("time")
    else:
        name, rest = (text[: m.start()], text[m.start():]) if m else (text, "")
    is_self = bool(_SELF_RE.search(name))
    name = _SELF_RE.sub("", name).strip() or text.strip()

    preview_sender, preview = None, None
    p = _PREVIEW_RE.search(rest)
    body = None
    if web:
        body = (web.group("preview") or "").strip() or None
    elif p:
        body = _TRAILING_TIME_RE.sub("", p.group(1)).strip()
    if body is not None:
        who, sep, said = body.partition(":")
        who = who.strip()
        if sep and who.casefold() in _SELF_SENDERS:
            preview_sender, preview = "You", said.strip()
        elif sep and said.startswith(" ") and len(who) <= 60 and " " not in who.replace(" ", "", 2):
            preview_sender, preview = who, said.strip()
        else:
            preview_sender, preview = (name if surface == Surface.dm else None), body
    t = _TIME_RE.search(rest)
    last_time = None
    if t:
        last_time = {"yesterday": "Hier", "hier": "Hier"}.get(t.group(1).lower(), t.group(1))
    return RailLabel(name=name, surface=surface, unread=bool(lead or _UNREAD_RE.search(rest)), is_self=is_self, last_time=last_time,
                     preview_sender=preview_sender, preview=preview or None)


# Rail entries that are navigation, not conversations (Teams v2 chat list headers and
# quick views), in English and French.
_STRUCTURAL = {
    "copilot", "quick views", "mentions", "drafts", "saved", "favorites", "chats", "teams and channels",
    "vues rapides", "brouillons", "enregistré", "enregistrés", "enregistrements", "favoris", "conversations", "équipes et canaux",
}


_COUNTER_RE = re.compile(r"[\d\s+]+")


def is_structural(name: str, aria: str = "") -> bool:
    """Section headers and quick views of the chat list: never a conversation. Neither
    is an entry made of counters only ("3 3", "99+"), as Teams web shows one."""
    flat = " ".join((name or "").split())
    return flat.casefold() in _STRUCTURAL or "expanded=true" in (aria or "").lower() or bool(_COUNTER_RE.fullmatch(flat))


def stable_id(automation_id: str) -> Optional[str]:
    """Teams' own chat id when exposed ("19:…@thread.v2"). React ids such as "menurmh"
    change at every Teams restart and must never identify a conversation."""
    aid = (automation_id or "").replace("chat-list-item_", "")
    return aid if ("@thread" in aid or aid.startswith("19:")) else None


def title_conversation(window_name: str) -> Optional[str]:
    """Open conversation from the window title: "Chat | Romain CUREAU | Microsoft Teams"."""
    parts = [p.strip() for p in (window_name or "").split("|")]
    if len(parts) >= 3 and "teams" in parts[-1].lower():
        name = _SELF_RE.sub("", " | ".join(parts[1:-1])).strip()
        return name or None
    return None


def same_name(a: str, b: str) -> bool:
    return " ".join((a or "").split()).casefold() == " ".join((b or "").split()).casefold()
