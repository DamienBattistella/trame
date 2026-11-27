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
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional

import presence as presencemod
from drivers.base import DeleteUncertain, Focus, ReactUncertain, SendUncertain, TeamsDriver
from models import IncomingMessage, MessageRef, Surface, WatchEntity

# Attributs propres au wrapper (les autres sont lus/écrits sur le pilote de la page).
_OWN = {"_inner", "_routes", "_routes_lock", "_chat"}


def _norm(text: Optional[str]) -> str:
    t = " ".join(str(text or "").replace("…", " ").replace("...", " ").split()).casefold()
    return t.strip(" .,;:!?")


def _same_message(seen: Optional[tuple], row: dict) -> bool:
    """Le dernier message que la page affiche est-il celui de cette conversation sur le service de
    chat ? Oui si l'aperçu (souvent tronqué) est le début de son texte, ou si l'heure affichée est
    la même à la minute (« 13:44 ») ou le même jour (« 25/11 », « Hier »). Sinon : non (prudence)."""
    return _evidence(seen, row) is not None


def _evidence(seen: Optional[tuple], row: dict) -> Optional[str]:
    """Force de la concordance : « text » (même début de texte), « minute » (même heure à la
    minute), « day » (même jour seulement), None (aucune). Lire se contente du jour ; écrire
    exige le texte ou la minute (deux conversations d'une même personne, actives le même jour,
    ne doivent jamais être confondues pour un envoi)."""
    preview, when = seen if isinstance(seen, tuple) else (seen, None)
    last = row.get("last") or {}
    p, a = _norm(preview), _norm(last.get("text"))
    n = min(len(p), len(a), 24)
    if n >= 3 and p[:n] == a[:n]:
        return "text"
    if not _same_when(when, last.get("ts")):
        return None
    return "minute" if ":" in str(when or "") else "day"


