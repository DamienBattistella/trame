"""Teams presence of the people of 1:1 chats (available, busy, in a meeting…).

Read by the drivers from what Teams already shows in its chat list, never guessed:
a status that cannot be recognised is no status at all, so the UI shows nothing
rather than a wrong dot."""
from __future__ import annotations

import re
from datetime import datetime, timedelta
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

# « Rétablir le statut après » in Teams, in the order of its list. None: no duration
# (the status stays until changed, as with the plain menu).
Duration = Literal["30m", "1h", "2h", "today", "week"]
DURATIONS: tuple[str, ...] = ("30m", "1h", "2h", "today", "week")
DURATION_LABELS: dict[str, str] = {"30m": "30 minutes", "1h": "1 heure", "2h": "2 heures", "today": "aujourd'hui",
                                   "week": "cette semaine"}

# « Personnalisé » in Teams: until a local date and time. Teams lists the times by half
# hour only; Trame keeps it to a few weeks ahead.
UNTIL_MAX_DAYS = 30
_DAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
           "novembre", "décembre")


def parse_until(value: str, now: datetime) -> datetime:
    """The local end of a custom status, "AAAA-MM-JJTHH:MM", checked: on a half hour (as
    Teams offers), in the future, at most UNTIL_MAX_DAYS ahead. ValueError says why not."""
    try:
        at = datetime.strptime(str(value or "").strip(), "%Y-%m-%dT%H:%M")
    except ValueError:
        raise ValueError("Heure de fin illisible (attendu AAAA-MM-JJTHH:MM).") from None
    if at.minute not in (0, 30):
        raise ValueError("Teams ne propose que des heures rondes ou des demi-heures.")
    if at <= now:
        raise ValueError("Cette heure de fin est déjà passée.")
    if at > now + timedelta(days=UNTIL_MAX_DAYS):
        raise ValueError(f"Au plus {UNTIL_MAX_DAYS} jours à l'avance.")
    return at


def until_label(at: datetime, now: datetime) -> str:
    """« 14 h 30 » today, « demain 9 h », else « jeudi 3 décembre 14 h 30 »."""
    hour = f"{at.hour} h {at.minute:02d}" if at.minute else f"{at.hour} h"
    if at.date() == now.date():
        return hour
    if at.date() == (now + timedelta(days=1)).date():
        return f"demain {hour}"
    return f"{_DAYS[at.weekday()]} {at.day} {_MONTHS[at.month - 1]} {hour}"

# Teams limits the status message to 280 characters.
MESSAGE_MAX = 280


# Valeurs du service de présence de Teams (availability / activity) vers celles de Trame.
_SERVICE_ACTIVITY: dict[str, Presence] = {
    "inacall": "in_call", "inaconferencecall": "in_call", "inameeting": "in_meeting",
    "presenting": "presenting", "outofoffice": "ooo", "focusing": "dnd", "urgentinterruptionsonly": "dnd",
}
_SERVICE_AVAILABILITY: dict[str, Presence] = {
    "available": "available", "availableidle": "available", "busy": "busy", "busyidle": "busy",
    "donotdisturb": "dnd", "berightback": "brb", "away": "away", "offline": "offline",
}


def from_service(availability: Optional[str], activity: Optional[str] = None, ooo: bool = False) -> Optional[Presence]:
    """Statut tel que le service de présence le donne : l'activité précise d'abord (en réunion,
    en appel, en présentation), puis la disponibilité. Inconnu (« PresenceUnknown ») : rien."""
    act = str(activity or "").replace(" ", "").casefold()
    if act in _SERVICE_ACTIVITY:
        return _SERVICE_ACTIVITY[act]
    avail = _SERVICE_AVAILABILITY.get(str(availability or "").replace(" ", "").casefold())
    if ooo and avail in (None, "away", "offline", "available"):
        return "ooo"
    return avail


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
