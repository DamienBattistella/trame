from __future__ import annotations
import itertools
import re
import queue
import threading
import time
from datetime import datetime
from typing import Any, Callable, Iterable, Optional
from urllib.parse import quote

import presence as presencemod
from drivers import rail_label
from drivers.base import DeleteUncertain, EditUncertain, NeedsView, ReactUncertain, SendUncertain, TeamsDriver
from drivers.preview_watch import PreviewWatcher
from models import (DELETED_TEXT, REACTION_KEY, CardRef, ReactionCount, reaction_emoji, FileRef, ImageRef, IncomingMessage, LinkRef, MessageRef, QuoteRef, Surface,
                    WatchEntity)


class BridgeUnavailable(RuntimeError):
    pass


# Received attachments: what the page reports is checked before it reaches the UI.
# A link is kept only on Microsoft's file hosts (it opens in the user's browser).
FILE_HOSTS = re.compile(r"^https://([a-z0-9-]+\.)*(sharepoint\.com|onedrive\.(live\.)?com|1drv\.ms|teams\.microsoft\.com|"
                        r"teams\.cloud\.microsoft)(/|$)", re.IGNORECASE)
IMAGE_DATA = re.compile(r"^data:image/(jpeg|png|gif);base64,[A-Za-z0-9+/]+=*$")
MAX_FILES, MAX_IMAGES, MAX_IMAGE_CHARS = 10, 8, 1_500_000

# Appel API authentifié depuis la page (webfetch) : les seuls hôtes autorisés, ceux que le
# client Teams interroge déjà. La page applique la même liste ; on la redouble côté moteur
# pour refuser tout de suite un hôte tiers (défense en profondeur).
API_HOSTS = re.compile(r"^([a-z0-9-]+\.)*(teams\.microsoft\.com|teams\.cloud\.microsoft|teams\.live\.com|"
                       r"msg\.teams\.microsoft\.com|asyncgw\.teams\.microsoft\.com|presence\.teams\.microsoft\.com|"
                       r"substrate\.office\.com|graph\.microsoft\.com|outlook\.office365\.com)$", re.IGNORECASE)
# En-têtes d'authentification : le moteur ne les transmet jamais à la page (l'auth reste
# dans la page). On les retire des en-têtes métier avant l'envoi, en plus du filtre de la page.
AUTH_HEADER = re.compile(r"^(authorization|authentication|cookie|x-skypetoken|x-ms-\S*token|.*[-_]?token|.*bearer.*)$",
                         re.IGNORECASE)
# Service de chat (chatsvc) : chemins et paramètres permis, même liste que la page.
# Un id ne peut être ni « . » ni « .. », ni contenir un « / » ou « \ » encodé.
CHAT_PATHS = re.compile(r"/v1/users/ME/conversations(/(?!\.{1,2}(/|$))(?![^/]*%(2[fF]|5[cC]))[A-Za-z0-9%._~-]+"
                        r"(/messages(/\d{1,20})?)?)?")
CHAT_QUERY_KEYS = frozenset({"view", "pageSize", "startTime", "targetType", "syncState"})
# Id d'une conversation Teams (groupe, réunion, tête-à-tête) : « 19:…@thread.v2 », « 19:…@unq.gbl.spaces ».
CHAT_ID = re.compile(r"19:[A-Za-z0-9_.:=-]{1,200}@(thread\.(v2|skype|tacv2)|unq\.gbl\.spaces)|48:notes")


def _files(raw: Any) -> list[FileRef]:
    out = []
    for f in (raw if isinstance(raw, list) else [])[:MAX_FILES]:
        name = " ".join(str((f or {}).get("name") or "").split())[:200] if isinstance(f, dict) else ""
        if not name:
            continue
        url = str(f.get("url") or "")
        out.append(FileRef(name=name, url=url if FILE_HOSTS.match(url) else "", kind="video" if f.get("kind") == "video" else ""))
    return out


# Téléchargement pré-signé d'un fichier joint (op `filelink`) : SharePoint / OneDrive seulement.
DOWNLOAD_HOSTS = re.compile(r"^https://([a-z0-9-]+\.)*(sharepoint\.com|onedrive\.(live\.)?com|1drv\.ms)/", re.IGNORECASE)


def _images(raw: Any) -> list[ImageRef]:
    out = []
    for i in (raw if isinstance(raw, list) else [])[:MAX_IMAGES * 2]:
        i = i if isinstance(i, dict) else {}
        data = i.get("data")
        ok = isinstance(data, str) and len(data) <= MAX_IMAGE_CHARS and IMAGE_DATA.match(data)
        size = [max(0, min(10_000, int(i.get(k) or 0))) if str(i.get(k) or 0).isdigit() else 0 for k in ("width", "height")]
        out.append(ImageRef(data=data if ok else None, width=size[0] if ok else 0, height=size[1] if ok else 0))
    return out


MAX_LINKS, MAX_CARDS = 20, 5
WEB_URL = re.compile(r"^https?://[^\s/?#@]+[^\s]*$", re.IGNORECASE)


