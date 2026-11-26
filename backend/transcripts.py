"""Transcriptions des réunions Teams, enregistrées en WebVTT.

Teams web affiche la transcription d'une réunion terminée dans l'onglet « Transcript »
de son récapitulatif (une iframe SharePoint). Seuls l'organisateur et les
co-organisateurs peuvent la télécharger ; les autres participants la lisent. Trame
relit donc les entrées affichées (orateur, horodatage de début, texte) et en refait
un fichier .vtt au format des transcriptions Teams, lisible par le skill
`meeting-report` : en-tête `WEBVTT`, une note avec la date et le titre, puis un bloc
`HH:MM:SS.mmm --> HH:MM:SS.mmm` et `<v Orateur>texte</v>` par prise de parole.

Le fichier reste sur le poste, dans le dossier choisi (par défaut
Documents\\Trame\\Transcriptions) : rien n'est envoyé ailleurs.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Optional

MAX_ENTRIES = 20_000
MAX_TEXT = 4_000
MAX_SPEAKER = 120
# Teams ne donne que le début d'une prise de parole : elle dure jusqu'à la suivante,
# au plus ce temps-là (une longue pause n'est pas de la parole).
MAX_CUE_SECONDS = 30.0
MIN_CUE_SECONDS = 1.0


class TranscriptError(ValueError):
    pass


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    speaker: str
    text: str


# --- horodatages ---------------------------------------------------------------
_CLOCK = re.compile(r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$")
# Libellé d'accessibilité : « 1 heure 2 minutes 29 secondes », « 1 minute 29 seconds ».
_SPOKEN = re.compile(r"(\d+)\s*(heures?|hours?|h\b|minutes?|min\b|secondes?|seconds?|s\b)", re.I)


def parse_offset(raw: str) -> Optional[float]:
    """Secondes depuis le début de la réunion, depuis « 1:29 », « 01:02:03 » ou un
    libellé parlé ; None si rien n'y ressemble."""
    s = " ".join((raw or "").split())
    m = _CLOCK.match(s)
    if m:
        h, mi, se = int(m.group(1) or 0), int(m.group(2)), int(m.group(3))
        if se >= 60 or (m.group(1) is not None and mi >= 60):
            return None
        return float(h * 3600 + mi * 60 + se)
    total, found = 0, False
    for n, unit in _SPOKEN.findall(s):
        u = unit.lower()
        total += int(n) * (3600 if u.startswith("h") else 60 if u.startswith("min") else 1)
        found = True
    return float(total) if found else None