def _same_when(shown: Optional[str], ts: Any, now: Optional[datetime] = None) -> bool:
    """L'heure affichée par la liste de la page (« 13:44 », « Hier », « 26/11 », « 26/11/2025 »)
    désigne-t-elle le moment `ts` (ms) du dernier message ? Comparé sur la date réelle : la liste
    écrit « 26/11 » là où le fil écrit « Hier 18:31 »."""
    try:
        when = datetime.fromtimestamp(int(ts) / 1000)
    except (TypeError, ValueError, OSError):
        return False
    s = str(shown or "").strip().casefold()
    now = now or datetime.now()
    if not s or int(ts) <= 0:
        return False
    hm = re.fullmatch(r"(\d{1,2})[:h](\d{2})", s)
    if hm:
        return (when.hour, when.minute) == (int(hm.group(1)), int(hm.group(2))) and (now - when).total_seconds() < 86400
    if s in ("hier", "yesterday"):
        return when.date() == (now - timedelta(days=1)).date()
    dmy = re.fullmatch(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", s)
    if dmy:
        year = dmy.group(3)
        same = (when.day, when.month) == (int(dmy.group(1)), int(dmy.group(2)))
        return same and (year is None or when.year % 100 == int(year) % 100)
    return False


def _shown_text(last: dict) -> str:
    """Texte d'un dernier message ; une image ou un fichier seul est dit comme tel."""
    text = str(last.get("text") or "").strip()
    if text:
        return text
    if last.get("files"):
        return "(fichier)"
    return "(image)" if last.get("images") else ""


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
        self.refused = 0  # reliées par le nom mais dont l'aperçu ne concorde pas
        self.self_seen: dict = {}  # conversation avec soi-même : candidats (heures seulement)
        # Reliées par le nom avec une preuve forte (texte, minute, ou soi-même) : seules celles-ci
        # (et celles dont l'id Teams est dans l'id de la page) reçoivent des gestes par le service.
        self.strong: set[str] = set()
        self.presence_at = 0.0  # dernière lecture de la présence des tête-à-tête

# Actions suivies, dans l'ordre d'affichage. Libellés côté UI (ApiTeamsWebSettings).
ACTIONS = ("list", "read", "watch", "unread", "presence", "my_status", "search_people",
           "search_messages", "mark_read", "react", "delete", "set_status", "set_note",
           "send", "start_chat", "meetings", "transcript")


class WebApiDriver:
    # Actions déjà câblées sur le service de chat (les autres restent sur la page).
    API_ACTIONS = frozenset({"read", "watch", "unread", "mark_read", "react", "delete", "send",
                             "presence", "my_status", "set_note", "search_people"})
    # Présence des tête-à-tête : relue sur le service au plus toutes les PRESENCE_EVERY secondes.
    PRESENCE_EVERY = 60.0
    # Note de statut sans échéance : « jamais », comme le choix par défaut de Teams.
    NOTE_NEVER = "9999-12-31T23:59:59.999Z"
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

    def _chat_for(self, entity: WatchEntity, dm_names: dict[str, Optional[str]], preview: Optional[tuple]) -> Optional[str]:
        rows = self._chat.rows
        chat_id = getattr(self._inner, "chat_id", None)
        cid = chat_id(entity.thread_id) if callable(chat_id) else None
        if cid:  # l'id Teams est dans l'id de la page : aucune supposition
            return cid if cid in rows else None
        # Sans id dans la page, on relie par le nom, puis on le prouve : l'aperçu que la page
        # affiche doit être le dernier message de cette conversation. Sinon, rien (constaté en
        # direct : un tête-à-tête relié par son nom à une autre conversation de la même personne).
        if entity.is_self:
            # Conversation avec soi-même : « 48:notes », ou un tête-à-tête dont l'autre est soi.
            me = self._chat.me
            mine = [c for c, r in rows.items() if c == "48:notes" or (r.get("kind") == "dm" and me and r.get("other") == me)]
            self._chat.self_seen = {"page_time": (preview or (None, None))[1],
                                    "candidates": [{"kind": "notes" if c == "48:notes" else "dm", "at": (rows[c].get("last") or {}).get("at")}
                                                   for c in mine]}
            hit = next((c for c in mine if _same_message(preview, rows[c])), None)
            if hit:  # tous les candidats sont à soi : un geste ne peut pas partir chez un autre
                self._chat.strong.add(entity.thread_id)
            return hit
        elif entity.thread_id.startswith("name:") and entity.surface == Surface.dm:
            cid = dm_names.get(entity.display_name.casefold())
        if not cid:
            return None
        proof = _evidence(preview, rows[cid])
        if proof is None:
            self._chat.refused += 1
            return None
        if proof in ("text", "minute"):
            self._chat.strong.add(entity.thread_id)
        return cid

    def _map(self, entities: list[WatchEntity], previews: Optional[dict[str, tuple]] = None) -> dict[str, str]:
        """Conversations de la page reliées à leur id Teams. Un tête-à-tête n'est relié que par un
        nom porté par UNE seule conversation (deux homonymes : rien) et dont le dernier message est
        celui que la page affiche : sinon la page reste la source."""
        previews = previews or {}
        dm_names: dict[str, Optional[str]] = {}
        for cid, r in self._chat.rows.items():
            name = str(r.get("name") or "").casefold()
            if r.get("kind") == "dm" and name:
                dm_names[name] = None if name in dm_names else cid
        mapped = {}
        self._chat.refused = 0
        self._chat.strong = set()
        for e in entities:
            cid = self._chat_for(e, dm_names, previews.get(e.thread_id))
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
        previews = {it["thread_id"]: (getattr(it.get("parsed"), "preview", None), getattr(it.get("parsed"), "last_time", None))
                    for it in items}
        mapped = self._map(entities, previews) if api else {}
        st = self._chat
        if api:
            for e in entities:
                row = st.rows.get(mapped.get(e.thread_id, ""))
                if row is not None:
                    e.unread = self._unread(row)
            self._route("unread", "api")
        if api:
            self._refresh_presence(entities, mapped)
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
            text = _shown_text(last)
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
            text = _shown_text(last) or "(pièce jointe)"
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
                "refused_by_preview": st.refused, "self": st.self_seen,
                "writable_by_name": sum(1 for t in st.mapped if t.startswith("name:") and t in st.strong),
                # Non-lus selon le service de chat : ids et horizon seulement (aucun texte).
                "unread": [{"thread": t, "last": (st.rows[c].get("last") or {}).get("id"), "horizon": st.rows[c].get("horizon"),
                            "type_user": (st.rows[c].get("last") or {}).get("user")}
                           for t, c in st.mapped.items() if c in st.rows and self._unread(st.rows[c])][:20]}

    # --- Gestes sur le service de chat, sans ouvrir la conversation ----------------------
    # Prouvés par relecture du service. Rien n'est parti (pas d'id Teams, message différent,
    # service indisponible avant l'appel) : la page fait le geste, comme avant. Parti sans
    # preuve : « incertain », jamais refait (un double est pire qu'un doute).
    def _gesture(self, action: str, kind: str, thread_id: str, **args: Any) -> Optional[dict]:
        gesture = getattr(self._inner, "chat_gesture", None)
        if not callable(gesture):
            return None
        chat_id = getattr(self._inner, "chat_id", None)
        if not (callable(chat_id) and chat_id(thread_id)) and thread_id not in self._chat.strong:
            self._route(action, "page", "repli sur la page : conversation reliée sans preuve suffisante pour écrire")
            return None
        res = gesture(kind, thread_id, **args)
        if res.get("ok"):
            self._route(action, "api")
            return res
        if not res.get("attempted"):
            self._route(action, "page", f"repli sur la page : {res.get('error') or 'geste non tenté'}")
            return None
        self._route(action, "api", res.get("error"))
        return res

    def mark_read(self, thread_id: str) -> bool:
        res = self._gesture("mark_read", "markread", thread_id)
        if res is None:
            return self._inner.mark_read(thread_id)
        if not res.get("ok"):
            self._inner.last_error = res.get("error") or "marquer comme lu non confirmé"
        return bool(res.get("ok"))

    def react_focused(self, thread_id: str, target: MessageRef, reaction: str, restore: bool = True) -> Focus:
        res = self._gesture("react", "react", thread_id, message=self._inner._ref(target), reaction=reaction)
        if res is None:
            return self._inner.react_focused(thread_id, target, reaction, restore=restore)
        if res.get("uncertain"):
            raise ReactUncertain(res.get("error") or "réaction non confirmée")
        return Focus(ok=bool(res.get("ok")), reason=None if res.get("ok") else res.get("error"))

    def delete_focused(self, thread_id: str, target: MessageRef, restore: bool = True) -> Focus:
        res = self._gesture("delete", "delete", thread_id, message=self._inner._ref(target))
        if res is None:
            return self._inner.delete_focused(thread_id, target, restore=restore)
        if res.get("uncertain"):
            raise DeleteUncertain(res.get("error") or "suppression non confirmée")
        return Focus(ok=bool(res.get("ok")), reason=None if res.get("ok") else res.get("error"))

    def type_focused(self, thread_id: str, text: str, send: bool, restore: bool,
                     reply_to: Optional[MessageRef] = None, mentions: Any = (), files: Any = ()) -> Focus:
        """Un envoi de texte simple part par le service de chat ; une saisie sans envoi, une
        réponse citée, une mention ou une pièce jointe passent par la page."""
        if send and reply_to is None and not mentions and not files and text.strip():
            res = self._gesture("send", "send", thread_id, text=text)
            if res is not None:
                if res.get("uncertain"):
                    raise SendUncertain(res.get("error") or "envoi non confirmé")
                return Focus(ok=bool(res.get("ok")), reason=None if res.get("ok") else res.get("error"))
        kwargs: dict[str, Any] = {}
        if reply_to is not None:
            kwargs["reply_to"] = reply_to
        if mentions:
            kwargs["mentions"] = mentions
        if files:
            kwargs["files"] = files
        return self._inner.type_focused(thread_id, text, send, restore, **kwargs)

    # --- Présence, statut, note et recherche de personnes ------------------------------
    def _people(self, action: str, kind: str, **args: Any) -> Optional[dict]:
        call = getattr(self._inner, "teams_people", None)
        if not callable(call):
            return None
        try:
            res = call(kind, **args)
        except Exception as e:
            self._route(action, "page", f"repli sur la page : {e}")
            return None
        self._route(action, "api", res.get("error") if not res.get("ok") else None)
        return res

    def _refresh_presence(self, entities: list[WatchEntity], mapped: dict[str, str]) -> None:
        """Présence des tête-à-tête reliés, lue sur le service (toute la liste, pas seulement les
        lignes que la page dessine), au plus toutes les PRESENCE_EVERY secondes ; la page garde la
        main pour les autres."""
        st = self._chat
        others = {e.thread_id: (st.rows.get(mapped.get(e.thread_id, "")) or {}).get("other")
                  for e in entities if e.surface == Surface.dm and not e.is_self}
        others = {t: m for t, m in others.items() if m}
        if not others or time.time() - st.presence_at < self.PRESENCE_EVERY:
            return
        st.presence_at = time.time()
        res = self._people("presence", "of", mris=sorted(set(others.values())))
        people = (res or {}).get("people") or {}
        note = getattr(self._inner, "_note_presence", None)
        for e in entities:
            p = people.get(others.get(e.thread_id, ""))
            if p is None:
                continue
            e.presence = presencemod.from_service(p.get("availability"), p.get("activity"), bool(p.get("ooo")))
            if callable(note):
                note(e.thread_id, e.presence)

    def my_status(self, with_message: bool = False) -> dict:
        res = self._people("my_status", "me")
        if res is None or not res.get("ok"):
            return self._inner.my_status(with_message)
        out: dict = {"presence": presencemod.from_service(res.get("availability"), res.get("activity"), bool(res.get("ooo")))}
        if with_message:
            out["message"] = " ".join(str((res.get("note") or {}).get("message") or "").split())
        return out

    def set_status_message(self, text: str) -> str:
        """Note de statut écrite sur le service puis relue. Son échéance est gardée (sinon :
        jamais, comme Teams). Rien n'est parti : la page écrit la note, comme avant."""
        current = self._people("set_note", "me")
        if current is None or not current.get("ok"):
            return self._inner.set_status_message(text)
        expiry = str((current.get("note") or {}).get("expiry") or "")
        if not expiry or expiry < datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"):
            expiry = self.NOTE_NEVER
        res = self._people("set_note", "note", message=" ".join((text or "").split()), expiry=expiry)
        if res is None:
            return self._inner.set_status_message(text)
        if not res.get("ok"):
            # Partie sans preuve : jamais réécrite par la page (le moteur dit de vérifier).
            raise RuntimeError(res.get("error") or "message de statut non confirmé : vérifie dans Teams")
        return " ".join(str(res.get("message") or "").split())

    @property
    def can_search_people(self) -> bool:
        return callable(getattr(self._inner, "teams_people", None)) or bool(getattr(self._inner, "can_search_people", False))

    def search_people(self, query: str, limit: int = 8) -> list[str]:
        res = self._people("search_people", "search", query=query, limit=limit)
        if res is None or not res.get("ok"):
            return self._inner.search_people(query, limit)
        return [str(p.get("name")) for p in res.get("people") or [] if p.get("name")][:limit]

    # Actions de Trame → fonctions du contrôle de la page (teams_check.FEATURES) qu'elles
    # remplacent entièrement. L'envoi n'y est pas : brouillon, réponse citée, mentions et pièces
    # jointes passent toujours par la zone de saisie de la page.
    CHECK_FEATURES = {"read": "read", "react": "react", "delete": "delete", "mark_read": "mark_read",
                      "my_status": "own_status", "set_note": "status_note"}

    def api_features(self) -> set[str]:
        """Fonctions faites aujourd'hui par le service de chat (voie « api » au dernier essai) :
        leurs repères de page ne servent plus qu'en repli. Un repli sur la page les en retire."""
        routes = self.routes()
        return {f for a, f in self.CHECK_FEATURES.items() if routes.get(a, {}).get("via") == "api"}

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
