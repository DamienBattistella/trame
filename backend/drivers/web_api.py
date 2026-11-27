"""« API Teams web » devant le pilote de la page (DOM).

Remplace le GraphDriver : au lieu d'appeler Microsoft Graph, Trame s'appuie sur la session
Teams web déjà authentifiée de l'utilisateur. Les appels API se font DANS la page, signés avec
l'auth que le client Teams pose lui-même (le jeton ne quitte jamais la page, voir
`drivers/web_bridge.py` et `docs/teams-web-api.md`).

Teams v2 lit et écrit les messages par l'API REST de son service de chat (chatsvc), depuis un
Web Worker. La page ouvre sa propre session sur ce service (`chatsvc` dans teams-bridge.js) ;
aujourd'hui, lectures et écritures passent encore par la page (DOM) et `routes()` dit, action
par action, la voie suivie (« api » / « page »), prête à basculer en « api » à mesure que les
actions sont câblées. La santé de la signature et de la session chatsvc (auto-tests du pont)
est exposée pour l'écran Réglages.

Enveloppe transparente : tout ce qui n'est pas défini ici est délégué au pilote de la page.
"""
from __future__ import annotations
import time
from typing import Any, Optional

from drivers.base import TeamsDriver

# Attributs propres au wrapper (les autres sont lus/écrits sur le pilote de la page).
_OWN = {"_inner"}

# Actions suivies, dans l'ordre d'affichage. Libellés côté UI (ApiTeamsWebSettings).
ACTIONS = ("list", "read", "watch", "unread", "presence", "my_status", "search_people",
           "search_messages", "mark_read", "react", "delete", "set_status", "set_note",
           "send", "start_chat", "meetings", "transcript")


class WebApiDriver:
    def __init__(self, inner: TeamsDriver) -> None:
        object.__setattr__(self, "_inner", inner)

    @property
    def inner(self) -> TeamsDriver:
        return self._inner

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in _OWN:
            object.__setattr__(self, name, value)
        else:
            setattr(self._inner, name, value)

    def routes(self) -> dict[str, dict]:
        """Voie suivie par action. Tout passe par la page aujourd'hui ; la structure est celle
        du GraphDriver (« via » + « reason ») pour que l'écran Réglages la montre pareil."""
        at = time.strftime("%H:%M:%S")
        reason = "lu/écrit via la page Teams (messages par le canal temps réel)"
        return {a: {"via": "page", "reason": reason, "at": at} for a in ACTIONS}

    def signing(self) -> Optional[dict]:
        """Santé de la signature des appels API, telle que mesurée par l'auto-test du pont
        (`sign_selftest`), ou None si pas encore mesurée. Statut HTTP seulement, aucun jeton."""
        try:
            page = self._inner.diagnose().get("diagnose")
        except Exception:
            return None
        st = page.get("sign_selftest") if isinstance(page, dict) else None
        return st if isinstance(st, dict) else None

    def chatsvc(self) -> Optional[dict]:
        """Santé de la session du service de chat ouverte dans la page (`chatsvc_selftest`) :
        statut HTTP, étape (bearer / authz / chatsvc / ok) et région ; None si pas mesurée.
        Ni jeton ni contenu."""
        try:
            page = self._inner.diagnose().get("diagnose")
        except Exception:
            return None
        st = page.get("chatsvc_selftest") if isinstance(page, dict) else None
        return st if isinstance(st, dict) else None

    def diagnose(self, thread_id: Optional[str] = None) -> dict:
        out = self._inner.diagnose(thread_id) or {}
        page = out.get("diagnose") if isinstance(out, dict) else None
        signing = page.get("sign_selftest") if isinstance(page, dict) else None
        chat = page.get("chatsvc_selftest") if isinstance(page, dict) else None
        return {**out, "teams_web": {"routes": self.routes(),
                                     "signing": signing if isinstance(signing, dict) else None,
                                     "chatsvc": chat if isinstance(chat, dict) else None}}
