"""Santé de Trame en un coup d'œil : chaque point dit s'il va bien, et sinon quoi faire.

Rien n'est demandé à Teams ni au cerveau ici : on relit ce que Trame sait déjà (état,
dernier contrôle de la page Teams, file d'envoi) et l'espace disque du dossier de Trame.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel

Status = Literal["ok", "warn", "error", "unknown"]

# Disque : en dessous, les compilations, la file d'envoi et les journaux échouent.
DISK_WARN = 5 * 1024**3
DISK_ERROR = 1 * 1024**3


class HealthItem(BaseModel):
    key: str
    label: str
    status: Status
    detail: str


def _gb(n: int) -> str:
    return f"{n / 1024**3:.1f} Go".replace(".", ",")


def disk(path: Path) -> HealthItem:
    try:
        usage = shutil.disk_usage(path)
    except OSError as e:
        return HealthItem(key="disk", label="Espace disque", status="unknown", detail=f"Illisible ({e}).")
    free, total = usage.free, usage.total
    where = f"{_gb(free)} libres sur {_gb(total)} ({path.anchor or path})"
    if free < DISK_ERROR:
        return HealthItem(key="disk", label="Espace disque", status="error",
                          detail=f"Presque plein : {where}. Trame ne peut plus garder sa file d'envoi ni ses journaux.")
    if free < DISK_WARN:
        return HealthItem(key="disk", label="Espace disque", status="warn", detail=f"Peu de place : {where}.")
    return HealthItem(key="disk", label="Espace disque", status="ok", detail=where)


def teams(selftest_ok: bool, relay: Optional[bool], driver: str) -> HealthItem:
    if relay is False:
        return HealthItem(key="teams", label="Connexion à Teams", status="error",
                          detail="La fenêtre Teams de Trame ne répond pas : rien ne peut être lu ni envoyé.")
    if not selftest_ok:
        return HealthItem(key="teams", label="Connexion à Teams", status="warn",
                          detail="Teams n'est pas encore vérifié : l'envoi automatique reste en brouillon.")
    return HealthItem(key="teams", label="Connexion à Teams", status="ok", detail=f"Connecté ({driver}).")


def page(check) -> HealthItem:
    if check is None:
        return HealthItem(key="page", label="Page Teams", status="unknown",
                          detail="Pas encore contrôlée : le contrôle tourne quand Teams se connecte.")
    if check.ok:
        return HealthItem(key="page", label="Page Teams", status="ok",
                          detail=f"Repères présents ({check.verified} vérifiés, contrôle de {check.at}).")
    missing = ", ".join(m.label for m in check.missing[:3]) + ("…" if len(check.missing) > 3 else "")
    return HealthItem(key="page", label="Page Teams", status="error",
                      detail=f"Teams a changé : {missing or check.summary}. Contrôle de {check.at}.")


def outbox(items) -> HealthItem:
    waiting = sum(1 for q in items if q.status in ("waiting", "sending"))
    stuck = sum(1 for q in items if q.status == "failed")
    unsure = sum(1 for q in items if q.status == "uncertain")
    if stuck or unsure:
        parts = [f"{stuck} non envoyé(s)" if stuck else "", f"{unsure} à vérifier dans Teams" if unsure else ""]
        return HealthItem(key="outbox", label="File d'envoi", status="warn",
                          detail=" · ".join(p for p in parts if p) + (f" · {waiting} en attente" if waiting else ""))
    if waiting:
        return HealthItem(key="outbox", label="File d'envoi", status="warn", detail=f"{waiting} message(s) en attente d'envoi.")
    return HealthItem(key="outbox", label="File d'envoi", status="ok", detail="Vide : tout est parti.")


def brain(provider: str, model: str, last_error: Optional[str]) -> HealthItem:
    label = f"{provider}{f' · {model}' if model else ''}"
    if last_error:
        return HealthItem(key="brain", label="Cerveau", status="warn", detail=f"{label}. Dernier échec : {last_error}")
    return HealthItem(key="brain", label="Cerveau", status="ok", detail=label)


def pause(paused: bool, sharing: bool) -> HealthItem:
    if sharing:
        return HealthItem(key="pause", label="Veille", status="warn",
                          detail="Partage d'écran ou présentation en cours : rien n'est tapé dans Teams.")
    if paused:
        return HealthItem(key="pause", label="Veille", status="warn", detail="Trame est en pause.")
    return HealthItem(key="pause", label="Veille", status="ok", detail="Active.")


def overall(items: list[HealthItem]) -> Status:
    order = {"error": 3, "warn": 2, "unknown": 1, "ok": 0}
    worst = max((order[i.status] for i in items), default=0)
    return next(s for s, v in order.items() if v == worst)  # type: ignore[return-value]
