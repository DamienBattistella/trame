"""Le SOUL.md vu de près : ses sections lues, ses versions conservées, et ce que Trame
apprend des conversations pour le tenir à jour.

Trame n'écrit que dans une section à lui, « ## Appris des conversations ». Les autres
sections restent celles de l'utilisateur : ce qu'il a écrit, et surtout ses limites,
ne sont jamais réécrits par le modèle. Chaque changement, à la main ou appris, laisse
une version restaurable.
"""
from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

import config as cfgmod

LEARNED_HEADING = "Appris des conversations"
LEARNED_NOTE = "_Tenue à jour par Trame d'après tes corrections et tes messages ; tes autres sections priment._"
MAX_VERSIONS = 50
MAX_SIGNALS = 200
MAX_TEXT = 600
MAX_BULLETS = 12
MAX_BULLET = 220
LEARN_EVERY = 8

Source = Literal["initial", "manuel", "appris", "restauré", "assistant"]
SignalKind = Literal["corrigé", "accepté", "rejeté", "écrit"]
# Ce qui dit vraiment quelque chose de la voix : une réponse validée telle quelle
# confirme seulement, elle ne déclenche pas d'apprentissage à elle seule.
INFORMATIVE = ("corrigé", "rejeté", "écrit")

_HEADING = re.compile(r"^(#{1,3})\s+(.+?)\s*#*\s*$")
_VERSION_ID = re.compile(r"^\d{8}-\d{6}-\d{3}$")


def _history_dir() -> Path:
    return cfgmod.HOME / "soul_history"


def _signals_path() -> Path:
    return cfgmod.HOME / "soul_signals.jsonl"


def _state_path() -> Path:
    return cfgmod.HOME / "soul_learning.json"


def _now() -> datetime:
    return datetime.now()


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# --- lecture ---
def parse(content: str) -> dict:
    """Titre et sections (## ou ###) du SOUL.md, avec ce qu'en retient Trame : nombre de
    consignes (puces), exemples cités (> …), et la section tenue par Trame."""
    title = ""
    sections: list[dict] = []
    current: Optional[dict] = None
    preamble: list[str] = []
    for line in content.splitlines():
        m = _HEADING.match(line)
        if m and len(m.group(1)) == 1 and not title and not sections:
            title = m.group(2)
            continue
        if m and len(m.group(1)) >= 2:
            current = {"heading": m.group(2), "level": len(m.group(1)), "lines": []}
            sections.append(current)
            continue
        (current["lines"] if current else preamble).append(line)
    if any(x.strip() for x in preamble):
        sections.insert(0, {"heading": "", "level": 2, "lines": preamble})
    out = []
    for s in sections:
        body = "\n".join(s["lines"]).strip()
        lines = body.splitlines()
        out.append({
            "heading": s["heading"],
            "level": s["level"],
            "body": body,
            "rules": sum(1 for x in lines if re.match(r"^\s*[-*+]\s+\S", x)),
            "examples": sum(1 for x in lines if x.lstrip().startswith(">")),
            "learned": s["heading"].strip().casefold() == LEARNED_HEADING.casefold(),
        })
    return {"title": title, "sections": out}


def learned_rules(content: str) -> list[str]:
    section = next((s for s in parse(content)["sections"] if s["learned"]), None)
    if not section:
        return []
    return [re.sub(r"^\s*[-*+]\s+", "", x).strip() for x in section["body"].splitlines()
            if re.match(r"^\s*[-*+]\s+\S", x)]


def with_learned(content: str, rules: list[str]) -> str:
    """Le SOUL.md avec la section apprise remplacée (ou ajoutée à la fin). Le reste du
    fichier est rendu octet pour octet."""
    block = [f"## {LEARNED_HEADING}", "", LEARNED_NOTE, "", *[f"- {r}" for r in rules]]
    lines = content.rstrip("\n").splitlines()
    start = next((i for i, x in enumerate(lines)
                  if (m := _HEADING.match(x)) and len(m.group(1)) >= 2
                  and m.group(2).strip().casefold() == LEARNED_HEADING.casefold()), None)
    if start is None:
        return "\n".join([*lines, "", *block]) + "\n"
    end = next((i for i in range(start + 1, len(lines))
                if (m := _HEADING.match(lines[i])) and len(m.group(1)) <= 2), len(lines))
    tail = lines[end:]
    return "\n".join([*lines[:start], *block, *([""] + tail if tail else [])]) + "\n"


