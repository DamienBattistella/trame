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
import threading
import time
from datetime import datetime
from typing import Any, Optional

from drivers.base import TeamsDriver
from models import IncomingMessage

# Attributs propres au wrapper (les autres sont lus/écrits sur le pilote de la page).
_OWN = {"_inner", "_routes", "_routes_lock"}

# Actions suivies, dans l'ordre d'affichage. Libellés côté UI (ApiTeamsWebSettings).
ACTIONS = ("list", "read", "watch", "unread", "presence", "my_status", "search_people",
           "search_messages", "mark_read", "react", "delete", "set_status", "set_note",
           "send", "start_chat", "meetings", "transcript")


class WebApiDriver:
    # Actions déjà câblées sur le service de chat (les autres restent sur la page).
    API_ACTIONS = frozenset({"read"})
    PAGE_REASON = "via la page Teams (pas encore câblé sur le service de chat)"

    def __init__(self, inner: TeamsDriver) -> None:
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_routes", {})
        object.__setattr__(self, "_routes_lock", threading.Lock())

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
        """Voie suivie par action, telle que constatée au dernier essai : « api » quand le
        service de chat a répondu, « page » sinon (pas encore câblé, ou repli sur la page avec
        la raison de l'échec)."""
        at = time.strftime("%H:%M:%S")
        with self._routes_lock:
            seen = dict(self._routes)
        out = {}
        for a in ACTIONS:
            if a in seen:
                out[a] = dict(seen[a])
            elif a in self.API_ACTIONS:
                out[a] = {"via": "api", "reason": "service de chat de Teams (pas encore utilisé)", "at": at}
            else:
                out[a] = {"via": "page", "reason": self.PAGE_REASON, "at": at}
        return out

    def _route(self, action: str, via: str, reason: Optional[str] = None) -> None:
        with self._routes_lock:
            self._routes[action] = {"via": via, "reason": reason, "at": time.strftime("%H:%M:%S")}

    # --- Lecture d'un fil par le service de chat, sans ouvrir la conversation ---
    def read_history_direct(self, thread_id: str, last_n: int,
                            since: Optional[datetime] = None) -> Optional[tuple[list[IncomingMessage], bool]]:
        """Le fil lu sur le service de chat de Teams sans ouvrir la conversation (elle n'est
        donc pas marquée comme lue). None quand ce n'est pas possible : l'appelant lit alors
        la page, comme avant (ouverture de la conversation)."""
        read = getattr(self._inner, "read_history_api", None)
        if not callable(read):
            return None
        try:
            out = read(thread_id, last_n, since)
        except Exception as e:
            self._route("read", "page", f"repli sur la page : {e}")
            return None
        self._route("read", "api")
        return out

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
