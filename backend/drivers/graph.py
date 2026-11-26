"""Microsoft Graph in front of the Teams page driver.

Each action goes through Graph (documented v1.0 API, Trame's own sign-in, delegated
permissions) when Graph is signed in and allows it; otherwise, or on any Graph error,
the wrapped page driver does it as before. `routes()` tells which path served each action.

Everything not overridden here is the page driver's, untouched (writes stay on the page
in this first step)."""
from __future__ import annotations
import html
import json
import re
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Optional, Sequence

from drivers.base import DeleteUncertain, Focus, ReactUncertain, SendUncertain, TeamsDriver, same_message
from models import REACTIONS, IncomingMessage, MessageRef, Surface, WatchEntity
from msgraph import convert
from msgraph.auth import NotSignedIn
from msgraph.client import GraphClient, GraphError

ME_TTL = 3600.0
LIST_TOP = 50
MAX_READ = 100
PRESENCE_BATCH = 650  # getPresencesByUserId limit

_OWN = {"_inner", "_client", "_routes", "_me", "_chats", "_names", "_members", "_presence", "_tenant"}

# Trame's status choices -> Graph preferred presence (availability, activity).
PREFERRED = {
    "available": ("Available", "Available"), "busy": ("Busy", "Busy"), "dnd": ("DoNotDisturb", "DoNotDisturb"),
    "brb": ("BeRightBack", "BeRightBack"), "away": ("Away", "Away"), "offline": ("Offline", "OffWork"),
}
DURATIONS = {"30m": timedelta(minutes=30), "1h": timedelta(hours=1), "2h": timedelta(hours=2)}
STATUS_POLLS, STATUS_POLL_WAIT = 4, 0.5


class WriteUncertain(RuntimeError):
    """Graph gave no clear answer to a write: it may have been applied. Never replayed on the page."""


