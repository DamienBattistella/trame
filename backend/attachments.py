"""Pièces jointes envoyées à la main depuis la vue d'une conversation.

Le fichier est choisi par l'utilisateur dans l'interface de Trame (sélecteur ou
glisser-déposer) : l'interface en lit le contenu et l'envoie au moteur, qui le
transmet au pilote. Aucun chemin ne circule : ni le moteur ni la page Teams ne
lisent jamais un fichier du disque, seulement les octets que l'utilisateur a choisis.
"""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from pathlib import PurePath
from typing import Iterable, Optional

from pydantic import BaseModel, Field

MAX_FILES = 3
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 15 * 1024 * 1024
# Documents, images et archives courants. Pas d'exécutable ni de script : Teams les
# bloque souvent, et Trame n'a aucune raison d'en transmettre.
EXTENSIONS = (
    "pdf", "txt", "md", "csv", "log", "json", "xml",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "png", "jpg", "jpeg", "gif", "webp",
    "zip",
)
MAX_NAME = 180


class AttachmentIn(BaseModel):
    """Un fichier tel que l'interface l'envoie : nom, type MIME annoncé, contenu en base64."""
    name: str = Field(min_length=1, max_length=400)
    type: Optional[str] = Field(default=None, max_length=200)
    data: str = Field(max_length=(MAX_FILE_BYTES * 4) // 3 + 8)


@dataclass(frozen=True)
class Attachment:
    name: str
    mime: str
    data: bytes

    @property
    def size(self) -> int:
        return len(self.data)

    def wire(self) -> dict:
        """Forme transmise à la page Teams intégrée."""
        return {"name": self.name, "type": self.mime, "data": base64.b64encode(self.data).decode("ascii")}


class AttachmentError(ValueError):
    pass


def limits() -> dict:
    return {"max_files": MAX_FILES, "max_file_bytes": MAX_FILE_BYTES, "max_total_bytes": MAX_TOTAL_BYTES,
            "extensions": list(EXTENSIONS)}


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} o"
    if n < 1024 * 1024:
        return f"{round(n / 1024)} Ko"
    return f"{n / (1024 * 1024):.1f} Mo".replace(".0 Mo", " Mo").replace(".", ",")


def _clean_name(raw: str) -> str:
    # Seul le nom compte : un chemin éventuel (C:\..\x.pdf, ../x.pdf) est réduit à sa fin.
    name = PurePath(raw.replace("\\", "/")).name
    name = "".join(ch for ch in name if ch >= " " and ch not in '<>:"/\\|?*').strip().strip(".")
    if not name:
        raise AttachmentError("Fichier sans nom.")
    if len(name) > MAX_NAME:
        stem, dot, ext = name.rpartition(".")
        name = (stem[: MAX_NAME - len(ext) - 1] + dot + ext) if dot else name[:MAX_NAME]
    return name


def parse(items: Iterable[AttachmentIn]) -> list[Attachment]:
    """Valide les fichiers choisis : nombre, extension, taille, contenu lisible.
    Lève AttachmentError avec un message prêt à afficher."""
    items = list(items)
    if len(items) > MAX_FILES:
        raise AttachmentError(f"{MAX_FILES} fichiers au plus par envoi.")
    out: list[Attachment] = []
    total = 0
    for it in items:
        name = _clean_name(it.name)
        ext = name.rpartition(".")[2].lower() if "." in name else ""
        if ext not in EXTENSIONS:
            raise AttachmentError(f"« {name} » : type de fichier non autorisé (.{ext or '?'}).")
        try:
            data = base64.b64decode(it.data, validate=True)
        except (binascii.Error, ValueError):
            raise AttachmentError(f"« {name} » : contenu illisible.") from None
        if not data:
            raise AttachmentError(f"« {name} » est vide.")
        if len(data) > MAX_FILE_BYTES:
            raise AttachmentError(f"« {name} » dépasse {human_size(MAX_FILE_BYTES)} ({human_size(len(data))}).")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise AttachmentError(f"Les fichiers dépassent {human_size(MAX_TOTAL_BYTES)} au total.")
        mime = (it.type or "").strip() or "application/octet-stream"
        out.append(Attachment(name=name, mime=mime, data=data))
    return out


def describe(files: list[Attachment]) -> str:
    return ", ".join(f"{f.name} ({human_size(f.size)})" for f in files)
