"""Contrôle de la page Teams web : les repères dont dépend le pont de Trame sont-ils là ?

Le pont (ui/src-tauri/teams-bridge.js) cherche dans la page les repères de sa table
LANDMARKS (data-tid, rôles…) et rend, pour chacun, trouvé / absent / pas vérifiable
maintenant. Les repères qui n'existent que dans un menu (menu du profil, « Marquer comme
lu »…) ne sont pas ouverts pour l'occasion : le pont note ce qu'il a constaté quand une
opération s'en est servie. Ce module traduit les absences en ce qui ne marchera plus,
pour une alerte claire au lieu d'échecs isolés."""
from __future__ import annotations
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

# Ce qu'un repère manquant casse : phrase de l'alerte, pluriel, et « tout » (rien ne marche).
FEATURES: dict[str, tuple[str, bool, bool]] = {
    "list": ("la liste des conversations", False, True),
    "ids": ("le suivi des conversations par identifiant", False, False),
    "own_status": ("la lecture de ton statut", False, False),
    "new_chat": ("démarrer une conversation", False, False),
    "search": ("la recherche dans Teams", False, False),
    "conversation": ("l'écriture dans une conversation (envoi, réponses, réactions)", False, False),
    "write": ("l'envoi des messages", False, False),
    "attach": ("les pièces jointes", True, False),
    "read": ("la lecture des messages", False, False),
    "react": ("les réactions", True, False),
    "reply": ("la réponse à un message précis", False, False),
    "delete": ("la suppression d'un message", False, False),
    "mark_read": ("le marquage comme lu", False, False),
    "set_status": ("le changement de statut", False, False),
    "status_duration": ("le statut pour une durée", False, False),
    "status_note": ("le message de statut", False, False),
    "status_until": ("le statut jusqu'à une date et une heure", False, False),
    "mention": ("la mention", False, False),
    "clear": ("le vidage de la zone de saisie", False, False),
    "typing": ("l'indicateur de frappe de la conversation ouverte", False, False),
}

# Chaque repère du pont : ce qu'il est dans Teams, et ce qui en dépend. Les clés sont celles
# de LANDMARKS dans teams-bridge.js (un test vérifie qu'elles sont les mêmes).
LANDMARKS: dict[str, tuple[str, tuple[str, ...]]] = {
    "rail": ("liste des conversations", ("list",)),
    "rail_item": ("lignes de la liste des conversations", ("list",)),
    "rail_id": ("identifiant des conversations dans la liste", ("ids",)),
    "me": ("bouton du profil", ("own_status", "set_status", "status_duration", "status_until", "status_note")),
    "me_presence": ("pastille de statut du profil", ("own_status",)),
    "new_chat": ("bouton « Nouvelle conversation »", ("new_chat",)),
    "search_input": ("champ de recherche", ("search",)),
    "chat_app": ("bouton Conversation de la barre d'applications", ("search",)),
    "title": ("nom de la conversation dans le titre de la fenêtre", ("conversation",)),
    "editor": ("zone de saisie", ("write",)),
    "editor_model": ("éditeur de la zone de saisie (CKEditor)", ("write",)),
    "send": ("bouton Envoyer", ("write",)),
    "attach": ("bouton Joindre", ("attach",)),
    "main_pane": ("zone principale de la conversation ([role=main])", ("typing",)),
    "messages": ("messages de la conversation", ("read",)),
    "message_body": ("texte des messages", ("read",)),
    "message_id": ("identifiant des messages", ("read", "react", "reply", "delete")),
    "action_bar": ("barre d'actions d'un message", ("react", "reply", "delete")),
    "react_like": ("réaction « J'aime »", ("react",)),
    "react_heart": ("réaction « Cœur »", ("react",)),
    "react_laugh": ("réaction « Rire »", ("react",)),
    "react_surprised": ("réaction « Surpris »", ("react",)),
    "quote": ("« Répondre » d'un message", ("reply",)),
    "unread": ("pastille « non lu » de la liste", ("mark_read",)),
    "me_menu": ("menu du profil", ("set_status", "status_duration", "status_until", "status_note")),
    "status_entry": ("entrée « Modifier l'état »", ("set_status", "status_duration", "status_until")),
    "status_choice": ("choix de statut", ("set_status",)),
    "duration_entry": ("entrée « Durée »", ("status_duration", "status_until")),
    "duration_panel": ("panneau « Durée »", ("status_duration", "status_until")),
    "duration_lists": ("listes du panneau « Durée »", ("status_duration", "status_until")),
    "expiry_date": ("champ de date du statut personnalisé", ("status_until",)),
    "expiry_time": ("liste des heures du statut personnalisé", ("status_until",)),
    "note_edit": ("bouton du message de statut", ("status_note",)),
    "read_entry": ("entrée « Marquer comme lu »", ("mark_read",)),
    "mention_list": ("suggestions de mention", ("mention",)),
    "delete_entry": ("entrée « Supprimer » d'un message", ("delete",)),
    "people_picker": ("champ « À » d'une nouvelle conversation", ("new_chat",)),
    "search_tab": ("onglet Messages de la recherche", ("search",)),
    "attach_menu": ("entrée « Charger à partir de cet appareil »", ("attach",)),
    "discard_confirm": ("confirmation « Rejeter le brouillon »", ("clear",)),
}