# --- versions ---
class History:
    """Versions successives du SOUL.md, les plus récentes d'abord, MAX_VERSIONS au plus."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def _index_path(self) -> Path:
        return _history_dir() / "index.json"

    def _index(self) -> list[dict]:
        try:
            data = json.loads(self._index_path().read_text(encoding="utf-8"))
            return [v for v in data if isinstance(v, dict) and _VERSION_ID.match(str(v.get("id", "")))]
        except (OSError, ValueError):
            return []

    def list(self) -> list[dict]:
        return self._index()

    def read(self, version_id: str) -> str:
        if not _VERSION_ID.match(version_id or ""):
            raise KeyError(version_id)
        path = _history_dir() / f"{version_id}.md"
        if not path.exists():
            raise KeyError(version_id)
        return path.read_text(encoding="utf-8")

    def snapshot(self, content: str, source: Source, note: str = "") -> Optional[dict]:
        """Garde cette version ; rien si elle est identique à la dernière gardée."""
        with self._lock:
            index = self._index()
            if index:
                try:
                    if self.read(index[0]["id"]) == content:
                        return None
                except KeyError:
                    pass
            now = _now()
            version_id = now.strftime("%Y%m%d-%H%M%S-") + f"{now.microsecond // 1000:03d}"
            while any(v["id"] == version_id for v in index):
                version_id = version_id[:-3] + f"{(int(version_id[-3:]) + 1) % 1000:03d}"
            _write(_history_dir() / f"{version_id}.md", content)
            entry = {"id": version_id, "at": now.isoformat(timespec="seconds"), "source": source,
                     "note": note[:200], "size": len(content.encode("utf-8"))}
            index.insert(0, entry)
            for old in index[MAX_VERSIONS:]:
                (_history_dir() / f"{old['id']}.md").unlink(missing_ok=True)
            _write(self._index_path(), json.dumps(index[:MAX_VERSIONS], ensure_ascii=False, indent=1))
            return entry

    def clear(self) -> None:
        with self._lock:
            for p in _history_dir().glob("*"):
                p.unlink(missing_ok=True)


# --- ce que Trame observe ---
class Signals:
    """Ce que l'utilisateur fait des réponses de Trame, gardé sur ce poste seulement :
    brouillons corrigés, validés ou écartés, et messages écrits de sa main."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def all(self) -> list[dict]:
        try:
            lines = _signals_path().read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    def add(self, kind: SignalKind, conversation: str, incoming: str = "", proposal: str = "", final: str = "") -> dict:
        entry = {"at": _now().isoformat(timespec="seconds"), "kind": kind, "conversation": conversation[:120],
                 "incoming": incoming.strip()[:MAX_TEXT], "proposal": proposal.strip()[:MAX_TEXT],
                 "final": final.strip()[:MAX_TEXT]}
        with self._lock:
            keep = self.all()[-(MAX_SIGNALS - 1):]
            _write(_signals_path(), "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in [*keep, entry]))
        return entry

    def clear(self) -> None:
        with self._lock:
            _signals_path().unlink(missing_ok=True)


def load_state() -> dict:
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    _write(_state_path(), json.dumps(state, ensure_ascii=False, indent=1))


def pending(signals: list[dict], since: str) -> list[dict]:
    """Signaux arrivés depuis le dernier apprentissage."""
    return [s for s in signals if str(s.get("at", "")) > since]


def informative(signals: list[dict]) -> int:
    return sum(1 for s in signals if s.get("kind") in INFORMATIVE)


# --- apprentissage ---
def _describe(s: dict) -> str:
    kind = s.get("kind")
    head = f"[{kind}] {s.get('conversation') or 'conversation'}"
    parts = [head]
    if s.get("incoming"):
        parts.append(f"  Message reçu : {s['incoming']}")
    if kind in ("corrigé", "accepté", "rejeté") and s.get("proposal"):
        parts.append(f"  Proposé par Trame : {s['proposal']}")
    if kind in ("corrigé", "écrit", "accepté") and s.get("final"):
        parts.append(f"  Envoyé par l'utilisateur : {s['final']}")
    return "\n".join(parts)


def build_prompt(soul: str, signals: list[dict]) -> str:
    current = learned_rules(soul)
    return "\n".join([
        "Tu tiens à jour la section « Appris des conversations » d'un SOUL.md : le fichier qui décrit "
        "la voix d'une personne pour qu'un assistant rédige ses réponses Teams à sa place.",
        "",
        "SOUL.md actuel (les autres sections sont écrites par la personne et priment toujours) :",
        "<<<",
        soul.strip(),
        ">>>",
        "",
        "Règles actuelles de la section apprise :",
        *([f"- {r}" for r in current] or ["(aucune)"]),
        "",
        "### SIGNAUX (du plus ancien au plus récent)",
        "« corrigé » : la personne a modifié la proposition avant de l'envoyer, la différence est la leçon. "
        "« accepté » : envoyée telle quelle. « rejeté » : proposition écartée. « écrit » : message écrit de sa main.",
        "",
        *[_describe(s) for s in signals],
        "",
        f"Rends la nouvelle liste complète des règles apprises : {MAX_BULLETS} au plus, une par ligne, "
        "chacune commençant par « - ».",
        "- Garde les règles actuelles encore vraies, fusionne les doublons, retire celles que les signaux contredisent.",
        "- Seulement des habitudes d'écriture générales et répétées : longueur, ton, tutoiement, formules d'ouverture "
        "et de clôture, ponctuation, emojis, vocabulaire, langue, structure.",
        "- Jamais un fait, un nom de client ou de patient, une date, un chiffre, un engagement ni un contenu de message.",
        "- Ne contredis ni n'assouplis jamais une limite écrite par la personne (ce que Trame doit refuser, "
        "les engagements, la confidentialité).",
        "- Une règle s'appuie sur au moins deux signaux ; dans le doute, ne l'ajoute pas.",
        "Rien d'autre que la liste : pas de titre, pas de commentaire.",
    ])


_FORBIDDEN = re.compile(r"(envoi automatique|auto[- ]?send|ignore|oublie les|sans relecture|engage[rz]?[- ]toi)", re.I)


def parse_rules(answer: str) -> list[str]:
    """Les règles rendues par le modèle, nettoyées : des puces courtes, rien qui touche
    aux garde-fous d'envoi."""
    out: list[str] = []
    for line in answer.splitlines():
        m = re.match(r"^\s*(?:[-*+•]|\d+[.)])\s+(.+)$", line)
        if not m:
            continue
        rule = m.group(1).strip().strip("*").strip()
        if not rule or len(rule) > MAX_BULLET or _FORBIDDEN.search(rule) or rule in out:
            continue
        out.append(rule)
        if len(out) >= MAX_BULLETS:
            break
    return out