def _iso_duration(delta: timedelta) -> str:
    minutes = max(5, int(delta.total_seconds() // 60))
    return f"PT{minutes // 60}H{minutes % 60}M" if minutes >= 60 else f"PT{minutes}M"


def _expiry(duration: Optional[str], until: Optional[datetime], now: datetime) -> Optional[timedelta]:
    if until is not None:
        return until - now
    if duration in DURATIONS:
        return DURATIONS[duration]
    if duration == "today":
        return now.replace(hour=23, minute=59, second=0, microsecond=0) - now
    if duration == "week":
        end = now + timedelta(days=6 - now.weekday())
        return end.replace(hour=23, minute=59, second=0, microsecond=0) - now
    return None


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
        object.__setattr__(self, "_tenant", "")

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

    def _write(self, action: str, graph: Callable[[GraphClient], Any], page: Callable[[], Any],
               uncertain: type = None) -> Any:
        """Like _via, for writes. The page only takes over after a clean refusal (4xx,
        not signed in, message not found or not the one picked). A timeout, a 429 or a
        5xx may hide a write that went through: reported uncertain, never redone."""
        client = self._client()
        if client is None:
            self._note(action, "page", "Graph non connecté")
            return page()
        uncertain = uncertain or WriteUncertain
        try:
            out = graph(client)
        except GraphError as e:
            if e.status >= 500 or e.status == 429:
                self._note(action, "graph", str(e)[:200])
                raise uncertain(str(e))
            self._note(action, "page", str(e)[:200])
            return page()
        except (ReactUncertain, DeleteUncertain, SendUncertain, WriteUncertain) as e:  # Graph wrote, without proof
            self._note(action, "graph", str(e)[:200])
            raise
        except (NotSignedIn, LookupError) as e:
            self._note(action, "page", str(e)[:200])
            return page()
        except OSError as e:
            self._note(action, "graph", str(e)[:200])
            raise uncertain(f"Microsoft Graph sans réponse : {e}")
        self._note(action, "graph")
        return out

    def _tenant_id(self, client: GraphClient) -> str:
        if not self._tenant:
            org = ((client.get("/organization", {"$select": "id"}) or {}).get("value") or [{}])[0]
            self._tenant = str(org.get("id") or "")
            if not self._tenant:
                raise LookupError("tenant Graph illisible")
        return self._tenant

    def _message(self, client: GraphClient, chat: str, target: MessageRef) -> dict:
        """The message the user picked, checked by author and text (same rule as the page)."""
        if not target.id:
            raise LookupError("message sans identifiant")
        raw = client.get(f"/chats/{chat}/messages/{target.id}") or {}
        sender = ((raw.get("from") or {}).get("user") or {}).get("displayName") or ""
        text, _ = convert.body_text(raw.get("body"))
        if not same_message(target, sender, text):
            raise LookupError("message différent de celui choisi")
        return raw

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

    # --- writes, step 2: read marks, reactions, deletion, status (docs/teams-graph.md) ---
    def _mark_read(self, client: GraphClient, thread_id: str) -> bool:
        chat = self._chat_id(client, thread_id)
        client.post(f"/chats/{chat}/markChatReadForUser",
                    {"user": {"id": self._me_id(client), "tenantId": self._tenant_id(client)}})
        return True

    def mark_read(self, thread_id: str) -> bool:
        return self._write("mark_read", lambda c: self._mark_read(c, thread_id),
                           lambda: self._inner.mark_read(thread_id))

    def _react(self, client: GraphClient, thread_id: str, target: MessageRef, reaction: str) -> Focus:
        chat = self._chat_id(client, thread_id)
        emoji, me = REACTIONS[reaction], self._me_id(client)

        def mine(message: dict) -> bool:
            return any(r.get("reactionType") in (reaction, emoji)
                       and ((r.get("user") or {}).get("user") or {}).get("id") == me
                       for r in message.get("reactions") or [])

        if not mine(self._message(client, chat, target)):  # already there: left alone, as on the page
            client.post(f"/chats/{chat}/messages/{target.id}/setReaction", {"reactionType": emoji})
            if not mine(client.get(f"/chats/{chat}/messages/{target.id}") or {}):
                raise ReactUncertain("Graph n'affiche pas la réaction après l'envoi")
        return Focus(ok=True)

    def react_focused(self, thread_id: str, target: MessageRef, reaction: str, restore: bool = True) -> Focus:
        return self._write("react", lambda c: self._react(c, thread_id, target, reaction),
                           lambda: self._inner.react_focused(thread_id, target, reaction, restore=restore),
                           ReactUncertain)

    def _delete(self, client: GraphClient, thread_id: str, target: MessageRef) -> Focus:
        chat = self._chat_id(client, thread_id)
        raw, me = self._message(client, chat, target), self._me_id(client)
        if ((raw.get("from") or {}).get("user") or {}).get("id") != me:
            raise LookupError("ce message n'est pas le tien : rien n'est supprimé")
        if not raw.get("deletedDateTime"):
            client.post(f"/users/{me}/chats/{chat}/messages/{target.id}/softDelete")
            if not (client.get(f"/chats/{chat}/messages/{target.id}") or {}).get("deletedDateTime"):
                raise DeleteUncertain("Graph n'affiche pas le message supprimé")
        return Focus(ok=True)

    def delete_focused(self, thread_id: str, target: MessageRef, restore: bool = True) -> Focus:
        return self._write("delete", lambda c: self._delete(c, thread_id, target),
                           lambda: self._inner.delete_focused(thread_id, target, restore=restore),
                           DeleteUncertain)

    def _set_status(self, client: GraphClient, choice: str, duration: Optional[str],
                    until: Optional[datetime]) -> Optional[str]:
        if choice == "reset":
            client.post("/me/presence/clearUserPreferredPresence")
        else:
            availability, activity = PREFERRED[choice]
            body = {"availability": availability, "activity": activity}
            expiry = _expiry(duration, until, datetime.now())
            if expiry is not None:
                body["expirationDuration"] = _iso_duration(expiry)
            client.post("/me/presence/setUserPreferredPresence", body)
        shown = None
        for i in range(STATUS_POLLS):  # Teams takes a moment to show the new status
            shown = convert.presence(client.get("/me/presence"))
            if choice == "reset" or shown == choice:
                break
            if i + 1 < STATUS_POLLS:
                time.sleep(STATUS_POLL_WAIT)
        return shown

    def set_my_status(self, choice: str, duration: Optional[str] = None,
                      until: Optional[datetime] = None) -> Optional[str]:
        def page() -> Optional[str]:
            if until is not None:
                return self._inner.set_my_status(choice, until=until)
            return self._inner.set_my_status(choice, duration) if duration else self._inner.set_my_status(choice)
        return self._write("set_status", lambda c: self._set_status(c, choice, duration, until), page)

    def _set_note(self, client: GraphClient, text: str) -> str:
        client.post("/me/presence/setStatusMessage",
                    {"statusMessage": {"message": {"content": text, "contentType": "text"}}})
        return self._my_status(client, True).get("message", "")

    def set_status_message(self, text: str) -> str:
        return self._write("set_note", lambda c: self._set_note(c, text),
                           lambda: self._inner.set_status_message(text))

    # --- writes, step 3: sending (text, mentions, quoted reply) and new 1:1 chats ---
    def _member_ids(self, client: GraphClient, chat: str, names: Sequence[str]) -> dict[str, str]:
        """Each mentioned name to the one member of the chat with exactly that name."""
        members = (client.get(f"/chats/{chat}/members") or {}).get("value") or []
        out = {}
        for name in names:
            found = [m.get("userId") for m in members
                     if " ".join(str(m.get("displayName") or "").split()).casefold() == " ".join(name.split()).casefold()]
            if len(found) != 1 or not found[0]:
                raise LookupError(f"« @{name} » : personne de ce nom dans la conversation, ou plusieurs")
            out[name] = found[0]
        return out

    @staticmethod
    def _html(text: str) -> str:
        return "<br>".join(html.escape(line, quote=False) for line in text.split("\n"))

    def _post(self, client: GraphClient, thread_id: str, text: str, reply_to: Optional[MessageRef],
              mentions: Sequence[str]) -> Focus:
        chat = self._chat_id(client, thread_id)
        content = self._html(text)
        body: dict = {"body": {"contentType": "html", "content": content}}
        if mentions:
            ids = self._member_ids(client, chat, mentions)
            body["mentions"] = []
            for n, name in enumerate(ids):
                tag = f"<at id=\"{n}\">{html.escape(name, quote=False)}</at>"
                pattern = re.compile(r"@" + re.escape(html.escape(name, quote=False)))
                if not pattern.search(content):
                    raise LookupError(f"« @{name} » absent du texte")
                content = pattern.sub(lambda _m, t=tag: t, content, count=1)
                body["mentions"].append({"id": n, "mentionText": name, "mentioned": {"user": {
                    "id": ids[name], "displayName": name, "userIdentityType": "aadUser"}}})
            body["body"]["content"] = content
        if reply_to is not None:
            raw = self._message(client, chat, reply_to)
            preview, _ = convert.body_text(raw.get("body"))
            sender = (raw.get("from") or {}).get("user") or {}
            body["attachments"] = [{"id": raw["id"], "contentType": "messageReference", "content": json.dumps({
                "messageId": raw["id"], "messagePreview": preview[:200],
                "messageSender": {"user": {"id": sender.get("id"), "displayName": sender.get("displayName"),
                                           "userIdentityType": "aadUser"}}})}]
            body["body"]["content"] = f'<attachment id="{raw["id"]}"></attachment>' + body["body"]["content"]
        try:
            created = client.post(f"/chats/{chat}/messages", body) or {}
        except GraphError as e:
            if e.status >= 500 or e.status == 429:
                raise SendUncertain(f"Microsoft Graph : {e}")
            raise
        except OSError as e:
            raise SendUncertain(f"Microsoft Graph sans réponse : {e}")
        mid = str(created.get("id") or "")
        # Sent only once Graph shows the message it created, with this text.
        try:
            shown = client.get(f"/chats/{chat}/messages/{mid}") if mid else None
        except (GraphError, OSError) as e:
            raise SendUncertain(f"message créé mais pas relu : {e}")
        shown_text, _ = convert.body_text((shown or {}).get("body"))
        want, _ = convert.body_text(body["body"])
        if not shown or " ".join(shown_text.split()) != " ".join(want.split()):
            raise SendUncertain("message créé mais pas retrouvé tel quel dans la conversation")
        return Focus(ok=True)

    def type_focused(self, thread_id: str, text: str, send: bool, restore: bool,
                     reply_to: Optional[MessageRef] = None, mentions: Sequence[str] = (),
                     files: Sequence[Any] = ()) -> Focus:
        def page() -> Focus:
            return self._inner.type_focused(thread_id, text, send, restore, reply_to=reply_to,
                                            mentions=mentions, files=files)
        # Graph sends, it never types into Teams' box (send=False), and files stay on the
        # page until sharing them with the chat members is done (docs/teams-graph.md).
        if not send or files or not text.strip():
            self._note("send", "page", "saisie sans envoi" if not send else "pièce jointe" if files else "texte vide")
            return page()
        return self._write("send", lambda c: self._post(c, thread_id, text, reply_to, mentions), page, SendUncertain)

    def type_reply(self, thread_id: str, text: str, send: bool, restore: bool = False) -> bool:
        return self.type_focused(thread_id, text, send, restore).ok

    def _start(self, client: GraphClient, name: str) -> WatchEntity:
        quoted = name.replace("'", "''")
        users = (client.get("/users", {"$filter": f"displayName eq '{quoted}'", "$select": "id,displayName"}) or {}).get("value") or []
        if len(users) != 1:
            raise LookupError(f"« {name} » : personne ou plusieurs personnes de ce nom dans l'annuaire")
        me, other = self._me_id(client), users[0]["id"]
        bind = "https://graph.microsoft.com/v1.0/users('{}')"
        chat = client.post("/chats", {"chatType": "oneOnOne", "members": [
            {"@odata.type": "#microsoft.graph.aadUserConversationMember", "roles": ["owner"], "user@odata.bind": bind.format(uid)}
            for uid in (me, other)]}) or {}
        if not chat.get("id"):
            raise LookupError("Graph n'a pas rendu la conversation")
        shown = " ".join(str(users[0].get("displayName") or name).split())
        self._chats[chat["id"]] = Surface.dm
        self._names[shown.casefold()] = chat["id"]
        self._members[chat["id"]] = other
        for attr, value in (("_names", shown), ("_kinds", Surface.dm)):
            known = getattr(self._inner, attr, None)
            if isinstance(known, dict):
                known[chat["id"]] = value
        return WatchEntity(thread_id=chat["id"], display_name=shown, surface=Surface.dm)

    def start_chat(self, name: str) -> Optional[WatchEntity]:
        name = " ".join((name or "").split())
        return self._write("start_chat", lambda c: self._start(c, name), lambda: self._inner.start_chat(name))

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
