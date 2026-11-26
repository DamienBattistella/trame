"""Teams presence of the people of 1:1 chats (available, busy, in a meeting…).

Read by the drivers from what Teams already shows in its chat list, never guessed:
a status that cannot be recognised is no status at all, so the UI shows nothing
rather than a wrong dot."""
from __future__ import annotations

import re
from typing import Literal, Optional

Presence = Literal["available", "busy", "in_call", "in_meeting", "presenting", "dnd", "brb", "away", "ooo", "offline"]

# Teams wording, English and French, to Trame's canonical value. "Status unknown" /
# "Statut inconnu" is deliberately absent: unknown is shown as nothing.
_WORDS: dict[str, Presence] = {
    "available": "available", "disponible": "available",
    "busy": "busy", "occupé": "busy", "occupe": "busy",
    "in a call": "in_call", "en communication": "in_call", "en appel": "in_call",
    "in a meeting": "in_meeting", "en réunion": "in_meeting", "en reunion": "in_meeting",
    "presenting": "presenting", "en présentation": "presenting", "en presentation": "presenting",
    "do not disturb": "dnd", "ne pas déranger": "dnd", "ne pas deranger": "dnd",
    "focusing": "dnd", "concentration": "dnd",
    "be right back": "brb", "de retour bientôt": "brb", "de retour bientot": "brb",
    "away": "away", "appear away": "away", "absent": "away", "absent(e)": "away", "apparaître absent": "away",
    "out of office": "ooo", "absent du bureau": "ooo",
    "offline": "offline", "appear offline": "offline", "hors connexion": "offline", "hors ligne": "offline",
}

# Words as they appear inside a Teams accessibility label (UIA rail), longest first so
# "Absent du bureau" wins over "Absent".
WORDS = sorted(_WORDS, key=len, reverse=True)

LABELS: dict[str, str] = {
    "available": "Disponible",
    "busy": "Occupé",
    "in_call": "En appel",
    "in_meeting": "En réunion",
    "presenting": "En présentation",
    "dnd": "Ne pas déranger",
    "brb": "De retour bientôt",
    "away": "Absent",
    "ooo": "Absent du bureau",
    "offline": "Hors ligne",
}

# Statuses where the person reads between two things: the brain keeps it short.
_BUSY: set[str] = {"in_meeting", "in_call", "presenting", "dnd", "busy"}

_PREFIX_RE = re.compile(r"^(?:status|statut|presence|présence)\s*[:\-]?\s*", re.IGNORECASE)


def from_label(raw: Optional[str]) -> Optional[Presence]:
    """Canonical presence for a Teams wording ("In a meeting", "Statut : En réunion",
    "Available, Busy until 3pm"…); None when it is not a known status."""
    text = " ".join((raw or "").split()).strip(" .,;").casefold()
    if not text or len(text) > 60:
        return None
    text = _PREFIX_RE.sub("", text)
    if text in _WORDS:
        return _WORDS[text]
    # Teams may add a detail after a comma or a dash ("Busy, until 15:00").
    head = re.split(r"\s*[,–—(]\s*|\s+-\s+", text, maxsplit=1)[0].strip()
    return _WORDS.get(head)


def first_of(candidates) -> Optional[Presence]:
    """First recognised status among several labels read near an avatar."""
    for c in candidates or []:
        found = from_label(c if isinstance(c, str) else None)
        if found:
            return found
    return None


def brain_hint(name: str, presence: Optional[str]) -> str:
    """One line for the brain when the person is busy right now, else nothing. It only
    shapes the reply (shorter): nothing else is ever sent because of it."""
    if presence not in _BUSY:
        return ""
    return (f"Présence Teams de {name} en ce moment : {LABELS[presence]}. "
            "Fais court, l'essentiel d'abord, sans question qui appelle un long échange.")


# --- the user's own status, chosen from Trame ---
# What Teams offers in its status menu (« Apparaître absent / hors ligne » are away and
# offline), plus « Réinitialiser le statut », which lets Teams decide again.
Choice = Literal["available", "busy", "dnd", "brb", "away", "offline", "reset"]
CHOICES: tuple[str, ...] = ("available", "busy", "dnd", "brb", "away", "offline", "reset")

# Teams limits the status message to 280 characters.
MESSAGE_MAX = 280


def own_from_labels(candidates) -> Optional[Presence]:
    """The user's status from what the profile button says: « Votre profil, statut Ne
    pas déranger », « Your profile, status Available », or the badge (« do not disturb »)."""
    out = []
    for c in candidates or []:
        if not isinstance(c, str):
            continue
        m = re.search(r"\b(?:statut|status)\b\s*[:\-]?\s*(.+)$", c, re.IGNORECASE)
        out.append(m.group(1) if m else c)
    return first_of(out)
