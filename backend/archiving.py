"""Archivage des conversations : âge de la dernière activité et règles de protection.

Rien n'est supprimé : une conversation archivée quitte seulement les sections principales
de Trame, et revient d'elle-même au premier message reçu, comme un chat masqué de Teams.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Iterable, Optional

# Choix proposés dans Réglages › Conversations ; 0 : jamais d'archivage automatique.
AFTER_DAYS = (0, 7, 14, 30, 90)

_TIME = re.compile(r"^\d{1,2}:\d{2}$")
_DAY_MONTH = re.compile(r"^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?$")
_WEEKDAYS = {
    "lun": 0, "mar": 1, "mer": 2, "jeu": 3, "ven": 4, "sam": 5, "dim": 6,
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}


def label_date(label: Optional[str], today: date) -> Optional[date]:
    """Jour de la dernière activité d'après l'heure que Teams affiche dans sa liste :
    « 09:31 » (aujourd'hui), « Hier », « mar. » (cette semaine), « 25/11 », « 25/11/25 ».
    None quand le libellé ne dit rien de sûr : on n'archive jamais sur une supposition."""
    text = (label or "").strip().casefold().rstrip(".")
    if not text:
        return None
    if _TIME.match(text):
        return today
    if text in ("hier", "yesterday"):
        return today - timedelta(days=1)
    head = text[:3]
    if head in _WEEKDAYS and text.isalpha():
        back = (today.weekday() - _WEEKDAYS[head]) % 7 or 7
        return today - timedelta(days=back)
    m = _DAY_MONTH.match(text)
    if not m:
        return None
    day, month, year = int(m.group(1)), int(m.group(2)), m.group(3)
    try:
        if year:
            y = int(year)
            return date(y + 2000 if y < 100 else y, month, day)
        found = date(today.year, month, day)
    except ValueError:
        return None
    # Sans année, une date « à venir » est celle de l'an dernier.
    return found if found <= today else found.replace(year=today.year - 1)


def last_activity(label: Optional[str], seen: Optional[datetime], now: datetime) -> Optional[date]:
    """Le plus récent de ce que Teams affiche et de ce que Trame a vu passer."""
    days = [d for d in (label_date(label, now.date()), seen.date() if seen else None) if d is not None]
    return max(days) if days else None


def protected(thread_id: str, *, favorites: Iterable[str], drafts: Iterable[str], follow_ups: Iterable[str],
              auto: bool) -> Optional[str]:
    """Pourquoi l'archivage automatique doit laisser cette conversation, ou None.
    Une conversation en mode Auto n'est jamais coupée en silence."""
    if thread_id in set(favorites):
        return "favori"
    if thread_id in set(drafts):
        return "réponse à relire"
    if thread_id in set(follow_ups):
        return "relance en cours"
    if auto:
        return "mode Auto"
    return None


def is_stale(activity: Optional[date], after_days: int, today: date) -> bool:
    """Sans activité depuis au moins after_days jours. Jamais quand l'âge est inconnu."""
    return bool(after_days) and activity is not None and (today - activity).days >= after_days
