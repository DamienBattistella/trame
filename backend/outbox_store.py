"""File d'envoi sur disque : ce que l'utilisateur a envoyé pendant que Teams n'était pas
prêt survit à un redémarrage de Trame.

Tout reste dans le dossier de Trame (`outbox/`) : un index `outbox.json` (messages,
mentions, empreinte des pièces jointes) et un fichier par pièce jointe, écrit une seule
fois à la mise en file et supprimé dès que le message est parti ou retiré. Chaque
écriture passe par un fichier temporaire remplacé d'un coup : un arrêt brutal laisse
l'ancienne version ou la nouvelle, jamais un fichier à moitié écrit.

Ce sont des contenus privés : rien n'est copié ailleurs, rien n'en est journalisé.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

from pydantic import ValidationError

from attachments import Attachment
from models import QueuedSend

INDEX = "outbox.json"
VERSION = 1
# Taille totale des pièces jointes gardées en attente sur le disque.
MAX_BYTES = 50 * 1024 * 1024
_ID = re.compile(r"^[0-9a-f]{1,36}$")
_BLOB = re.compile(r"^([0-9a-f]{1,36})-(\d{1,2})\.bin$")

SENDING_AT_STOP = ("Trame a été quitté pendant l'envoi : il est peut-être parti, vérifie dans Teams "
                   "avant de le renvoyer")


class OutboxFull(Exception):
    pass


@dataclass
class Restored:
    items: list[QueuedSend] = field(default_factory=list)
    payload: dict[str, dict] = field(default_factory=dict)
    corrupt: bool = False   # index illisible : ignoré et supprimé


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class OutboxStore:
    def __init__(self, folder: Path, max_bytes: int = MAX_BYTES):
        self.folder = folder
        self.max_bytes = max_bytes

    @property
    def index(self) -> Path:
        return self.folder / INDEX

    def _blob(self, item_id: str, n: int) -> Path:
        if not _ID.match(item_id):
            raise ValueError("identifiant de message invalide")
        return self.folder / f"{item_id}-{n}.bin"

    # --- pièces jointes ---
    def add_files(self, item_id: str, files: Sequence[Attachment], used: int) -> list[dict]:
        """Écrit les pièces jointes d'un message mis en file. `used` : octets déjà gardés
        par les autres messages en attente. Lève OutboxFull au-delà de la limite."""
        if not files:
            return []
        size = sum(f.size for f in files)
        if used + size > self.max_bytes:
            raise OutboxFull()
        self.folder.mkdir(parents=True, exist_ok=True)
        meta = []
        try:
            for n, f in enumerate(files):
                _write_atomic(self._blob(item_id, n), f.data)
                meta.append({"name": f.name, "mime": f.mime, "size": f.size, "sha256": _sha(f.data)})
        except Exception:
            self.remove_files(item_id)
            raise
        return meta

    def remove_files(self, item_id: str) -> None:
        if not self.folder.is_dir():
            return
        for p in self.folder.iterdir():
            m = _BLOB.match(p.name)
            if (m and m.group(1) == item_id) or (p.name.startswith(f"{item_id}-") and p.name.endswith(".tmp")):
                p.unlink(missing_ok=True)

    # --- index ---
    def save(self, items: Sequence[QueuedSend], payload: dict[str, dict]) -> None:
        now_mono, now = time.monotonic(), time.time()
        entries = []
        for item in items:
            p = payload.get(item.id, {})
            entries.append({
                "item": item.model_dump(mode="json"),
                "mentions": list(p.get("mentions", ())),
                # Le délai de 12 h compte en temps réel d'un lancement à l'autre.
                "queued_ts": now - max(0.0, now_mono - p.get("since", now_mono)),
                "files": list(p.get("meta", ())),
                "lost_files": bool(p.get("lost_files")),
            })
        if not entries and not self.index.exists():
            return
        self.folder.mkdir(parents=True, exist_ok=True)
        data = json.dumps({"version": VERSION, "items": entries}, ensure_ascii=False).encode("utf-8")
        _write_atomic(self.index, data)

    def load(self) -> Restored:
        out = Restored()
        if not self.index.exists():
            self._purge_orphans(set())
            return out
        try:
            raw = json.loads(self.index.read_text(encoding="utf-8"))
            entries = raw["items"]
            if not isinstance(entries, list):
                raise ValueError
        except Exception:
            out.corrupt = True
            self.index.unlink(missing_ok=True)
            self._purge_orphans(set())
            return out
        now_mono, now = time.monotonic(), time.time()
        for entry in entries:
            try:
                item = QueuedSend.model_validate(entry["item"])
                if not _ID.match(item.id) or any(x.id == item.id for x in out.items):
                    continue
                mentions = [str(m) for m in entry.get("mentions", [])]
                since = now_mono - max(0.0, now - float(entry.get("queued_ts", now)))
                meta = entry.get("files", []) or []
                lost = bool(entry.get("lost_files"))
            except (KeyError, TypeError, ValueError, ValidationError):
                continue
            files, broken = self._read_files(item.id, meta)
            if not broken and len(meta) != len(item.files):
                broken = item.files[0] if item.files else "?"
            if item.status == "sending":
                # Peut-être parti au moment de l'arrêt : jamais renvoyé seul.
                item = item.model_copy(update={"status": "uncertain", "reason": SENDING_AT_STOP})
            if broken:
                lost = True
                self.remove_files(item.id)
                files, meta = [], []
                item = item.model_copy(update={
                    "status": "failed",
                    "reason": f"pièce jointe « {broken} » illisible après le redémarrage : renvoie le message "
                              "toi-même"})
            out.items.append(item)
            out.payload[item.id] = {"mentions": mentions, "files": files, "meta": meta, "since": since,
                                    "lost_files": lost}
        self._purge_orphans({x.id for x in out.items if out.payload[x.id]["meta"]})
        return out

    def _read_files(self, item_id: str, meta: list) -> tuple[list[Attachment], Optional[str]]:
        """Pièces jointes relues et vérifiées ; le nom de la première illisible sinon."""
        files = []
        for n, m in enumerate(meta):
            name = str(m.get("name", "?")) if isinstance(m, dict) else "?"
            try:
                data = self._blob(item_id, n).read_bytes()
                if len(data) != int(m["size"]) or _sha(data) != m["sha256"]:
                    return [], name
                files.append(Attachment(name=name, mime=str(m.get("mime") or "application/octet-stream"),
                                        data=data))
            except Exception:
                return [], name
        return files, None

    def _purge_orphans(self, keep: set[str]) -> None:
        """Supprime toute pièce jointe qu'aucun message gardé ne référence (arrêt entre
        l'écriture d'un fichier et celle de l'index, fichier temporaire abandonné)."""
        if not self.folder.is_dir():
            return
        for p in self.folder.iterdir():
            if p.name == INDEX:
                continue
            m = _BLOB.match(p.name)
            if m and m.group(1) in keep:
                continue
            if m or p.name.endswith(".tmp"):
                p.unlink(missing_ok=True)
