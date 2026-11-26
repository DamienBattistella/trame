"""Relances : les questions que tu as posées et qui sont restées sans réponse.

Trame ne relit rien exprès dans Teams pour ça : il regarde les messages qu'il a déjà vus
(reçus, envoyés, conversations ouvertes). Quand le dernier message d'une conversation est
une question de toi, restée sans réponse depuis plus de N heures ouvrées, le cerveau
confirme qu'elle attend bien une réponse et propose une relance courte dans ta voix.
La relance reste une proposition : elle ne part que sur ton clic.

Heures ouvrées : le samedi et le dimanche ne comptent pas, et rien n'est proposé la nuit
(avant WORK_START ou après WORK_END) ni le week-end.

Suivi gardé sur disque (follow_ups.json dans le dossier de Trame) : un redémarrage ne
remet pas le délai à zéro ni ne fait revenir une relance ignorée."""
from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable, Optional

from search import fold

WORK_START = 8
WORK_END = 19
DEFAULT_DELAY_HOURS = 24
# Au-delà, la conversation est passée à autre chose : plus de relance proposée.
MAX_AGE_DAYS = 14

# Une demande explicite, même sans point d'interrogation. Comparée au texte sans accents
# ni majuscules (search.fold).
_ASK = re.compile(
    r"\?|\b(?:peux[- ]tu|pourrais[- ]tu|pouvez[- ]vous|pourriez[- ]vous|tu peux|vous pouvez|tu pourrais|"
    r"vous pourriez|est[- ]ce que|merci de (?:me|nous)|dis[- ]moi|dites[- ]moi|tiens[- ]moi|tenez[- ]moi|"
    r"des nouvelles|ton avis|votre avis|tu me dis|vous me dites|can you|could you|would you|let me know|"
    r"any update)\b"
)


def is_question(text: str) -> bool:
    """Un message qui pose une question ou fait une demande explicite. Large exprès :
    le cerveau confirme ensuite qu'une réponse est vraiment attendue."""
    flat = fold(text or "")
    return len(flat) >= 4 and bool(_ASK.search(flat))


_HM = re.compile(r"(\d{1,2})[:h](\d{2})")
_DMY = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")


def parse_teams_time(at: str, now: datetime) -> Optional[datetime]:
    """L'heure d'un message telle que Teams l'affiche (« 14:32 », « Hier 09:10 »,
    « 25/11 16:05 », « 25/11/2026 », ou ISO) ; None quand elle ne se lit pas."""
    at = (at or "").strip()
    if not at:
        return None
    try:
        parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
        return parsed.astimezone().replace(tzinfo=None) if parsed.tzinfo else parsed
    except ValueError:
        pass
    low = fold(at)
    hm = _HM.search(low)
    hour, minute = (int(hm.group(1)), int(hm.group(2))) if hm else (12, 0)
    if hour > 23 or minute > 59:
        return None
    dmy = _DMY.search(low)
    if dmy:
        day, month = int(dmy.group(1)), int(dmy.group(2))
        year = int(dmy.group(3)) if dmy.group(3) else now.year
        year += 2000 if year < 100 else 0
        try:
            when = datetime(year, month, day, hour, minute)
        except ValueError:
            return None
        if not dmy.group(3) and when > now + timedelta(days=1):
            when = when.replace(year=year - 1)
        return when
    if not hm:
        return None
    when = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if "hier" in low or "yesterday" in low:
        return when - timedelta(days=1)
    return when - timedelta(days=1) if when > now + timedelta(minutes=5) else when


def business_hours(start: datetime, end: datetime) -> float:
    """Heures écoulées entre start et end, samedi et dimanche non comptés."""
    if end <= start:
        return 0.0
    total = 0.0
    cur = start
    while cur < end:
        nxt = min(end, datetime(cur.year, cur.month, cur.day) + timedelta(days=1))
        if cur.weekday() < 5:
            total += (nxt - cur).total_seconds() / 3600
        cur = nxt
    return total


def working_time(now: datetime) -> bool:
    return now.weekday() < 5 and WORK_START <= now.hour < WORK_END


@dataclass
class Entry:
    """Une question en attente dans une conversation (une seule par conversation : la
    dernière). status : waiting (délai pas atteint, ou cerveau pas encore passé) ;
    ready (relance proposée, visible) ; snoozed (reportée jusqu'à snoozed_until) ;
    ignored (ne plus proposer pour cette question)."""
    id: str
    thread_id: str
    conversation: str
    question: str
    asked_at: str
    status: str = "waiting"
    proposal: str = ""
    snoozed_until: str = ""
    proposed_at: str = ""

    @property
    def key(self) -> str:
        return fold(self.question)


@dataclass
class Seen:
    """Un message tel que le suivi le lit : auteur, texte, heure affichée par Teams."""
    sender: str
    text: str
    at: str = ""
    mine: bool = False


