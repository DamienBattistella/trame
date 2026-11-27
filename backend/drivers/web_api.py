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
from typing import Any, Callable, Iterable, Optional

from drivers.base import TeamsDriver
from models import IncomingMessage, Surface, WatchEntity

# Attributs propres au wrapper (les autres sont lus/écrits sur le pilote de la page).
_OWN = {"_inner", "_routes", "_routes_lock", "_chat"}


def _newer(lid: str, prev: Optional[str]) -> bool:
    """Ids de messages Teams : des horodatages en ms, croissants. Sans précédent : nouveau."""
    if not prev:
        return True
    try:
        return int(lid) > int(prev)
    except ValueError:
        return lid != prev


class _ChatState:
    """Ce que le service de chat a dit de la liste : lignes par id Teams, syncState pour la
    prochaine lecture incrémentale, dernier message vu par conversation."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.sync = ""
        self.me = ""
        self.ok = False
        self.seen_last: dict[str, str] = {}
        self.primed_at: Optional[float] = None
        self.mapped: dict[str, str] = {}  # thread_id de Trame -> id Teams

# Actions suivies, dans l'ordre d'affichage. Libellés côté UI (ApiTeamsWebSettings).
ACTIONS = ("list", "read", "watch", "unread", "presence", "my_status", "search_people",
           "search_messages", "mark_read", "react", "delete", "set_status", "set_note",
           "send", "start_chat", "meetings", "transcript")


class WebApiDriver:
    # Actions déjà câblées sur le service de chat (les autres restent sur la page).
    API_ACTIONS = frozenset({"read", "watch", "unread"})
    # Écart toléré entre l'horloge du poste et celle de Teams pour dater un message « nouveau ».
    CLOCK_SKEW = 120
    PAGE_REASON = "via la page Teams (pas encore câblé sur le service de chat)"

    def __init__(self, inner: TeamsDriver) -> None:
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_routes", {})
        object.__setattr__(self, "_routes_lock", threading.Lock())
        object.__setattr__(self, "_chat", _ChatState())

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

    # --- Liste, non-lus et nouveaux messages : le service de chat à côté de la page ---------
    # La liste visible (noms, ordre, présence, favoris, ids enregistrés par Trame) reste celle de
    # la page : aucun identifiant ne change. Le service de chat dit, pour chaque conversation qu'il
    # sait relier, son id Teams (lecture d'un fil sans l'ouvrir), son état lu / non lu et son
    # dernier message (texte complet, id, auteur exact).
    def _refresh_chat(self) -> bool:
        read = getattr(self._inner, "chat_list", None)
        st = self._chat
        if not callable(read):
            return False
        try:
            res = read(st.sync)
        except Exception as e:
            st.ok, st.sync = False, ""  # la prochaine lecture repart d'une liste complète
            self._route("watch", "page", f"repli sur la page : {e}")
            self._route("unread", "page", f"repli sur la page : {e}")
            return False
        if res.get("full"):
            st.rows = {}
        for r in res.get("rows") or []:
            st.rows[str(r.get("id"))] = r
        st.sync = res.get("sync") or ""
        st.me = res.get("me") or st.me
        st.ok = True
        return True

    def _chat_for(self, entity: WatchEntity, dm_names: dict[str, Optional[str]]) -> Optional[str]:
        rows = self._chat.rows
        if entity.is_self:
            return "48:notes" if "48:notes" in rows else None
        chat_id = getattr(self._inner, "chat_id", None)
        cid = chat_id(entity.thread_id) if callable(chat_id) else None
        if cid:
            return cid if cid in rows else None
        if entity.thread_id.startswith("name:") and entity.surface == Surface.dm:
            return dm_names.get(entity.display_name.casefold())
        return None

    def _map(self, entities: list[WatchEntity]) -> dict[str, str]:
        """Conversations de la page reliées à leur id Teams. Un tête-à-tête n'est relié que par un
        nom porté par UNE seule conversation (deux homonymes : rien, la page reste la source)."""
        dm_names: dict[str, Optional[str]] = {}
        for cid, r in self._chat.rows.items():
            name = str(r.get("name") or "").casefold()
            if r.get("kind") == "dm" and name:
                dm_names[name] = None if name in dm_names else cid
        mapped = {}
        for e in entities:
            cid = self._chat_for(e, dm_names)
            if cid:
                mapped[e.thread_id] = cid
        self._chat.mapped = mapped
        # Remplacé d'un bloc : une lecture de fil en parallèle voit l'ancienne table ou la nouvelle.
        if isinstance(getattr(self._inner, "chat_aliases", None), dict):
            self._inner.chat_aliases = {t: c for t, c in mapped.items() if t.startswith("name:") or c == "48:notes"}
        return mapped

    def _unread(self, row: dict) -> bool:
        """Non lu : le dernier message, écrit par quelqu'un d'autre, est plus récent que
        l'horizon de lecture de l'utilisateur."""
        last = row.get("last") or {}
        if not last.get("user") or not last.get("id") or (self._chat.me and last.get("from") == self._chat.me):
            return False
        try:
            return int(last["id"]) > int(row.get("horizon") or 0)
        except (TypeError, ValueError):
            return False

    def watch_tick(self, on_message: Callable[[IncomingMessage], None]) -> None:
        """Un coup d'œil : la liste de la page (noms, ordre, présence), complétée par le service de
        chat (non-lus, nouveaux messages). Sans le service, exactement comme la page seule."""
        inner = self._inner
        items = inner._items()
        entities = inner._entities(items)
        api = self._refresh_chat()
        mapped = self._map(entities) if api else {}
        st = self._chat
        if api:
            for e in entities:
                row = st.rows.get(mapped.get(e.thread_id, ""))
                if row is not None:
                    e.unread = self._unread(row)
            self._route("unread", "api")
        hook = getattr(inner, "on_conversations", None)
        if hook is not None and entities:
            try:
                hook(entities)
            except Exception:
                pass
        convs = {e.thread_id: e for e in entities}
        # Aperçus de la page : toujours suivis (pour un repli sans rafale), retenus seulement
        # pour les conversations que le service de chat ne relie pas.
        for msg in inner._previews.diff(((it["thread_id"], it.get("label") or "") for it in items), convs):
            if msg.thread_id not in mapped:
                on_message(msg)
        if not api:
            return
        now = time.time()
        for tid, cid in mapped.items():
            last = (st.rows.get(cid) or {}).get("last") or {}
            lid = str(last.get("id") or "")
            if not lid:
                continue
            prev = st.seen_last.get(cid)
            st.seen_last[cid] = lid
            if st.primed_at is None or prev == lid:
                continue
            # Nouveau seulement s'il est arrivé depuis le début de la surveillance ET plus récent que
            # le précédent : le dernier message d'une conversation peut redevenir un plus ancien (le
            # dernier supprimé, une conversation reliée plus tard) — jamais un ancien message rejoué.
            if int(last.get("ts") or 0) / 1000 < st.primed_at - self.CLOCK_SKEW or not _newer(lid, prev):
                continue
            if not last.get("user") or (st.me and last.get("from") == st.me):
                continue
            text = str(last.get("text") or "").strip() or ("(pièce jointe)" if last.get("files") or last.get("images") else "")
            if not text:
                continue
            e = convs.get(tid)
            on_message(IncomingMessage(thread_id=tid, sender=str(last.get("sender") or ""), text=text,
                                       received_at=str(last.get("at") or ""), id=lid,
                                       surface=e.surface if e else Surface.dm))
        if st.primed_at is None:
            st.primed_at = now
        self._route("watch", "api")

    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        while not should_stop():
            try:
                self.watch_tick(on_message)
            except Exception:
                pass
            time.sleep(getattr(self._inner, "POLL_SECONDS", 5.0))

    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        """Non-lus : le service de chat pour les conversations qu'il relie, la page pour les autres."""
        st = self._chat
        if not st.ok or not st.mapped:
            return self._inner.list_unread(thread_ids)
        wanted = set(thread_ids) if thread_ids is not None else None
        out = [m for m in self._inner.list_unread(thread_ids) if m.thread_id not in st.mapped]
        kinds = dict(getattr(self._inner, "_kinds", {}) or {})
        for tid, cid in st.mapped.items():
            row = st.rows.get(cid)
            if (wanted is not None and tid not in wanted) or row is None or not self._unread(row):
                continue
            last = row["last"]
            text = str(last.get("text") or "").strip() or "(pièce jointe)"
            out.append(IncomingMessage(thread_id=tid, sender=str(last.get("sender") or ""), text=text,
                                       received_at=str(last.get("at") or ""), id=str(last.get("id")),
                                       surface=kinds.get(tid, Surface.dm)))
        return out

    def chat_map(self) -> dict:
        """État de la correspondance avec le service de chat (comptes seulement, aucun contenu)."""
        st = self._chat
        kinds: dict[str, int] = {}
        for r in st.rows.values():
            kinds[str(r.get("kind"))] = kinds.get(str(r.get("kind")), 0) + 1
        return {"ok": st.ok, "conversations": len(st.rows), "by_kind": kinds,
                "dm_named": sum(1 for r in st.rows.values() if r.get("kind") == "dm" and r.get("name")),
                "mapped": len(st.mapped), "mapped_by_name": sum(1 for t in st.mapped if t.startswith("name:")),
                # Non-lus selon le service de chat : ids et horizon seulement (aucun texte).
                "unread": [{"thread": t, "last": (st.rows[c].get("last") or {}).get("id"), "horizon": st.rows[c].get("horizon"),
                            "type_user": (st.rows[c].get("last") or {}).get("user")}
                           for t, c in st.mapped.items() if c in st.rows and self._unread(st.rows[c])][:20]}

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
        return {**out, "teams_web": {"routes": self.routes(), "chat_map": self.chat_map(),
                                     "signing": signing if isinstance(signing, dict) else None,
                                     "chatsvc": chat if isinstance(chat, dict) else None}}