def format_timestamp(seconds: float) -> str:
    """HH:MM:SS.mmm, comme les .vtt de Teams."""
    ms = max(0, int(round(seconds * 1000)))
    h, rest = divmod(ms, 3_600_000)
    m, rest = divmod(rest, 60_000)
    s, ms = divmod(rest, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


# --- entrées relues dans Teams -> prises de parole -------------------------------
def _clean(s: Any, limit: int) -> str:
    text = " ".join(str(s or "").replace("​", "").replace("⁠", "").split())
    return text[:limit]


def cues_from_entries(raw: Iterable[Any]) -> list[Cue]:
    """Les entrées telles que l'iframe les lit ({speaker, time, text, aria}). Une entrée
    sans orateur ni horodatage prolonge la précédente (même orateur, Teams ne répète
    pas l'en-tête) ; une entrée vide est ignorée. Les horodatages vont croissant."""
    out: list[dict] = []
    for e in list(raw or [])[:MAX_ENTRIES]:
        if not isinstance(e, dict):
            continue
        text = _clean(e.get("text"), MAX_TEXT)
        speaker = _clean(e.get("speaker"), MAX_SPEAKER)
        start = parse_offset(_clean(e.get("time"), 40))
        if start is None:
            start = parse_offset(_clean(e.get("aria"), 200))
        if speaker and text.startswith(speaker + " "):
            text = text[len(speaker) + 1:]
        if not text:
            continue
        if out and (not speaker or speaker == out[-1]["speaker"]) and (start is None or start == out[-1]["start"]):
            out[-1]["text"] = f"{out[-1]['text']} {text}"[:MAX_TEXT]
            continue
        if start is None:
            start = out[-1]["start"] if out else 0.0
        if out and start < out[-1]["start"]:
            start = out[-1]["start"]
        out.append({"start": start, "speaker": speaker or (out[-1]["speaker"] if out else ""), "text": text})
    cues = []
    for i, c in enumerate(out):
        nxt = out[i + 1]["start"] if i + 1 < len(out) else None
        # La dernière : sa durée est estimée au débit de parole (~2,5 mots par seconde).
        spoken = len(c["text"].split()) / 2.5
        end = min(nxt if nxt is not None else c["start"] + spoken, c["start"] + MAX_CUE_SECONDS)
        cues.append(Cue(c["start"], max(end, c["start"] + MIN_CUE_SECONDS), c["speaker"], c["text"]))
    return cues


# --- WebVTT -----------------------------------------------------------------------
def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _note(s: str) -> str:
    # Une note ne peut contenir « --> » ni de ligne vide.
    return " ".join(s.replace("-->", "->").split())


def build_vtt(cues: Iterable[Cue], title: str = "", day: Optional[date] = None, when: str = "",
              organizer: str = "") -> str:
    lines = ["WEBVTT", ""]
    meta = [f"Date: {day.isoformat()}" if day else "", f"Titre: {_note(title)}" if title.strip() else "",
            f"Réunion: {_note(when)}" if when.strip() else "",
            f"Organisateur: {_note(organizer)}" if organizer.strip() else "",
            "Source: transcription Teams relue par Trame (horodatages de début, fins estimées)"]
    lines += ["NOTE", *[m for m in meta if m], ""]
    for i, c in enumerate(cues, 1):
        speaker = _escape(c.speaker.replace(">", " ").strip())
        body = _escape(c.text)
        lines += [str(i), f"{format_timestamp(c.start)} --> {format_timestamp(c.end)}",
                  f"<v {speaker}>{body}</v>" if speaker else body, ""]
    return "\n".join(lines)


_CUE_TIME = re.compile(r"^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})(\s.*)?$")
_VOICE = re.compile(r"^<v(?:\.[^ >]+)* ([^>]+)>(.*?)(?:</v>)?$", re.S)


def parse_vtt(text: str) -> list[Cue]:
    """Relit un .vtt (celui de Trame ou un export Teams). Lève TranscriptError si le
    fichier n'est pas du WebVTT : sert aux tests et à vérifier ce qui est écrit."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or not lines[0].lstrip("﻿").startswith("WEBVTT"):
        raise TranscriptError("en-tête WEBVTT absent")
    cues: list[Cue] = []
    blocks, cur = [], []
    for ln in lines[1:]:
        if ln.strip():
            cur.append(ln)
        elif cur:
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)
    unescape = lambda s: s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    for b in blocks:
        if b[0].startswith("NOTE") or b[0].startswith("STYLE") or b[0].startswith("REGION"):
            continue
        at = next((i for i, ln in enumerate(b) if "-->" in ln), None)
        if at is None or at > 1:
            raise TranscriptError(f"bloc sans horodatage : {b[0][:60]!r}")
        m = _CUE_TIME.match(b[at].strip())
        if not m:
            raise TranscriptError(f"horodatage invalide : {b[at][:60]!r}")
        g = [int(x) for x in m.groups()[:8]]
        start = round(g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000, 3)
        end = round(g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000, 3)
        if end < start:
            raise TranscriptError(f"fin avant le début : {b[at]!r}")
        payload = "\n".join(b[at + 1:])
        v = _VOICE.match(payload)
        speaker, body = (v.group(1).strip(), v.group(2)) if v else ("", payload)
        cues.append(Cue(start, end, unescape(speaker), unescape(body)))
    return cues


# --- date et nom du fichier -------------------------------------------------------
_MONTHS = {
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7, "aout": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}


def _fold(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFD", s) if unicodedata.category(ch) != "Mn").lower()


def parse_meeting_date(when: str, today: Optional[date] = None) -> Optional[date]:
    """La date d'une carte Teams : « mardi 24 novembre 2026 11:00 - 11:45 »,
    « Tuesday, November 24, 2026 », « 24/11/2026 ». Sans année, l'année en cours."""
    s = _fold(" ".join((when or "").split()))
    m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    months = "|".join(_MONTHS)
    m = re.search(rf"\b(\d{{1,2}})(?:er)?\s+({months})\.?(?:\s+(\d{{4}}))?", s) or None
    day_month = (int(m.group(1)), _MONTHS[m.group(2)], m.group(3)) if m else None
    if not day_month:
        m = re.search(rf"\b({months})\.?\s+(\d{{1,2}})(?:,?\s+(\d{{4}}))?", s)
        day_month = (int(m.group(2)), _MONTHS[m.group(1)], m.group(3)) if m else None
    if not day_month:
        return None
    d, mo, y = day_month
    try:
        return date(int(y) if y else (today or date.today()).year, mo, d)
    except ValueError:
        return None


_SLOT = re.compile(r"\b(\d{1,2})[:h.](\d{2})\s*([ap]\.?m\.?)?\s*[-–—]\s*(\d{1,2})[:h.](\d{2})\s*([ap]\.?m\.?)?", re.I)


def _clock(h: str, m: str, ampm: Optional[str]) -> Optional[str]:
    hour, minute = int(h), int(m)
    if ampm:
        pm = ampm.lower().startswith("p")
        if not 1 <= hour <= 12:
            return None
        hour = (hour % 12) + (12 if pm else 0)
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def parse_meeting_slot(when: str) -> tuple[Optional[str], Optional[str]]:
    """Début et fin d'un créneau Teams (« … 11:00 - 11:45 », « 9:00 AM - 9:30 AM »), en HH:MM ;
    (None, None) si le créneau n'a pas d'heures lisibles."""
    m = _SLOT.search(" ".join((when or "").split()))
    if not m:
        return None, None
    end_ampm = m.group(6)
    start = _clock(m.group(1), m.group(2), m.group(3) or end_ampm)
    end = _clock(m.group(4), m.group(5), end_ampm)
    return (start, end) if start and end else (None, None)


def meeting_id(thread_id: str, mid: str) -> str:
    """Un seul identifiant pour une occurrence : la conversation de réunion et sa carte."""
    return f"{thread_id}#{mid}"


def split_meeting_id(raw: str) -> tuple[str, str]:
    thread_id, sep, mid = (raw or "").strip().rpartition("#")
    if not sep or not thread_id or not re.fullmatch(r"[0-9A-Za-z_-]{1,40}", mid):
        raise TranscriptError("meeting_id invalide : prends-le dans list_meetings.")
    return thread_id, mid


# Le OneDrive qui porte la transcription est celui de l'organisateur :
# /personal/prenom_nom_entreprise_fr/ -> « Prenom Nom ».
_OWNER = re.compile(r"^[a-z0-9-]+(?:_[a-z0-9-]+)+$", re.I)


def owner_name(segment: str) -> str:
    s = (segment or "").strip().strip("/")
    if not _OWNER.match(s):
        return ""
    parts = s.split("_")
    if len(parts) < 3:
        return ""
    words = parts[:-2]
    return " ".join("-".join(w.capitalize() for w in p.split("-")) for p in words)[:MAX_SPEAKER]


_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def file_name(title: str, day: Optional[date]) -> str:
    """« 2026-11-24 Migration weekly.vtt » : sans caractère interdit sous Windows,
    sans point ni espace final, raisonnablement court."""
    clean = " ".join(_FORBIDDEN.sub(" ", title or "").split()).strip(" .")[:90].strip(" .")
    if not clean or clean.lower() in _RESERVED:
        clean = "Réunion"
    return f"{day.isoformat()} {clean}.vtt" if day else f"{clean}.vtt"


def saved_file(directory: Path, title: str, day: Optional[date]) -> Optional[Path]:
    """Le .vtt déjà enregistré pour cette réunion dans ce dossier (même nom que save), sinon None."""
    path = directory / file_name(title, day)
    try:
        return path if path.is_file() else None
    except OSError:
        return None


def check_vtt_file(raw: str) -> Path:
    """Un .vtt à ouvrir ou montrer : chemin absolu local d'un fichier .vtt existant, rien d'autre
    (jamais un exécutable ni un partage réseau)."""
    s = (raw or "").strip().strip('"')
    if not s or len(s) > 600 or "\x00" in s or s.startswith("\\\\") or s.startswith("//"):
        raise TranscriptError("Fichier invalide.")
    path = Path(s)
    if not path.is_absolute() or path.suffix.lower() != ".vtt":
        raise TranscriptError("Seule une transcription .vtt peut être ouverte.")
    if not path.is_file():
        raise TranscriptError("Fichier introuvable : il a peut-être été déplacé ou supprimé.")
    return path


def default_dir() -> Path:
    """Documents\\Trame\\Transcriptions (le dossier Documents réel, même redirigé vers OneDrive)."""
    docs: Optional[Path] = None
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
            # CSIDL_PERSONAL = 5 : le dossier Documents tel que Windows le résout.
            if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
                docs = Path(buf.value)
        except Exception:
            docs = None
    return (docs or Path.home() / "Documents") / "Trame" / "Transcriptions"


def _memo(home: Path) -> Path:
    return home / "transcripts.json"


def chosen_dir(home: Path) -> Path:
    """Le dossier choisi la dernière fois, sinon celui par défaut."""
    try:
        raw = json.loads(_memo(home).read_text(encoding="utf-8")).get("directory")
        if isinstance(raw, str) and Path(raw).is_absolute():
            return Path(raw)
    except (OSError, ValueError, AttributeError):
        pass
    return default_dir()


def check_dir(raw: str) -> Path:
    """Un dossier donné par l'utilisateur : chemin absolu local, sans partage réseau."""
    s = (raw or "").strip().strip('"')
    if not s or len(s) > 400 or "\x00" in s:
        raise TranscriptError("Dossier invalide.")
    path = Path(os.path.expandvars(os.path.expanduser(s)))
    if not path.is_absolute():
        raise TranscriptError("Indique un chemin complet (par exemple C:\\Users\\toi\\Documents\\Transcriptions).")
    if s.startswith("\\\\") or s.startswith("//"):
        raise TranscriptError("Un dossier du poste est attendu, pas un partage réseau.")
    if path.exists() and not path.is_dir():
        raise TranscriptError("Ce chemin est un fichier, pas un dossier.")
    return path


def remember_dir(home: Path, directory: Path) -> None:
    try:
        home.mkdir(parents=True, exist_ok=True)
        _memo(home).write_text(json.dumps({"directory": str(directory)}), encoding="utf-8")
    except OSError:
        pass


# --- liste des réunions gardée sur le poste (%APPDATA%\Trame, conservé par les mises à jour) ---
MEETINGS_KEPT = 500
_MEETING_KEYS = ("thread_id", "chat", "mid", "title", "when", "transcript", "meeting_id", "date", "start", "end",
                 "organizer")


def _meetings_file(home: Path) -> Path:
    return home / "meetings.json"


def load_meetings(home: Path) -> tuple[list[dict], Optional[str]]:
    """Les réunions de la dernière lecture et son heure (ISO), sans toucher à Teams."""
    try:
        raw = json.loads(_meetings_file(home).read_text(encoding="utf-8"))
        items = [m for m in raw.get("meetings") or [] if isinstance(m, dict) and m.get("meeting_id")
                 and m.get("thread_id") and m.get("mid")]
        read_at = raw.get("read_at") if isinstance(raw.get("read_at"), str) else None
        return items, read_at
    except (OSError, ValueError, AttributeError):
        return [], None


def merge_meetings(known: Iterable[dict], found: Iterable[dict]) -> list[dict]:
    """Les réunions lues à l'instant, plus celles déjà connues qui ne sont plus dans la
    fenêtre récente de Teams : une réunion vue une fois n'est jamais perdue. Une valeur
    lue gagne, sauf un organisateur vide (on garde celui déjà connu)."""
    by_id: dict[str, dict] = {m["meeting_id"]: dict(m) for m in known}
    for m in found:
        old = by_id.get(m["meeting_id"], {})
        by_id[m["meeting_id"]] = {**old, **m, "organizer": m.get("organizer") or old.get("organizer", "")}
    out = list(by_id.values())
    out.sort(key=lambda m: (m.get("date") is not None, m.get("date") or "", m.get("start") or ""), reverse=True)
    return out[:MEETINGS_KEPT]


def store_meetings(home: Path, meetings: Iterable[dict], read_at: str) -> None:
    """Écrit la liste (sans l'état du fichier, relu du disque à chaque fois) ; fichier
    remplacé d'un bloc pour ne jamais laisser une liste à moitié écrite."""
    items = [{k: m.get(k) for k in _MEETING_KEYS} for m in meetings]
    try:
        home.mkdir(parents=True, exist_ok=True)
        tmp = _meetings_file(home).with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"read_at": read_at, "meetings": items}, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, _meetings_file(home))
    except OSError:
        pass


def save(directory: Path, name: str, content: str) -> Path:
    """Écrit le fichier sans jamais en écraser un autre : « … (2).vtt » au besoin."""
    directory.mkdir(parents=True, exist_ok=True)
    stem, suffix = name[:-4], ".vtt"
    path = directory / name
    n = 2
    while path.exists():
        path = directory / f"{stem} ({n}){suffix}"
        n += 1
    # UTF-8 sans BOM, fins de ligne LF : ce qu'attendent les lecteurs WebVTT.
    with open(path, "x", encoding="utf-8", newline="\n") as f:
        f.write(content)
    return path