class TeamsLandmark(BaseModel):
    key: str
    label: str
    features: list[str]
    # page : absent de la page au contrôle ; usage : absent quand une opération l'a cherché.
    how: Literal["page", "usage"]
    at: str


class TeamsCheck(BaseModel):
    """Dernier contrôle de la page Teams web. summary est vide quand rien ne manque."""
    at: str
    ok: bool
    summary: str = ""
    missing: list[TeamsLandmark] = Field(default_factory=list)
    verified: int = 0
    unverified: int = 0


def _iso(ms: Any, default: str) -> str:
    try:
        return datetime.fromtimestamp(float(ms) / 1000).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError, OSError):
        return default


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " et " + items[-1]


def summarize(features: list[str]) -> str:
    """« Teams a changé : la mention ne marchera plus, rien d'autre n'est touché. »"""
    if not features:
        return ""
    if any(FEATURES[f][2] for f in features):
        return ("Teams a changé : Trame ne trouve plus la liste des conversations, "
                "plus rien ne peut être lu ni envoyé.")
    phrases = [FEATURES[f][0] for f in features]
    plural = len(features) > 1 or FEATURES[features[0]][1]
    verb = "ne marcheront plus" if plural else "ne marchera plus"
    return f"Teams a changé : {_join(phrases)} {verb}, rien d'autre n'est touché."


def merge_marks(known: dict[str, dict], marks: Any) -> dict[str, dict]:
    """Garde, pour chaque repère, le dernier constat du pont ({ok, at}). Le pont oublie
    les siens quand la page se recharge : le moteur s'en souvient."""
    out = dict(known)
    for key, m in (marks if isinstance(marks, dict) else {}).items():
        if key not in LANDMARKS or not isinstance(m, dict):
            continue
        at = m.get("at") if isinstance(m.get("at"), (int, float)) else 0
        if key not in out or at >= out[key].get("at", 0):
            out[key] = {"ok": bool(m.get("ok")), "at": at}
    return out


def evaluate(results: Any, marks: dict[str, dict], now: Optional[datetime] = None) -> TeamsCheck:
    """results : clé -> True / False / None, tel que le contrôle du pont l'a vu.
    marks : derniers constats des opérations (merge_marks). Un repère vu présent dans la
    page l'emporte sur un vieux constat d'absence."""
    stamp = (now or datetime.now()).isoformat(timespec="seconds")
    results = results if isinstance(results, dict) else {}
    missing: list[TeamsLandmark] = []
    verified = unverified = 0
    for key, (label, feats) in LANDMARKS.items():
        page, mark = results.get(key), marks.get(key)
        if page is True or (page is None and mark and mark["ok"]):
            verified += 1
        elif page is False:
            missing.append(TeamsLandmark(key=key, label=label, features=list(feats), how="page", at=stamp))
        elif mark and not mark["ok"]:
            missing.append(TeamsLandmark(key=key, label=label, features=list(feats), how="usage",
                                         at=_iso(mark.get("at"), stamp)))
        else:
            unverified += 1
    features = [f for f in FEATURES if any(f in m.features for m in missing)]
    return TeamsCheck(at=stamp, ok=not missing, summary=summarize(features), missing=missing,
                      verified=verified, unverified=unverified)