def _one_line(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _web_url(value: Any) -> str:
    """An http(s) address, else "" : nothing else is ever opened from a message."""
    url = str(value or "").strip()
    return url if len(url) <= 2000 and WEB_URL.match(url) else ""


def _links(raw: Any) -> list[LinkRef]:
    out = []
    for link in (raw if isinstance(raw, list) else [])[:MAX_LINKS]:
        link = link if isinstance(link, dict) else {}
        url = _web_url(link.get("url"))
        if url:
            out.append(LinkRef(text=_one_line(link.get("text"), 300) or url, url=url))
    return out


def _cards(raw: Any) -> list[CardRef]:
    out = []
    for card in (raw if isinstance(raw, list) else [])[:MAX_CARDS]:
        card = card if isinstance(card, dict) else {}
        fields = card.get("fields") if isinstance(card.get("fields"), list) else []
        ref = CardRef(source=_one_line(card.get("source"), 60), title=_one_line(card.get("title"), 200),
                      url=_web_url(card.get("url")), fields=[f for f in (_one_line(x, 120) for x in fields[:3]) if f])
        if ref.title or ref.url:
            out.append(ref)
    return out


def _quote(raw: Any) -> Optional[QuoteRef]:
    """Le message cité par une réponse, lu par la page : auteur, heure, extrait (borné)."""
    if not isinstance(raw, dict):
        return None
    text = raw.get("text") if isinstance(raw.get("text"), str) else ""
    ref = QuoteRef(sender=_one_line(raw.get("sender"), 200), at=_one_line(raw.get("at"), 40), text=text.strip()[:2000])
    return ref if ref.sender or ref.text else None


def _reaction_counts(raw: Any) -> list[ReactionCount]:
    """Toutes les réactions d'un message, telles que la page les lit : clé, nombre, et si l'une
    est la tienne. L'emoji est déduit ici de la clé (jamais pris tel quel de la page)."""
    out: list[ReactionCount] = []
    for r in (raw if isinstance(raw, list) else [])[:30]:
        key = r.get("key") if isinstance(r, dict) else None
        if not isinstance(key, str) or not REACTION_KEY.match(key):
            continue
        try:
            count = max(1, min(9999, int(r.get("count") or 1)))
        except (TypeError, ValueError):
            count = 1
        out.append(ReactionCount(key=key, emoji=reaction_emoji(key), count=count, mine=bool(r.get("mine"))))
    return out


def _mentions(raw: Any) -> list[str]:
    """Personnes mentionnées dans le message (@nom), sans doublon."""
    out: list[str] = []
    for name in (raw if isinstance(raw, list) else [])[:20]:
        name = _one_line(name, 200)
        if name and name not in out:
            out.append(name)
    return out


# Ce que Teams web affiche à la place d'un message supprimé (français, anglais), suivi
# un moment du lien « Annuler » collé au point : « Ce message a été supprimé.Annuler ».
_DELETED = re.compile(r"^(ce message a été supprimé|this message has been deleted)\.?\s*(annuler|undo)?$", re.I)


def _seen(status: Any) -> Optional[bool]:
    """Read receipt of one of your messages: True « Vu », False « Envoyé », None unknown."""
    return {"seen": True, "sent": False}.get(status) if isinstance(status, str) else None


class WebBridgeDriver(TeamsDriver):
    waits_for_relay = True
    supports_reactions = True
    supports_reply = True
    supports_mentions = True
    supports_delete = True
    supports_edit = True
    supports_teams_favorites = True
    POLL_WAIT = 20.0

    """« Teams intégré » (expérimental) : Teams web (teams.microsoft.com) in a hidden
    WebView2 window of Trame. Commands go to that page through the Trame UI, which
    relays them (/api/teams-web/poll) and returns the answers (/api/teams-web/reply).
    The page is read and typed into through its DOM: no mouse, no foreground window,
    the user's own Teams window is never touched."""

    RPC_TIMEOUT = 12.0
    # Réagir ou citer un ancien message : la page remonte le fil jusqu'à lui (15 s au plus).
    GESTURE_TIMEOUT = 30.0
    POLL_SECONDS = 5.0


    def __init__(self) -> None:
        # Conversation de Trame → id Teams, quand la liste de la page ne le montre pas (tête-à-tête
        # repéré par son nom) : tenu à jour par le pilote « API Teams web » depuis le service de chat.
        self.chat_aliases: dict[str, str] = {}
        self._commands: "queue.Queue[dict]" = queue.Queue()
        self._pending: dict[int, dict] = {}
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._last_poll = 0.0
        self._names: dict[str, str] = {}
        # Thread id -> the id Teams gives its row in the chat list (photos already read).
        self._row_ids: dict[str, str] = {}
        self._kinds: dict[str, Surface] = {}
        self._title: Optional[str] = None
        self._previews = PreviewWatcher()
        self._favorites: Optional[list[str]] = None

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
            result = slot.get("result")
            # Teams a refusé (ou l'opération a planté dans la page) : un repère a peut-être
            # changé, le moteur recontrôle la page plutôt que d'attendre l'heure suivante.
            if op not in self._QUIET_OPS and (not slot.get("ok") or (isinstance(result, dict) and result.get("ok") is False)):
                self._page_failed()
            if not slot.get("ok"):
                raise BridgeUnavailable(f"Teams intégré : {slot.get('error') or op + ' a échoué'}")
            return result
        finally:
            with self._lock:
                self._pending.pop(cid, None)

    # Opérations sans geste dans Teams : leur échec ne dit rien des repères.
    _QUIET_OPS = frozenset({"ping", "title", "probe", "diagnose", "webfetch", "filelink"})

    def _page_failed(self) -> None:
        hook = self.on_page_failure
        if hook is not None:
            try:
                hook()
            except Exception:
                pass

    def probe_page(self) -> Optional[dict]:
        # Lecture seule dans la page ; un survol du dernier message au plus (voir le pont).
        res = self._rpc("probe", timeout=8)
        return res if isinstance(res, dict) else None

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
        # Section Favoris : son en-tête dit si elle est dépliée ; repliée, ses conversations
        # ne sont pas dessinées et la liste lue ne dit rien des favoris.
        folder = next((f for f in raw or [] if f.get("folder") == "favorites"), None)
        favorites: Optional[list[str]] = [] if folder and "expanded=true" in (folder.get("aria") or "") else None
        for it in raw or []:
            label = rail_label.parse(it.get("label") or "")
            if it.get("folder") or not label.name or rail_label.is_structural(label.name, it.get("aria") or ""):
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
            self._note_activity(thread_id, typing=bool(it.get("typing") or it.get("typing_text")),
                                typing_text=it.get("typing_text") if it.get("open") else None,
                                seen=_seen(it.get("status")) if it.get("open") else None)
            out.append({**it, "thread_id": thread_id, "parsed": label})
            self._names[thread_id] = label.name
            self._kinds[thread_id] = label.surface
            if favorites is not None and it.get("fav"):
                favorites.append(thread_id)
        if favorites is not None:
            self._note_favorites(favorites)
        return out

    def _note_favorites(self, favorites: list[str]) -> None:
        changed = favorites != self._favorites
        self._favorites = favorites
        hook = self.on_favorites
        if changed and hook is not None:
            try:
                hook(list(favorites))
            except Exception:
                pass

    def teams_favorites(self) -> Optional[list[str]]:
        return list(self._favorites) if self._favorites is not None else None

    def set_teams_favorite(self, thread_id: str, favorite: bool) -> bool:
        try:
            res = self._rpc("favorite", name=self._name(thread_id), favorite=bool(favorite), timeout=12) or {}
        except Exception as e:
            self.last_error = str(e)
            return False
        if not res.get("ok"):
            self.last_error = f"Teams intégré : {res.get('error') or 'favori refusé'}"
            return False
        try:
            self._items()  # relit la section Favoris : le moteur s'aligne tout de suite
        except Exception:
            pass
        return True

    def list_all_conversations(self) -> list[WatchEntity]:
        """The whole chat list: Teams only draws its beginning until it is scrolled."""
        return self.list_conversations(deep=True)

    def list_conversations(self, deep: bool = False) -> list[WatchEntity]:
        return self._entities(self._items(deep))

    def _entities(self, items: list[dict]) -> list[WatchEntity]:
        out = []
        for rank, it in enumerate(items):
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

    # Réunions terminées : cartes « récapitulatif » de la conversation de réunion, et
    # transcription relue dans l'iframe SharePoint de l'onglet « Transcript ».
    supports_transcripts = True
    TRANSCRIPT_TIMEOUT = 150.0

    def _meeting_recaps_active(self) -> list[dict]:
        res = self._rpc("recaps", timeout=10) or {}
        return [r for r in res.get("recaps") or [] if isinstance(r, dict)]

    def meeting_transcript(self, thread_id: str, mid: str, probe: bool = False) -> dict:
        # The chat is opened by its name: a restarted engine learns it from the list first.
        if thread_id not in self._names:
            try:
                self._items()
            except Exception as e:
                return {"ok": False, "reason": "not_found", "error": str(e)}
        return super().meeting_transcript(thread_id, mid, probe)

    def _meeting_transcript_active(self, mid: str, probe: bool = False) -> dict:
        res = self._rpc("transcript", timeout=self.TRANSCRIPT_TIMEOUT, mid=str(mid), probe=bool(probe))
        return res if isinstance(res, dict) else {"ok": False, "reason": "error", "error": "réponse illisible"}

    # Teams web: « Nouvelle conversation », the person picked in the « À » field. Teams'
    # people search is not offered on its own: only the name the user chose is resolved.
    can_start_chat = True

    def _clear_active(self, thread_id: str) -> bool:
        res = self._rpc("clearcompose", name=self._name(thread_id), timeout=10) or {}
        if not res.get("ok"):
            self.last_error = f"Teams intégré : {res.get('error') or 'zone de saisie non vidée'}"
            return False
        return True

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

    # Teams web: the profile button (avatar, top right) says the status; its menu
    # « Modifier l'état » lists the choices, and holds the status message.
    can_set_status = True

    def my_status(self, with_message: bool = False) -> dict:
        res = self._rpc("mystatus", message=with_message, timeout=10 if with_message else 4) or {}
        if not res.get("ok"):
            raise BridgeUnavailable(f"Teams intégré : {res.get('error') or 'statut illisible'}")
        out: dict = {"presence": presencemod.own_from_labels(res.get("labels"))}
        if with_message:
            out["message"] = " ".join(str(res.get("message") or "").split())
        return out

    MAX_PHOTO_CHARS = 200_000

    can_link_files = True

    def file_link(self, url: str, thread_id: Optional[str] = None, show: bool = False) -> dict:
        if not FILE_HOSTS.match(url or ""):
            raise ValueError("lien hors SharePoint / OneDrive")
        if not show:
            res = self._rpc("filelink", timeout=20, url=url) or {}
        else:
            if not thread_id:
                raise NeedsView("conversation du fichier inconnue")
            # The chat is opened by its name: a restarted engine learns it from the list first.
            if thread_id not in self._names:
                self._items()
            with self.focused(thread_id, restore=True) as focus:
                if not focus.ok:
                    raise BridgeUnavailable(f"Teams intégré : {focus.reason}")
                res = self._rpc("filelink", timeout=25, url=url, show=True) or {}
        if not isinstance(res, dict) or not res.get("ok"):
            error = (res or {}).get("error") if isinstance(res, dict) else None
            if isinstance(res, dict) and res.get("reason") == "no_auth" and not show:
                raise NeedsView(error or "Teams n'a pas encore ouvert ce fichier")
            raise BridgeUnavailable(f"Teams intégré : {error or 'lien de téléchargement illisible'}")
        link = str(res.get("url") or "")
        if not DOWNLOAD_HOSTS.match(link) or len(link) > 4000:
            raise BridgeUnavailable("Teams intégré : lien de téléchargement inattendu")
        size = res.get("size")
        return {"name": _one_line(res.get("name"), 200), "size": size if isinstance(size, int) and size >= 0 else 0,
                "mime": _one_line(res.get("mime"), 100), "url": link}

    def my_photo(self) -> Optional[str]:
        res = self._rpc("myphoto", timeout=6) or {}
        if not res.get("ok"):
            raise BridgeUnavailable(f"Teams intégré : {res.get('error') or 'photo illisible'}")
        photo = res.get("photo")
        ok = isinstance(photo, str) and photo.startswith(("data:image/png;base64,", "data:image/jpeg;base64,"))
        return photo if ok and len(photo) <= self.MAX_PHOTO_CHARS else None

    MAX_PERSON_PHOTO_CHARS = 40_000

    def people_photos(self, known: Iterable[str] = ()) -> dict[str, str]:
        ids = {self._row_ids.get(t, t) for t in known}
        res = self._rpc("photos", timeout=20, known=sorted(ids)) or {}
        if not res.get("ok"):
            raise BridgeUnavailable(f"Teams intégré : {res.get('error') or 'photos illisibles'}")
        out: dict[str, str] = {}
        for it in res.get("photos") or []:
            if not isinstance(it, dict):
                continue
            photo, row_id = it.get("photo"), str(it.get("id") or "")
            thread_id = rail_label.stable_id(row_id)
            label = rail_label.parse(str(it.get("label") or ""))
            # Only a person's own photo: a group or meeting chat has no single face.
            if not thread_id or "@thread." in thread_id or label.is_self or label.surface != Surface.dm:
                continue
            if not (isinstance(photo, str) and photo.startswith(("data:image/png;base64,", "data:image/jpeg;base64,"))
                    and len(photo) <= self.MAX_PERSON_PHOTO_CHARS):
                continue
            self._row_ids[thread_id] = row_id
            out[thread_id] = photo
        return out

    def set_my_status(self, choice: str, duration: Optional[str] = None,
                      until: Optional[datetime] = None) -> Optional[str]:
        if choice not in presencemod.CHOICES:
            raise ValueError(f"statut inconnu : {choice}")
        if until is not None:
            if duration is not None or choice == "reset":
                raise ValueError("heure de fin impossible pour ce statut")
            # « Personnalisé » : le jour et l'heure locale, saisis puis relus dans le panneau.
            res = self._rpc("setstatusfor", choice=choice, duration="custom", date=f"{until:%Y-%m-%d}",
                            time=f"{until:%H:%M}", timeout=30) or {}
        elif duration is not None:
            if duration not in presencemod.DURATIONS or choice == "reset":
                raise ValueError(f"durée impossible : {duration}")
            res = self._rpc("setstatusfor", choice=choice, duration=duration, timeout=20) or {}
        else:
            res = self._rpc("setstatus", choice=choice, timeout=15) or {}
        if not res.get("ok"):
            raise BridgeUnavailable(f"Teams intégré : {res.get('error') or 'changement de statut refusé'}")
        return presencemod.own_from_labels(res.get("labels"))

    def set_status_message(self, text: str) -> str:
        res = self._rpc("setnote", text=" ".join((text or "").split()), timeout=15) or {}
        if not res.get("ok"):
            raise BridgeUnavailable(f"Teams intégré : {res.get('error') or 'message de statut refusé'}")
        return " ".join(str(res.get("message") or "").split())

    # Teams web: its search field, the Messages tab, then back to the chat list.
    can_search_messages = True

    def search_messages(self, query: str, limit: int = 25) -> list[dict]:
        res = self._rpc("search", query=" ".join((query or "").split()), limit=limit, timeout=35) or {}
        if not res.get("ok"):
            raise BridgeUnavailable(f"Teams intégré : {res.get('error') or 'recherche impossible'}")
        out = []
        for r in res.get("results") or []:
            text = (r.get("text") or "").strip()
            if text:
                out.append({"conversation": (r.get("conversation") or "").strip(), "sender": (r.get("sender") or "").strip(),
                            "mine": bool(r.get("mine")), "at": (r.get("at") or "").strip(), "text": text})
        return out[:limit]

    def search_messages_api(self, query: str, limit: int = 25, chats: int = 40) -> list[dict]:
        """Recherche faite DANS la page sur le service de chat : les derniers messages des
        conversations les plus récentes, sans ouvrir la recherche de Teams. Même forme que
        search_messages. Lève ApiError si le service refuse."""
        res = self._rpc("chatsearch", query=" ".join((query or "").split()), limit=limit, chats=chats, timeout=40)
        if not isinstance(res, dict) or not res.get("ok"):
            raise self.ApiError((res or {}).get("error") if isinstance(res, dict) else "réponse illisible de la page")
        out = []
        for r in res.get("results") or []:
            text = (r.get("text") or "").strip() if isinstance(r, dict) else ""
            if text:
                thread = str(r.get("thread") or "")
                out.append({"conversation": _one_line(r.get("conversation"), 200), "sender": _one_line(r.get("sender"), 200),
                            "mine": bool(r.get("mine")), "at": _one_line(r.get("at"), 40), "text": text[:4000],
                            "teams_id": thread if CHAT_ID.fullmatch(thread) else None})
        return out[:limit]

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        return self.read_history(thread_id, last_n)[0]

    def read_history(self, thread_id: str, last_n: int,
                     since: Optional[datetime] = None) -> tuple[list[IncomingMessage], bool]:
        # Going back in the history scrolls Teams up until enough messages were seen, or
        # until a message older than `since` (epoch ms, read from each message's date).
        args: dict[str, Any] = {"last": last_n}
        if since is not None:
            args["since"] = int(since.timestamp() * 1000)
        res = self._rpc("read", timeout=30, **args) or {}
        raw, top = res.get("messages") or [], bool(res.get("top"))
        # A meeting chat: the page gives the meeting's join link, checked before keeping it.
        self._note_meeting(thread_id, res.get("meeting"))
        return self._messages(thread_id, raw), top

    def read_history_api(self, thread_id: str, last_n: int,
                         since: Optional[datetime] = None) -> tuple[list[IncomingMessage], bool]:
        """Le fil lu sur le service de chat de Teams, DANS la page, sans ouvrir la conversation
        (donc sans la marquer comme lue). Même forme que read_history. Lève ApiError si la
        conversation n'a pas d'id Teams ou si le service refuse : l'appelant lit alors la page."""
        chat = self.chat_aliases.get(thread_id) or self.chat_id(thread_id)
        if not chat:
            raise self.ApiError("conversation sans identifiant Teams")
        args: dict[str, Any] = {"thread": chat, "last": last_n}
        if since is not None:
            args["since"] = int(since.timestamp() * 1000)
        res = self._rpc("chatread", timeout=40, **args)
        if not isinstance(res, dict):
            raise self.ApiError("réponse illisible de la page")
        if not res.get("ok"):
            raise self.ApiError(res.get("error") or "lecture refusée par le service de chat", status=res.get("status"))
        return self._messages(thread_id, res.get("messages") or []), bool(res.get("top"))

    def chat_list(self, sync: str = "", timeout: float = 30.0) -> dict:
        """La liste des conversations sur le service de chat de Teams, lue DANS la page : complète
        sans `sync`, sinon seulement ce qui a changé depuis. {rows, sync, full, me}. Lève ApiError
        sur un refus : l'appelant garde alors la liste de la page."""
        res = self._rpc("chatlist", sync=str(sync or ""), timeout=timeout)
        if not isinstance(res, dict):
            raise self.ApiError("réponse illisible de la page")
        if not res.get("ok"):
            raise self.ApiError(res.get("error") or "liste refusée par le service de chat", status=res.get("status"))
        rows = [r for r in (res.get("rows") or []) if isinstance(r, dict) and self.chat_id(str(r.get("id") or ""))]
        return {"rows": rows, "sync": str(res.get("sync") or ""), "full": bool(res.get("full")), "me": str(res.get("me") or "")}

    def chat_dm(self, mri: str, timeout: float = 20.0) -> dict:
        """Le tête-à-tête avec la personne `mri` sur le service de chat : trouvé par son id
        (calculé comme Teams), ou créé comme Teams le fait puis relu. {ok, id, created} ;
        {ok: False, attempted: False} : la page ouvre la conversation, comme avant."""
        try:
            res = self._rpc("chatdm", mri=str(mri or ""), timeout=timeout)
        except Exception as e:
            return {"ok": False, "attempted": False, "error": str(e)}
        if not isinstance(res, dict):
            return {"ok": False, "attempted": False, "error": "réponse illisible de la page"}
        if res.get("ok") and not CHAT_ID.fullmatch(str(res.get("id") or "")):
            return {"ok": False, "attempted": False, "error": "identifiant de tête-à-tête inattendu"}
        return res

    def meetings_api(self, threads: list[str], topics: Optional[dict] = None, timeout: float = 60.0) -> list[dict]:
        """Réunions terminées des conversations de réunion `threads` (ids Teams), lues DANS la page
        sur le service de chat : {thread, recaps: [{mid, when, transcript}]} par conversation. Lève
        ApiError si le service refuse."""
        res = self._rpc("chatmeetings", threads=list(threads), topics=dict(topics or {}), timeout=timeout)
        if not isinstance(res, dict) or not res.get("ok"):
            raise self.ApiError((res or {}).get("error") if isinstance(res, dict) else "réponse illisible de la page")
        out = []
        for c in res.get("chats") or []:
            if not isinstance(c, dict) or not c.get("ok") or not CHAT_ID.fullmatch(str(c.get("thread") or "")):
                continue
            recaps = []
            for r in c.get("recaps") or []:
                mid = str((r or {}).get("mid") or "")
                if mid.isdigit():
                    recaps.append({"mid": mid, "when": _one_line(r.get("when"), 80), "transcript": bool(r.get("transcript"))})
            out.append({"thread": str(c["thread"]), "recaps": recaps})
        return out

    def calendar_api(self, start: str, end: str, timeout: float = 30.0) -> list[dict]:
        """L'agenda du jour `start` au jour `end` (AAAA-MM-JJ, inclus), lu DANS la page sur Graph
        avec le jeton que Teams a posé. Chaque événement ne garde que ce qu'affiche un agenda.
        Lève ApiError si Graph refuse (jeton pas encore vu, droit manquant)."""
        res = self._rpc("calendarevents", start=str(start), end=str(end), timeout=timeout)
        if not isinstance(res, dict) or not res.get("ok"):
            raise self.ApiError((res or {}).get("error") if isinstance(res, dict) else "réponse illisible de la page")
        out = []
        for e in res.get("events") or []:
            if not isinstance(e, dict):
                continue
            thread = str(e.get("thread") or "")
            out.append({
                "id": _one_line(e.get("id"), 300),
                "subject": _one_line(e.get("subject"), 200),
                "start": _one_line(e.get("start"), 25),
                "end": _one_line(e.get("end"), 25),
                "all_day": e.get("all_day") is True,
                "start_day": _one_line(e.get("start_day"), 10),
                "end_day": _one_line(e.get("end_day"), 10),
                "show_as": _one_line(e.get("show_as"), 20),
                "private": e.get("private") is True,
                "cancelled": e.get("cancelled") is True,
                "online": e.get("online") is True,
                "join_url": str(e.get("join_url") or "")[:2000],
                "thread": thread if CHAT_ID.fullmatch(thread) else "",
                "organizer": _one_line(e.get("organizer"), 120),
                "location": _one_line(e.get("location"), 160),
                "recurring": e.get("recurring") is True,
                "response": _one_line(e.get("response"), 30),
            })
        return out

    def meeting_shapes(self, chats: int = 3, per: int = 60) -> dict:
        """Structure (jamais le contenu) des conversations de réunion récentes sur le service de
        chat, et ids des cartes de récapitulatif affichées : la découverte qui précède le câblage
        des réunions sur le service."""
        res = self._rpc("meetingshapes", chats=chats, per=per, timeout=30)
        return res if isinstance(res, dict) else {"ok": False, "error": "réponse illisible de la page"}

    def chat_gesture(self, kind: str, thread_id: str, timeout: float = 25.0, **args: Any) -> dict:
        """Un geste sur le service de chat (markread, react, delete, send), fait DANS la page :
        vérifié avant (bon message, le sien pour supprimer) puis prouvé par relecture.
        {ok} prouvé ; {attempted: False} rien n'est parti ; {uncertain: True} parti sans preuve."""
        chat = self.chat_aliases.get(thread_id) or self.chat_id(thread_id)
        if not chat:
            return {"ok": False, "attempted": False, "error": "conversation sans identifiant Teams"}
        if not self.relay_connected():
            # Refusé avant d'être mis en file : rien n'est parti (la file d'envoi réessaiera).
            return {"ok": False, "attempted": False, "error": "la fenêtre Teams de Trame n'est pas prête"}
        try:
            res = self._rpc("chatgesture", kind=kind, thread=chat, timeout=timeout, **args)
        except Exception as e:
            # Sans réponse de la page, on ne sait pas si le geste est parti.
            return {"ok": False, "attempted": True, "uncertain": True, "error": str(e)}
        return res if isinstance(res, dict) else {"ok": False, "attempted": True, "uncertain": True,
                                                  "error": "réponse illisible de la page"}

    def teams_people(self, kind: str, timeout: float = 15.0, **args: Any) -> dict:
        """Présence (« me », « of »), note de statut (« note ») ou recherche de personnes
        (« search »), faites DANS la page sur le middletier et le service de présence de Teams.
        Lève ApiError sur un refus avant écriture ; une note partie sans preuve revient
        {uncertain: True}."""
        res = self._rpc("teamspeople", kind=kind, timeout=timeout, **args)
        if not isinstance(res, dict):
            raise self.ApiError("réponse illisible de la page")
        if not res.get("ok") and not res.get("attempted"):
            raise self.ApiError(res.get("error") or "refusé par Teams", status=res.get("status"))
        return res

    @staticmethod
    def chat_id(thread_id: str) -> Optional[str]:
        """L'id de la conversation pour le service de chat (« 19:…@thread.v2 »). Les lignes de
        la liste de Teams le préfixent (« title-19:… ») ; une conversation repérée seulement par
        son nom (« name:… », un tête-à-tête dont la page ne montre pas l'id) n'en a pas : None."""
        tid = str(thread_id or "")
        tid = tid[len("title-"):] if tid.startswith("title-") else tid
        return tid if CHAT_ID.fullmatch(tid) else None

    def _messages(self, thread_id: str, raw: list) -> list[IncomingMessage]:
        """Messages bruts de la page (lecture DOM ou service de chat) vers le modèle."""
        surface = self._kinds.get(thread_id, Surface.dm)
        msgs = []
        for m in raw:
            m = m if isinstance(m, dict) else {}
            text = (m.get("text") or "").strip()
            files, images = _files(m.get("files")), _images(m.get("images"))
            links, cards = _links(m.get("links")), _cards(m.get("cards"))
            if not (text or files or images or cards):
                continue
            deleted = bool(_DELETED.match(" ".join(text.split())))
            msgs.append(IncomingMessage(thread_id=thread_id, sender=(m.get("sender") or "").strip(),
                                        text=DELETED_TEXT if deleted else text,
                                        received_at=m.get("at") or "", surface=surface, id=(m.get("id") or None),
                                        reactions=[r for r in (m.get("reactions") or []) if isinstance(r, str) and REACTION_KEY.match(r)][:20],
                                        reaction_counts=_reaction_counts(m.get("reactionCounts")),
                                        files=files, images=images, seen=_seen(m.get("status")), deleted=deleted,
                                        links=[] if deleted else links, cards=[] if deleted else cards,
                                        quote=None if deleted else _quote(m.get("quote")),
                                        mentions=[] if deleted else _mentions(m.get("mentions")),
                                        edited=not deleted and m.get("edited") is True,
                                        from_me=m.get("fromMe") if isinstance(m.get("fromMe"), bool) else None))
        return msgs

    @staticmethod
    def _ref(target: MessageRef) -> dict:
        return {"id": target.id or "", "sender": target.sender, "text": target.text}

    def react_to_last(self, thread_id: str) -> None:
        with self.focused(thread_id, restore=True) as focus:
            if focus.ok:
                self._rpc("reactlast", name=self._name(thread_id), timeout=10)

    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        return self._type(thread_id, text, send)

    def _reply_in_active(self, thread_id: str, target: MessageRef, text: str, send: bool) -> bool:
        # The page quotes the message (Teams « Répondre ») and checks the quote is in the
        # compose box before typing: on any doubt it clears the box and refuses.
        return self._type(thread_id, text, send, quote=self._ref(target))

    def _react_in_active(self, thread_id: str, target: MessageRef, reaction: str, remove: bool = False) -> bool:
        try:
            res = self._rpc("react", name=self._name(thread_id), message=self._ref(target), reaction=reaction,
                            remove=remove, timeout=self.GESTURE_TIMEOUT)
        except BridgeUnavailable as e:
            # No answer: the click may have happened. Say so rather than « rien n'a été fait ».
            if "pas de réponse" in str(e):
                raise ReactUncertain(str(e)) from e
            raise
        if res and res.get("uncertain"):
            raise ReactUncertain(res.get("error") or "réaction non confirmée")
        if not (res and res.get("ok")):
            raise BridgeUnavailable(f"Teams intégré : {(res or {}).get('error') or 'réaction refusée'}")
        return True

    def _delete_in_active(self, thread_id: str, target: MessageRef) -> bool:
        # The page finds the message (by id, author and text), checks Teams offers to edit
        # it (own messages only), then « … » → « Supprimer » and Teams' confirmation.
        try:
            res = self._rpc("delete", name=self._name(thread_id), message=self._ref(target), timeout=self.GESTURE_TIMEOUT)
        except BridgeUnavailable as e:
            if "pas de réponse" in str(e):
                raise DeleteUncertain(str(e)) from e
            raise
        if res and res.get("uncertain"):
            raise DeleteUncertain(res.get("error") or "suppression non confirmée")
        if not (res and res.get("ok")):
            raise BridgeUnavailable(f"Teams intégré : {(res or {}).get('error') or 'suppression refusée'}")
        return True

    def _edit_in_active(self, thread_id: str, target: MessageRef, text: str) -> bool:
        # Same checks as delete (Teams offers « Modifier » on own messages only), then the
        # text is replaced in the editor Teams opens and confirmed once shown in the thread.
        try:
            res = self._rpc("edit", name=self._name(thread_id), message=self._ref(target), text=text,
                            timeout=self.GESTURE_TIMEOUT)
        except BridgeUnavailable as e:
            if "pas de réponse" in str(e):
                raise EditUncertain(str(e)) from e
            raise
        if res and res.get("uncertain"):
            raise EditUncertain(res.get("error") or "modification non confirmée")
        if not (res and res.get("ok")):
            raise BridgeUnavailable(f"Teams intégré : {(res or {}).get('error') or 'modification refusée'}")
        return True

    def _type_with_mentions(self, thread_id: str, text: str, send: bool, mentions: list[str],
                            reply_to: Optional[MessageRef] = None) -> bool:
        quote = self._ref(reply_to) if reply_to is not None else None
        return self._type(thread_id, text, send, quote=quote, mentions=mentions)

    # Teams web: the files go through its own « Joindre » file input (or a drop on the
    # editor), then the message is sent with them. Upload to OneDrive takes a while.
    can_attach = True
    ATTACH_TIMEOUT = 90.0

    def _send_files_into_active(self, thread_id, text, files, reply_to=None) -> bool:
        # Only the bytes the user chose travel to the page: never a path for it to read.
        return self._type(thread_id, text, True, quote=self._ref(reply_to) if reply_to else None,
                          files=[f.wire() for f in files])

    def _type(self, thread_id: str, text: str, send: bool, quote: Optional[dict] = None,
              mentions: Optional[list[str]] = None, files: Optional[list[dict]] = None) -> bool:
        args: dict = {"name": self._name(thread_id), "text": text, "send": send}
        if quote is not None:
            args["quote"] = quote
        if mentions:
            args["mentions"] = mentions
        if files:
            args["files"] = files
        # Each mention waits for Teams' suggestions: a few more seconds per person.
        timeout = self.ATTACH_TIMEOUT if files else (self.GESTURE_TIMEOUT + 6 if quote else 15) + 6 * len(mentions or [])
        try:
            res = self._rpc("type", timeout=timeout, **args)
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

    def watch_tick(self, on_message: Callable[[IncomingMessage], None]) -> None:
        """One look at the chat list: new previews become messages."""
        items = self._items()
        entities = self._entities(items)
        # Non-lu, heure et ordre de la liste : le moteur les suit à chaque coup d'œil,
        # pas seulement à la connexion.
        hook = self.on_conversations
        if hook is not None and entities:
            try:
                hook(entities)
            except Exception:
                pass
        convs = {e.thread_id: e for e in entities}
        for msg in self._previews.diff(((it["thread_id"], it.get("label") or "") for it in items), convs):
            on_message(msg)

    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        while not should_stop():
            try:
                self.watch_tick(on_message)
            except Exception:
                pass
            time.sleep(self.POLL_SECONDS)

    # --- Appels aux API internes de Teams, faits DANS la page ---------------
    # L'« appel API » n'est pas émis par le moteur : c'est une commande envoyée à la page,
    # qui exécute le fetch avec sa propre session authentifiée et ne renvoie que le corps
    # métier parsé. Le jeton ne quitte jamais la page : le moteur ne reçoit aucun en-tête
    # d'auth, n'en transmet aucun, et refuse tout hôte hors des services Teams.
    class ApiError(RuntimeError):
        def __init__(self, message: str, status: Optional[int] = None) -> None:
            super().__init__(message)
            self.status = status

    def page_fetch(self, url: str, method: str = "GET", body: Any = None,
                   headers: Optional[dict] = None, json: bool = True, sign: bool = True,
                   timeout: float = 20.0) -> dict:
        """Un appel authentifié exécuté dans la page. Renvoie {status, contentType, json|text}.
        `sign` (défaut vrai) : la PAGE rejoue l'auth que Teams a posée pour cet hôte ; le moteur
        ne fournit ni ne reçoit jamais de credential. Lève ApiError si l'hôte est refusé, si le
        réseau échoue, ou sur une réponse non 2xx : l'appelant peut alors retomber sur le DOM."""
        if not str(url or "").lower().startswith("https://"):
            raise self.ApiError("https requis")
        host = str(url)[len("https://"):].split("/")[0].split("?")[0]
        if not API_HOSTS.match(host):
            raise self.ApiError(f"hôte non autorisé : {host or '(vide)'}")
        clean = {k: v for k, v in (headers or {}).items() if not AUTH_HEADER.match(str(k))} or None
        res = self._rpc("webfetch", url=url, method=method, body=body, headers=clean, json=bool(json),
                        sign=bool(sign), timeout=timeout)
        if not isinstance(res, dict):
            raise self.ApiError("réponse illisible de la page")
        status = res.get("status")
        if not res.get("ok"):
            raise self.ApiError(res.get("error") or f"appel API refusé (HTTP {status})", status=status)
        # Jamais d'en-tête de réponse : seul le corps métier et son type remontent.
        return {"status": status, "contentType": res.get("contentType"),
                "json": res.get("json"), "text": res.get("text")}

    # Service de chat de Teams (chatsvc), appelé dans la page avec sa propre session : le moteur
    # ne donne qu'un chemin et des paramètres permis, et ne reçoit que le corps métier.
    def chat_get(self, path: str, query: Optional[dict] = None, timeout: float = 20.0) -> Any:
        """GET sur le service de chat de Teams, exécuté dans la page. Renvoie le JSON du corps.
        Lève ApiError si le chemin est refusé, si la session n'a pas pu s'ouvrir ou sur une
        réponse non 2xx : l'appelant retombe alors sur la page (DOM)."""
        p = str(path or "")
        if not CHAT_PATHS.fullmatch(p):
            raise self.ApiError("chemin du service de chat non autorisé")
        q = {k: v for k, v in (query or {}).items() if k in CHAT_QUERY_KEYS and v is not None} or None
        res = self._rpc("chatsvc", path=p, query=q, timeout=timeout)
        if not isinstance(res, dict):
            raise self.ApiError("réponse illisible de la page")
        if not res.get("ok"):
            raise self.ApiError(res.get("error") or f"service de chat refusé (HTTP {res.get('status')})",
                                status=res.get("status"))
        return res.get("json")

    @staticmethod
    def chat_conversation_path(thread_id: str, messages: bool = False) -> str:
        """Chemin chatsvc d'une conversation (id encodé comme le fait le client Teams)."""
        path = "/v1/users/ME/conversations/" + quote(str(thread_id), safe="")
        return path + "/messages" if messages else path

    def api_capture(self) -> dict:
        """Résumé en lecture seule des API internes repérées (structure uniquement : ni
        jeton, ni paramètre de requête, ni contenu de message). Sert à la découverte."""
        res = self._rpc("diagnose", timeout=6)
        cap = res.get("api_capture") if isinstance(res, dict) else None
        return cap if isinstance(cap, dict) else {"count": 0, "byService": {}, "endpoints": []}

    def diagnose(self, thread_id: Optional[str] = None) -> dict:
        report: dict = {"driver": "web_bridge", **self.status()}
        try:
            report["diagnose"] = self._rpc("diagnose", timeout=6)
        except Exception as e:
            report["diagnose"] = repr(e)
        return report