class Tracker:
    def __init__(self, path: Path, clock: Callable[[], datetime] = datetime.now):
        self.path = path
        self.clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, Entry] = {}
        self._load()

    # --- disque ---
    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            for e in raw.get("entries", []):
                entry = Entry(**{k: v for k, v in e.items() if k in Entry.__dataclass_fields__})
                self._entries[entry.thread_id] = entry
        except (OSError, ValueError, TypeError):
            self._entries = {}

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"entries": [asdict(e) for e in self._entries.values()]}, ensure_ascii=False,
                                      indent=1), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            pass

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._save()

    # --- ce que Trame voit passer ---
    def observe(self, thread_id: str, conversation: str, messages: Iterable[Seen]) -> bool:
        """Les messages d'une conversation, du plus ancien au plus récent (un seul message
        reçu ou envoyé, ou un fil relu). Seul le dernier compte : une réponse de l'autre
        clôt la question ; une nouvelle question de toi la remplace ; un message de toi qui
        ne demande rien la clôt aussi (tu es passé à autre chose). True si le suivi change."""
        last = next((m for m in reversed(list(messages)) if (m.text or "").strip()), None)
        if last is None:
            return False
        now = self.clock()
        with self._lock:
            known = self._entries.get(thread_id)
            if not last.mine or not is_question(last.text):
                if known is None:
                    return False
                del self._entries[thread_id]
                self._save()
                return True
            text = " ".join(last.text.split())
            asked = parse_teams_time(last.at, now) or now
            if known is not None and known.key == fold(text):
                # Même question relue : Teams donne parfois une heure plus juste.
                if conversation and known.conversation != conversation:
                    known.conversation = conversation
                    self._save()
                return False
            self._entries[thread_id] = Entry(id=uuid.uuid4().hex[:10], thread_id=thread_id,
                                             conversation=conversation or thread_id, question=text,
                                             asked_at=asked.isoformat(timespec="minutes"))
            self._save()
            return True

    # --- ce qui est à proposer ---
    def due(self, delay_hours: float) -> list[Entry]:
        """Questions à passer au cerveau maintenant : délai atteint en heures ouvrées,
        pendant les heures de travail, ni ignorées, ni déjà proposées, report échu."""
        now = self.clock()
        if not working_time(now):
            return []
        out = []
        with self._lock:
            for e in self._entries.values():
                if e.status == "snoozed":
                    if e.snoozed_until and datetime.fromisoformat(e.snoozed_until) > now:
                        continue
                    if e.proposal:
                        # Reportée après proposition : elle revient telle quelle.
                        e.status, e.snoozed_until = "ready", ""
                        self._save()
                        continue
                elif e.status != "waiting":
                    continue
                asked = datetime.fromisoformat(e.asked_at)
                if now - asked > timedelta(days=MAX_AGE_DAYS):
                    continue
                if business_hours(asked, now) >= delay_hours:
                    out.append(Entry(**asdict(e)))
        return out

    def propose(self, entry_id: str, proposal: str) -> bool:
        with self._lock:
            e = self._by_id(entry_id)
            if e is None:
                return False
            e.status, e.proposal, e.snoozed_until = "ready", proposal.strip(), ""
            e.proposed_at = self.clock().isoformat(timespec="minutes")
            self._save()
            return True

    def ready(self) -> list[Entry]:
        with self._lock:
            items = [Entry(**asdict(e)) for e in self._entries.values() if e.status == "ready"]
        return sorted(items, key=lambda e: e.asked_at)

    def get(self, entry_id: str) -> Optional[Entry]:
        with self._lock:
            e = self._by_id(entry_id)
            return Entry(**asdict(e)) if e else None

    # --- tes gestes ---
    def snooze(self, entry_id: str, hours: float) -> bool:
        with self._lock:
            e = self._by_id(entry_id)
            if e is None:
                return False
            e.status = "snoozed"
            e.snoozed_until = (self.clock() + timedelta(hours=hours)).isoformat(timespec="minutes")
            self._save()
            return True

    def ignore(self, entry_id: str) -> bool:
        """Plus de relance pour cette question. Une nouvelle question la remplacera."""
        with self._lock:
            e = self._by_id(entry_id)
            if e is None:
                return False
            e.status, e.proposal = "ignored", ""
            self._save()
            return True

    def done(self, entry_id: str) -> bool:
        """Relance envoyée (ou mise en file d'envoi) : la question est close. La relance
        elle-même, si elle pose une question, sera suivie à son tour."""
        with self._lock:
            e = self._by_id(entry_id)
            if e is None:
                return False
            del self._entries[e.thread_id]
            self._save()
            return True

    def _by_id(self, entry_id: str) -> Optional[Entry]:
        return next((e for e in self._entries.values() if e.id == entry_id), None)


# --- le cerveau ---
MARKER = "Relance d'une question restée sans réponse."


def build_prompt(soul: str, conversation: str, question: str, asked_at: str, context: list[Seen]) -> str:
    lines = [f"{'Moi' if m.mine else m.sender}: {' '.join(m.text.split())[:400]}" for m in context[-12:]]
    return "\n".join([
        MARKER,
        "J'ai posé la question ci-dessous dans une conversation Teams et personne n'y a répondu depuis.",
        "1. Dis si elle attend vraiment une réponse (pas une formule de politesse, pas une question "
        "rhétorique, pas une question à laquelle le fil répond déjà).",
        "2. Si oui, écris une relance courte (une ou deux phrases), polie et naturelle, dans ma voix "
        "décrite plus bas. Ne recopie pas la question mot pour mot : reformule-la ou rappelle-la brièvement.",
        "Réponds uniquement par un objet JSON : {\"en_attente\": true|false, \"relance\": \"…\"}.",
        "",
        f"Conversation : {conversation}",
        f"Question posée le {asked_at.replace('T', ' à ')} : {question}",
        "",
        "Fil (du plus ancien au plus récent) :",
        *(lines or ["(seulement la question)"]),
        "",
        "Qui je suis :",
        soul.strip() or "(non renseigné)",
    ])


def parse_answer(raw: str, question: str) -> tuple[bool, str]:
    """(attend une réponse, relance). Une réponse illisible n'est pas une confirmation."""
    text = (raw or "").strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError("réponse du cerveau illisible")
    data = json.loads(m.group(0))
    waiting = data.get("en_attente")
    if not isinstance(waiting, bool):
        raise ValueError("réponse du cerveau illisible")
    proposal = " ".join(str(data.get("relance") or "").split())
    if waiting and (not proposal or fold(proposal) == fold(question)):
        raise ValueError("relance vide ou identique à la question")
    return waiting, proposal
