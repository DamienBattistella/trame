"""Microsoft Graph in front of the Teams page driver.

Each action goes through Graph (documented v1.0 API, Trame's own sign-in, delegated
permissions) when Graph is signed in and allows it; otherwise, or on any Graph error,
the wrapped page driver does it as before. `routes()` tells which path served each action.

Everything not overridden here is the page driver's, untouched (writes stay on the page
in this first step)."""
from __future__ import annotations
import time
from typing import Any, Callable, Optional

from drivers.base import TeamsDriver
from models import IncomingMessage, Surface, WatchEntity
from msgraph import convert
from msgraph.auth import NotSignedIn
from msgraph.client import GraphClient, GraphError

ME_TTL = 3600.0
LIST_TOP = 50
MAX_READ = 100
PRESENCE_BATCH = 650  # getPresencesByUserId limit

_OWN = {"_inner", "_client", "_routes", "_me", "_chats", "_names", "_members", "_presence"}


class GraphDriver:
    def __init__(self, inner: TeamsDriver, client: Callable[[], Optional[GraphClient]]):
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_client", client)
        object.__setattr__(self, "_routes", {})
        object.__setattr__(self, "_me", (0.0, ""))
        object.__setattr__(self, "_chats", {})  # chat id -> surface
        object.__setattr__(self, "_names", {})  # display name (casefold) -> chat id
        object.__setattr__(self, "_members", {})  # 1:1 chat id -> other user's id
        object.__setattr__(self, "_presence", {})  # chat id -> (monotonic, presence) read by Graph

    # --- the page driver for everything else ---
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

    # --- routing ---
    def routes(self) -> dict[str, dict]:
        """Last path per action: {"read": {"via": "graph"|"page", "reason": …, "at": …}}."""
        return dict(self._routes)

    def _note(self, action: str, via: str, reason: Optional[str] = None) -> None:
        self._routes[action] = {"via": via, "reason": reason, "at": time.strftime("%H:%M:%S")}

    def _via(self, action: str, graph: Callable[[GraphClient], Any], page: Callable[[], Any]) -> Any:
        client = self._client()
        if client is None:
            self._note(action, "page", "Graph non connecté")
            return page()
        try:
            out = graph(client)
        except (GraphError, NotSignedIn, ValueError, KeyError, OSError) as e:
            self._note(action, "page", str(e)[:200])
            return page()
        self._note(action, "graph")
        return out

    def _me_id(self, client: GraphClient) -> str:
        at, me = self._me
        if not me or time.monotonic() - at > ME_TTL:
            me = str((client.get("/me", {"$select": "id"}) or {}).get("id") or "")
            if not me:
                raise KeyError("profil Graph illisible")
            self._me = (time.monotonic(), me)
        return me

    def _chat_id(self, client: GraphClient, thread_id: str) -> str:
        if not thread_id.startswith("name:"):
            return thread_id
        key = thread_id[5:].casefold()
        if key not in self._names:
            self._list(client)
        if key not in self._names:
            raise KeyError("conversation inconnue de Graph")
        return self._names[key]

    # --- conversations ---
    def _list(self, client: GraphClient, limit: int = LIST_TOP) -> list[WatchEntity]:
        me = self._me_id(client)
        out: list[WatchEntity] = []
        params = {"$expand": "members,lastMessagePreview", "$top": str(min(limit, LIST_TOP)),
                  "$orderby": "lastMessagePreview/createdDateTime desc"}
        for chat in client.pages("/me/chats", params, limit=limit):
            entity = convert.conversation(chat, me, len(out))
            if entity is None:
                continue
            self._chats[entity.thread_id] = entity.surface
            self._names[entity.display_name.casefold()] = entity.thread_id
            # Writes stay on the page, which opens a conversation by its name: teach it.
            for attr, value in (("_names", entity.display_name), ("_kinds", entity.surface)):
                known = getattr(self._inner, attr, None)
                if isinstance(known, dict):
                    known[entity.thread_id] = value
            if chat.get("chatType") == "oneOnOne":
                other = next((m.get("userId") for m in chat.get("members") or [] if m.get("userId") and m.get("userId") != me), None)
                if other:
                    self._members[entity.thread_id] = other
            out.append(entity)
        self._presences(client, out)
        return out

    def _presences(self, client: GraphClient, convs: list[WatchEntity]) -> None:
        ids = {self._members[c.thread_id]: c for c in convs if c.thread_id in self._members}
        if not ids:
            return
        try:
            res = client.post("/communications/getPresencesByUserId", {"ids": list(ids)[:PRESENCE_BATCH]}) or {}
        except GraphError as e:
            self._note("presence", "page", str(e)[:200])
            return
        by_id = {p.get("id"): convert.presence(p) for p in res.get("value") or []}
        now = time.monotonic()
        for uid, conv in ids.items():
            conv.presence = by_id.get(uid)
            if conv.presence:
                self._presence[conv.thread_id] = (now, conv.presence)
            else:
                self._presence.pop(conv.thread_id, None)
        self._note("presence", "graph")

    def presence(self) -> dict[str, str]:
        """What the page shows, overridden by what Graph read (fresher and exact)."""
        ttl, now = getattr(self._inner, "PRESENCE_TTL", 90.0), time.monotonic()
        graph = {tid: v for tid, (at, v) in list(self._presence.items()) if now - at <= ttl}
        return {**self._inner.presence(), **graph}

    def list_conversations(self, deep: bool = False) -> list[WatchEntity]:
        page = (lambda: self._inner.list_conversations(deep=True)) if deep else self._inner.list_conversations
        return self._via("list", lambda c: self._list(c, 200 if deep else LIST_TOP), page)

    def list_all_conversations(self) -> list[WatchEntity]:
        return self.list_conversations(deep=True)

    # --- reading a conversation ---
    def _read(self, client: GraphClient, thread_id: str, last_n: int) -> "tuple[list[IncomingMessage], bool]":
        chat = self._chat_id(client, thread_id)
        me = self._me_id(client)
        surface = self._chats.get(chat, Surface.dm)
        want = max(1, min(last_n, MAX_READ))
        raw = list(client.pages(f"/chats/{chat}/messages", {"$top": str(min(want, 50))}, limit=want))
        msgs = [m for m in (convert.message(thread_id, r, surface, me) for r in reversed(raw)) if m]
        return msgs, len(raw) < want

    def read_history(self, thread_id: str, last_n: int) -> "tuple[list[IncomingMessage], bool]":
        return self._via("read", lambda c: self._read(c, thread_id, last_n),
                         lambda: self._inner.read_history(thread_id, last_n))

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        return self.read_history(thread_id, last_n)[0]

    # --- my status ---
    def _my_status(self, client: GraphClient, with_message: bool) -> dict:
        p = client.get("/me/presence") or {}
        out: dict = {"presence": convert.presence(p)}
        if with_message:
            msg = ((p.get("statusMessage") or {}).get("message") or {})
            text, _ = convert.body_text(msg)
            out["message"] = " ".join(text.split())
        return out

    def my_status(self, with_message: bool = False) -> dict:
        return self._via("my_status", lambda c: self._my_status(c, with_message),
                         lambda: self._inner.my_status(with_message))

    # --- people and message search ---
    def _people(self, client: GraphClient, query: str, limit: int) -> list[str]:
        res = client.get("/me/people", {"$search": f'"{query}"', "$top": str(limit), "$select": "displayName"}) or {}
        names = [" ".join(str(p.get("displayName") or "").split()) for p in res.get("value") or []]
        return [n for n in names if n][:limit]

    def search_people(self, query: str, limit: int = 8) -> list[str]:
        query = " ".join((query or "").replace('"', " ").split())
        if not query:
            return []
        return self._via("search_people", lambda c: self._people(c, query, limit),
                         lambda: self._inner.search_people(query, limit))

    def _search(self, client: GraphClient, query: str, limit: int) -> list[dict]:
        body = {"requests": [{"entityTypes": ["chatMessage"], "query": {"queryString": query},
                              "from": 0, "size": min(limit, 25)}]}
        res = client.post("/search/query", body) or {}
        out = []
        for container in (res.get("value") or [{}])[0].get("hitsContainers") or []:
            for hit in container.get("hits") or []:
                r = hit.get("resource") or {}
                text, _ = convert.body_text({"contentType": "html", "content": hit.get("summary") or ""})
                if not text:
                    continue
                sender = ((r.get("from") or {}).get("emailAddress") or {}).get("name") or ""
                out.append({"conversation": "", "sender": " ".join(sender.split()), "mine": False,
                            "at": convert.when(r.get("createdDateTime")), "text": text})
        return out[:limit]

    def search_messages(self, query: str, limit: int = 25) -> list[dict]:
        query = " ".join((query or "").split())
        return self._via("search_messages", lambda c: self._search(c, query, limit),
                         lambda: self._inner.search_messages(query, limit))

    # --- diagnosis ---
    def diagnose(self, thread_id: Optional[str] = None) -> dict:
        out = self._inner.diagnose(thread_id) or {}
        return {**out, "graph": {"connected": self._client() is not None, "routes": self.routes()}}
