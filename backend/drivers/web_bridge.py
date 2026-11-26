from __future__ import annotations
import itertools
import queue
import threading
import time
from typing import Any, Callable, Iterable, Optional

import presence as presencemod
from drivers import rail_label
from drivers.base import SendUncertain, TeamsDriver
from drivers.preview_watch import PreviewWatcher
from models import IncomingMessage, Surface, WatchEntity


class BridgeUnavailable(RuntimeError):
    pass


class WebBridgeDriver(TeamsDriver):
    waits_for_relay = True
    POLL_WAIT = 20.0

    """« Teams intégré » (expérimental) : Teams web (teams.microsoft.com) in a hidden
    WebView2 window of Trame. Commands go to that page through the Trame UI, which
    relays them (/api/teams-web/poll) and returns the answers (/api/teams-web/reply).
    The page is read and typed into through its DOM: no mouse, no foreground window,
    the user's own Teams window is never touched."""

    RPC_TIMEOUT = 12.0
    POLL_SECONDS = 5.0

    def __init__(self) -> None:
        self._commands: "queue.Queue[dict]" = queue.Queue()
        self._pending: dict[int, dict] = {}
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._last_poll = 0.0
        self._names: dict[str, str] = {}
        self._kinds: dict[str, Surface] = {}
        self._title: Optional[str] = None
        self._previews = PreviewWatcher()

    # --- relay side (HTTP endpoints) ---
    def next_command(self, wait: float = 20.0) -> Optional[dict]:
        self._last_poll = time.monotonic()
        end = time.monotonic() + wait
        while True:
            try:
                cmd = self._commands.get(timeout=max(0.0, end - time.monotonic()))
            except queue.Empty:
                return None
            # A command whose caller already gave up must never run late: a "type"
            # that timed out was reported as not sent and must stay unsent.
            with self._lock:
                live = cmd["id"] in self._pending
            if live and time.time() < cmd["deadline"]:
                return cmd
            self._last_poll = time.monotonic()

    def deliver(self, cid: int, ok: bool, result: Any = None, error: Optional[str] = None) -> None:
        with self._lock:
            slot = self._pending.get(cid)
        if slot is not None:
            slot.update(ok=ok, result=result, error=error)
            slot["event"].set()

    def relay_connected(self) -> bool:
        return time.monotonic() - self._last_poll < 30.0

    def _rpc(self, op: str, timeout: Optional[float] = None, **args: Any) -> Any:
        if not self.relay_connected():
            raise BridgeUnavailable("Teams intégré : la fenêtre Teams de Trame n'est pas prête.")
        cid = next(self._ids)
        slot = {"event": threading.Event()}
        with self._lock:
            self._pending[cid] = slot
        wait = timeout or self.RPC_TIMEOUT
        # The deadline (epoch ms) travels with the command so the page refuses it once
        # the engine has stopped waiting, even if the relay was slow to fetch it.
        self._commands.put({"id": cid, "op": op, "args": args, "deadline": time.time() + wait,
                            "deadline_ms": int((time.time() + wait - 1.0) * 1000)})
        try:
            if not slot["event"].wait(wait):
                raise BridgeUnavailable(f"Teams intégré : pas de réponse à « {op} ».")
            if not slot.get("ok"):
                raise BridgeUnavailable(f"Teams intégré : {slot.get('error') or op + ' a échoué'}")
            return slot.get("result")
        finally:
            with self._lock:
                self._pending.pop(cid, None)

    # --- TeamsDriver ---
    def status(self) -> dict:
        try:
            ping = self._rpc("ping", timeout=4)
        except Exception as e:
            return {"relay": self.relay_connected(), "ready": False, "error": str(e)}
        self._title = ping.get("title")
        return {"relay": True, "ready": bool(ping.get("ready")), "title": ping.get("title")}

    def selftest(self) -> bool:
        return bool(self.status().get("ready"))

    def _items(self, deep: bool = False) -> list[dict]:
        out = []
        seen: set[str] = set()
        raw = self._rpc("list", timeout=20, deep=True) if deep else self._rpc("list")
        for it in raw or []:
            label = rail_label.parse(it.get("label") or "")
            if not label.name or rail_label.is_structural(label.name, it.get("aria") or ""):
                continue
            thread_id = rail_label.stable_id(it.get("id") or "") or f"name:{label.name}"
            if thread_id in seen:
                continue
            seen.add(thread_id)
            # The web label carries no kind: group and meeting chats are told by their id.
            if label.surface == Surface.dm and "@thread." in thread_id:
                label.surface = Surface.group
            # The web label is the visible text: presence is only on the avatar badge,
            # which the page reads apart (labels near the avatar, filtered here).
            if label.surface == Surface.dm and not label.is_self:
                label.presence = presencemod.first_of(it.get("presence")) or label.presence
                self._note_presence(thread_id, label.presence)
            out.append({**it, "thread_id": thread_id, "parsed": label})
            self._names[thread_id] = label.name
            self._kinds[thread_id] = label.surface
        return out

    def list_all_conversations(self) -> list[WatchEntity]:
        """The whole chat list: Teams only draws its beginning until it is scrolled."""
        return self.list_conversations(deep=True)

    def list_conversations(self, deep: bool = False) -> list[WatchEntity]:
        out = []
        for rank, it in enumerate(self._items(deep)):
            label = it["parsed"]
            self._names[it["thread_id"]] = label.name
            self._kinds[it["thread_id"]] = label.surface
            own = label.preview if label.preview_sender == "You" else None
            out.append(WatchEntity(thread_id=it["thread_id"], display_name=label.name, surface=label.surface,
                                   rank=rank, last_activity=label.last_time, unread=label.unread,
                                   is_self=label.is_self, own_preview=own, presence=label.presence))
        return out

    def is_screen_sharing(self) -> bool:
        return False

    def _name(self, thread_id: str) -> str:
        return self._names.get(thread_id) or (thread_id[5:] if thread_id.startswith("name:") else thread_id)

    def active_thread(self) -> Optional[str]:
        try:
            title = rail_label.title_conversation(self._rpc("title", timeout=4) or "")
        except Exception:
            return None
        if not title:
            return None
        for tid, name in self._names.items():
            if rail_label.same_name(name, title):
                return tid
        return f"name:{title}"

    def open_thread(self, thread_id: str) -> bool:
        name = self._name(thread_id)
        try:
            res = self._rpc("open", name=name, id=thread_id if not thread_id.startswith("name:") else "")
        except Exception as e:
            self.last_error = str(e)
            return False
        shown = rail_label.title_conversation((res or {}).get("title") or "") or ""
        if res and res.get("ok") and rail_label.same_name(shown, name):
            return True
        self.last_error = (f"Teams intégré : « {name} » pas ouverte"
                           f" ({(res or {}).get('error') or 'titre affiché : ' + (shown or 'aucun')})")
        return False

    # Teams web: « Nouvelle conversation », the person picked in the « À » field. Teams'
    # people search is not offered on its own: only the name the user chose is resolved.
    can_start_chat = True

    def mark_read(self, thread_id: str) -> bool:
        try:
            res = self._rpc("markread", name=self._name(thread_id), timeout=8) or {}
        except Exception as e:
            self.last_error = str(e)
            return False
        if not res.get("ok"):
            self.last_error = f"Teams intégré : {res.get('error') or 'marquer comme lu refusé'}"
            return False
        return True

    def start_chat(self, name: str) -> Optional[WatchEntity]:
        name = " ".join((name or "").split())
        try:
            res = self._rpc("newchat", name=name, timeout=25) or {}
        except Exception as e:
            self.last_error = str(e)
            return None
        shown = rail_label.title_conversation(res.get("title") or "") or ""
        if not (res.get("ok") and rail_label.same_name(shown, name)):
            self.last_error = (f"Teams intégré : conversation avec « {name} » pas ouverte"
                               f" ({res.get('error') or 'titre affiché : ' + (shown or 'aucun')})")
            return None
        # A chat that already had messages is in the list with its stable id; a brand-new
        # one only appears there after its first message: it goes by its name until then.
        thread_id = next((t for t, n in self._names.items()
                          if rail_label.same_name(n, shown) and self._kinds.get(t) == Surface.dm), None)
        if thread_id is None:
            try:
                thread_id = next((it["thread_id"] for it in self._items()
                                  if rail_label.same_name(it["parsed"].name, shown) and it["parsed"].surface == Surface.dm), None)
            except Exception:
                thread_id = None
        thread_id = thread_id or f"name:{shown}"
        self._names[thread_id] = shown
        self._kinds[thread_id] = Surface.dm
        return WatchEntity(thread_id=thread_id, display_name=shown, surface=Surface.dm)

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        return self.read_history(thread_id, last_n)[0]

    def read_history(self, thread_id: str, last_n: int) -> tuple[list[IncomingMessage], bool]:
        surface = self._kinds.get(thread_id, Surface.dm)
        # Going back in the history scrolls Teams up until enough messages were seen.
        res = self._rpc("read", last=last_n, timeout=30) or {}
        raw, top = res.get("messages") or [], bool(res.get("top"))
        msgs = [IncomingMessage(thread_id=thread_id, sender=(m.get("sender") or "").strip(), text=(m.get("text") or "").strip(),
                                received_at=m.get("at") or "", surface=surface)
                for m in raw if (m.get("text") or "").strip()]
        return msgs, top

    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        try:
            res = self._rpc("type", name=self._name(thread_id), text=text, send=send, timeout=15)
        except BridgeUnavailable as e:
            if send and "pas de réponse" in str(e):
                raise SendUncertain(str(e)) from e
            raise
        if send and res and res.get("uncertain"):
            raise SendUncertain(res.get("error") or "envoi non confirmé")
        if not (res and res.get("ok")):
            raise BridgeUnavailable(f"Teams intégré : {(res or {}).get('error') or 'saisie refusée'}")
        return True

    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        wanted = set(thread_ids) if thread_ids is not None else None
        out = []
        for it in self._items():
            label = it["parsed"]
            if (wanted is not None and it["thread_id"] not in wanted) or not label.unread:
                continue
            if label.preview and label.preview_sender not in (None, "You"):
                out.append(IncomingMessage(thread_id=it["thread_id"], sender=label.preview_sender, text=label.preview,
                                           received_at=label.last_time or "", surface=label.surface))
        return out

    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        while not should_stop():
            try:
                items = self._items()
                convs = {it["thread_id"]: WatchEntity(thread_id=it["thread_id"], display_name=it["parsed"].name,
                                                      surface=it["parsed"].surface) for it in items}
                for msg in self._previews.diff(((it["thread_id"], it.get("label") or "") for it in items), convs):
                    on_message(msg)
            except Exception:
                pass
            time.sleep(self.POLL_SECONDS)

    def diagnose(self, thread_id: Optional[str] = None) -> dict:
        report: dict = {"driver": "web_bridge", **self.status()}
        try:
            report["diagnose"] = self._rpc("diagnose", timeout=6)
        except Exception as e:
            report["diagnose"] = repr(e)
        return report
