"""« API Teams web » devant le pilote de la page (DOM).

Remplace le GraphDriver : au lieu d'appeler Microsoft Graph, Trame s'appuie sur la session
Teams web déjà authentifiée de l'utilisateur. Les appels API se font DANS la page, signés avec
l'auth que le client Teams pose lui-même (le jeton ne quitte jamais la page, voir
`drivers/web_bridge.py` et `docs/teams-web-api.md`).

Teams v2 lit et écrit les messages par l'API REST de son service de chat (chatsvc), depuis un
Web Worker. La page ouvre sa propre session sur ce service (`chatsvc` dans teams-bridge.js) et
appelle aussi le service de présence et le middletier avec le jeton que Teams y pose. Chaque
action câblée essaie d'abord l'API, prouve son effet en relisant, et retombe sur la page (DOM)
quand rien n'est parti ; `routes()` dit, action par action, la voie suivie (« api » / « page »)
et si elle a servi depuis le démarrage. Restent sur la page : les réunions et les
transcriptions. La santé de la signature et de la session chatsvc (auto-tests du pont) est
exposée pour l'écran Réglages.

Enveloppe transparente : tout ce qui n'est pas défini ici est délégué au pilote de la page.
"""
from __future__ import annotations
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional

import presence as presencemod
from drivers import rail_label
from drivers.base import DeleteUncertain, EditUncertain, Focus, ReactUncertain, SendUncertain, TeamsDriver
from models import IncomingMessage, MessageRef, Surface, WatchEntity

# Attributs propres au wrapper (les autres sont lus/écrits sur le pilote de la page).
_OWN = {"_inner", "_routes", "_routes_lock", "_chat", "_health_cache"}


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


def _list_label(ts: Any, now: Optional[datetime] = None) -> Optional[str]:
    """L'heure d'un dernier message comme la liste de Teams l'écrit, recalculée à chaque tour :
    « 14:32 » aujourd'hui, « Hier », sinon « 25/11 » (« 25/11/25 » une autre année)."""
    try:
        when = datetime.fromtimestamp(int(ts) / 1000)
    except (TypeError, ValueError, OSError):
        return None
    if int(ts) <= 0:
        return None
    now = now or datetime.now()
    if when.date() == now.date():
        return f"{when:%H:%M}"
    if when.date() == (now - timedelta(days=1)).date():
        return "Hier"
    return f"{when:%d/%m}" if when.year == now.year else f"{when:%d/%m/%y}"


def _note_never() -> str:
    try:
        return datetime(9999, 12, 31).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (OverflowError, ValueError, OSError):
        return "9999-12-31T00:00:00Z"


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
        # Tête-à-tête ouverts par Trame sur le service (« Nouvelle conversation ») : thread_id de
        # Trame -> id Teams. Gardés à chaque relecture de la liste, même absents de la page ; l'id
        # Teams contient l'identifiant de la personne choisie : la preuve est forte.
        self.started: dict[str, str] = {}
        # Conversations ajoutées à la liste depuis le service (la page ne les dessinait pas) : thread_id
        # -> id Teams. Reliées seulement tant que la page ne les montre pas elle-même.
        self.extra: dict[str, str] = {}
        # Dernier message signalé par l'aperçu de la page, par conversation : (texte replié, heure).
        # Le service ne le signale pas une seconde fois quand il relie la conversation ensuite.
        self.previewed: dict[str, tuple[str, float]] = {}
        # Conversations reliées au tour précédent dont la preuve vient d'échouer une fois : gardées un
        # tour (la page voit souvent un message une seconde avant le service).
        self.grace: set[str] = set()

# Actions suivies, dans l'ordre d'affichage. Libellés côté UI (ApiTeamsWebSettings).
ACTIONS = ("list", "read", "watch", "unread", "presence", "my_status", "search_people",
           "search_messages", "mark_read", "react", "delete", "edit", "set_status", "set_note",
           "send", "start_chat", "hide", "meetings", "transcript")


class WebApiDriver:
    # Actions déjà câblées sur le service de chat (les autres restent sur la page).
    API_ACTIONS = frozenset({"read", "watch", "unread", "mark_read", "react", "delete", "edit", "send",
                             "presence", "my_status", "set_status", "set_note", "search_people", "start_chat",
                             "search_messages", "hide", "meetings"})
    # Présence des tête-à-tête : relue sur le service au plus toutes les PRESENCE_EVERY secondes.
    PRESENCE_EVERY = 60.0
    # Note de statut sans échéance : « jamais ». Teams écrit minuit le 31/12/9999 en heure locale
    # (« 9999-12-30T23:00:00Z » à Paris) ; si la conversion de fuseau déborde, minuit UTC.
    NOTE_NEVER = _note_never()
    # Écart toléré entre l'horloge du poste et celle de Teams pour dater un message « nouveau ».
    CLOCK_SKEW = 120
    # Messages relus au plus quand plusieurs sont arrivés dans une conversation entre deux tours.
    CATCH_UP = 20
    PAGE_REASON = "via la page Teams (pas encore câblé sur l'API Teams web)"

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

    def chat_ready(self) -> bool:
        """La dernière lecture de la liste par le service de chat a réussi."""
        return bool(self._chat.ok)

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
                out[a] = {**seen[a], "tried": True}
            elif a in self.API_ACTIONS:
                # Câblée sur l'API, mais pas encore essayée depuis le démarrage : rien de prouvé.
                out[a] = {"via": "api", "reason": "câblé sur l'API Teams web, pas encore essayé", "at": at, "tried": False}
            else:
                out[a] = {"via": "page", "reason": self.PAGE_REASON, "at": at, "tried": False}
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
        for cid, r in list(self._chat.rows.items()):
            name = str(r.get("name") or "").casefold()
            if r.get("kind") == "dm" and name:
                dm_names[name] = None if name in dm_names else cid
        mapped = {}
        st = self._chat
        before = dict(st.mapped)
        st.refused = 0
        st.strong = set()
        shown = {e.thread_id for e in entities}
        for e in entities:
            cid = self._chat_for(e, dm_names, previews.get(e.thread_id))
            if cid:
                mapped[e.thread_id] = cid
            elif e.thread_id in before and e.thread_id not in st.grace and before[e.thread_id] in st.rows:
                # Une seule preuve manquée : gardé un tour pour la détection des messages (pas de
                # second signalement par l'aperçu), jamais pour lire par alias ni pour écrire.
                mapped[e.thread_id] = before[e.thread_id]
                st.grace.add(e.thread_id)
                continue
            st.grace.discard(e.thread_id)
        for tid, cid in list(st.started.items()):
            if tid not in mapped and cid not in mapped.values():
                mapped[tid] = cid
                st.strong.add(tid)
        for tid, cid in list(st.extra.items()):
            # Ajoutée depuis le service : seulement tant que la page ne montre pas ce thread_id.
            if tid not in shown and tid not in mapped and cid not in mapped.values():
                mapped[tid] = cid
                st.strong.add(tid)
        st.mapped = mapped
        # Remplacé d'un bloc : une lecture de fil en parallèle voit l'ancienne table ou la nouvelle.
        if isinstance(getattr(self._inner, "chat_aliases", None), dict):
            # Une conversation en grâce (preuve manquée une fois) n'est jamais lue par son alias.
            self._inner.chat_aliases = {t: c for t, c in mapped.items()
                                        if (t.startswith("name:") or c == "48:notes") and t not in st.grace}
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

    # --- Liste : la page, complétée par le service ---------------------------------------
    # La page ne dessine que les lignes qu'elle a chargées. Le service connaît toute la liste :
    # Trame y ajoute les groupes nommés et les tête-à-tête actifs depuis RECENT_DAYS jours que la
    # page n'a pas montrés, sous les ids que la page leur donnerait (« title-19:… » pour un
    # groupe, « name:… » pour un tête-à-tête) : rien à migrer quand la page les montre ensuite.
    RECENT_DAYS = 30
    MAX_EXTRA = 150

    def _service_entities(self, known: Iterable[WatchEntity], start_rank: int) -> list[WatchEntity]:
        st = self._chat
        if not st.ok:
            return []
        seen_ids = {e.thread_id for e in known}
        # Conversations déjà montrées par la page (celles ajoutées au tour précédent ne comptent pas).
        seen_cids = {c for t, c in st.mapped.items() if t in seen_ids}
        seen_names = {e.display_name.casefold() for e in known if e.surface == Surface.dm}
        dm_count: dict[str, int] = {}
        for r in list(st.rows.values()):
            if r.get("kind") == "dm" and r.get("name"):
                k = str(r["name"]).casefold()
                dm_count[k] = dm_count.get(k, 0) + 1
        horizon = (time.time() - self.RECENT_DAYS * 86400) * 1000
        rows = sorted((r for r in list(st.rows.values()) if (r.get("last") or {}).get("ts", 0) >= horizon),
                      key=lambda r: -(r.get("last") or {}).get("ts", 0))
        out: list[WatchEntity] = []
        kinds = getattr(self._inner, "_kinds", None)
        names = getattr(self._inner, "_names", None)
        for r in rows:
            cid = str(r.get("id") or "")
            if not cid or cid in seen_cids or r.get("hidden") or r.get("empty"):
                continue
            if r.get("kind") == "group" and str(r.get("topic") or "").strip():
                tid, name, surface = f"title-{cid}", str(r["topic"]).strip(), Surface.group
            elif r.get("kind") == "dm" and r.get("name") and dm_count.get(str(r["name"]).casefold()) == 1:
                name = str(r["name"]).strip()
                if name.casefold() in seen_names:
                    continue
                tid, surface = f"name:{name}", Surface.dm
            else:
                continue
            if tid in seen_ids:
                continue
            # Relié par construction (id Teams lu sur le service), tant que la page ne le montre pas.
            st.extra[tid] = cid
            if isinstance(names, dict):
                names.setdefault(tid, name)
            if isinstance(kinds, dict):
                kinds.setdefault(tid, surface)
            last = r.get("last") or {}
            out.append(WatchEntity(thread_id=tid, display_name=name, surface=surface, rank=start_rank + len(out),
                                   last_activity=_list_label(last.get("ts")), unread=self._unread(r)))
            if len(out) >= self.MAX_EXTRA:
                break
        return out

    def list_all_conversations(self) -> list[WatchEntity]:
        """La lecture complète de la page (défilement de la liste), complétée par le service :
        sans cela, une lecture complète retirait les conversations ajoutées depuis le service."""
        page = self._inner.list_all_conversations()
        if not self._chat.ok:
            self._refresh_chat()
        return page + self._service_entities(page, len(page))

    def list_conversations(self, deep: bool = False) -> list[WatchEntity]:
        page = self._inner.list_conversations(deep)
        if not self._chat.ok:
            self._refresh_chat()
        extra = self._service_entities(page, len(page))
        if extra:
            self._route("list", "api", f"{len(extra)} conversation(s) ajoutée(s) depuis le service de chat")
        return page + extra

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
            extra = self._service_entities(entities, len(entities))
            if extra:
                self._map(entities, previews)  # les conversations ajoutées rejoignent la correspondance
                mapped = self._chat.mapped
                entities = entities + extra
                self._route("list", "api", f"{len(extra)} conversation(s) ajoutée(s) depuis le service de chat")
            # Après les ajouts : leurs tête-à-tête ont aussi leur présence.
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
                st.previewed[msg.thread_id] = (_norm(msg.text), time.time())
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
            # Déjà signalé par l'aperçu de la page (service indisponible ou relié un tour plus tard) :
            # le même message, son début tronqué. Jamais deux fois.
            seen = st.previewed.pop(tid, None)
            if seen and now - seen[1] < 600 and seen[0] and _norm(text).startswith(seen[0][:40]):
                continue
            e = convs.get(tid)
            surface = e.surface if e else Surface.dm
            # Plusieurs messages depuis le tour précédent : le service ne donne que le dernier. Les
            # autres sont relus (sans ouvrir la conversation) et signalés dans l'ordre, avant lui.
            for earlier in self._between(tid, prev, lid):
                on_message(earlier.model_copy(update={"surface": surface}))
            on_message(IncomingMessage(thread_id=tid, sender=str(last.get("sender") or ""), text=text,
                                       received_at=str(last.get("at") or ""), id=lid,
                                       surface=surface))
        if st.primed_at is None:
            st.primed_at = now
        self._route("watch", "api")

    def _between(self, tid: str, prev: Optional[str], lid: str) -> list[IncomingMessage]:
        """Les messages reçus strictement entre `prev` (dernier vu) et `lid` (nouveau dernier), lus
        sur le service de chat. Jamais les tiens, jamais au-delà de CATCH_UP ; rien si le service
        ne répond pas (le dernier reste signalé)."""
        if not prev:
            return []
        try:
            low, high = int(prev), int(lid)
        except ValueError:
            return []
        if high <= low:
            return []
        try:
            got = self.read_history_direct(tid, self.CATCH_UP, since=datetime.fromtimestamp(low / 1000))
        except Exception:
            return []
        if not got:
            return []
        out = []
        for m in got[0]:
            try:
                mid = int(m.id or 0)
            except ValueError:
                continue
            if low < mid < high and m.from_me is not True and (m.text or m.files or m.images):
                out.append(m)
        return sorted(out, key=lambda m: int(m.id or 0))

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

    # --- Masquer dans Teams (archivage de Trame) -----------------------------------------
    @property
    def can_hide_chat(self) -> bool:
        return callable(getattr(self._inner, "chat_gesture", None))

    def hide_chat(self, thread_id: str, hide: bool) -> bool:
        """Masque (ou réaffiche) la conversation dans la liste de Teams, par le service de chat,
        puis relit. Pas de repli sur la page : son menu « Masquer » n'est pas piloté."""
        res = self._gesture("hide", "hide", thread_id, hidden=bool(hide))
        if res is None:
            raise RuntimeError("conversation sans identifiant Teams prouvé")
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "non confirmé par Teams")
        return True

    def mark_read(self, thread_id: str) -> bool:
        res = self._gesture("mark_read", "markread", thread_id)
        if res is None:
            return self._inner.mark_read(thread_id)
        if not res.get("ok"):
            self._inner.last_error = res.get("error") or "marquer comme lu non confirmé"
        return bool(res.get("ok"))

    def react_focused(self, thread_id: str, target: MessageRef, reaction: str, restore: bool = True,
                      remove: bool = False) -> Focus:
        res = self._gesture("react", "react", thread_id, message=self._inner._ref(target), reaction=reaction,
                            remove=remove)
        if res is None:
            return self._inner.react_focused(thread_id, target, reaction, restore=restore, remove=remove)
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

    def edit_focused(self, thread_id: str, target: MessageRef, text: str, restore: bool = True) -> Focus:
        res = self._gesture("edit", "edit", thread_id, message=self._inner._ref(target), text=text)
        if res is None:
            return self._inner.edit_focused(thread_id, target, text, restore=restore)
        if res.get("uncertain"):
            raise EditUncertain(res.get("error") or "modification non confirmée")
        return Focus(ok=bool(res.get("ok")), reason=None if res.get("ok") else res.get("error"))

    def type_focused(self, thread_id: str, text: str, send: bool, restore: bool,
                     reply_to: Optional[MessageRef] = None, mentions: Any = (), files: Any = ()) -> Focus:
        """Un envoi de texte, en réponse citée ou non, avec ou sans mentions, part par le service
        de chat ; une saisie sans envoi ou une pièce jointe passent par la page. Une réponse à
        un message sans id Teams, ou une mention que le service ne sait pas relier à une
        personne de la conversation, passent aussi par la page."""
        replyable = reply_to is None or bool(reply_to.id)
        if send and replyable and not files and text.strip():
            extra: dict[str, Any] = {}
            if reply_to is not None:
                extra["reply"] = self._inner._ref(reply_to)
            if mentions:
                extra["mentions"] = [str(m) for m in mentions]
            res = self._gesture("send", "send", thread_id, text=text, **extra)
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

    # --- Recherche de messages : les fils récents sur le service --------------------------
    # Première étape de « Chercher aussi dans Teams » : les derniers messages des conversations
    # récentes, sur le service de chat, sans rien ouvrir dans la page. La recherche de Teams
    # (tout l'historique, par la page) reste une seconde étape, à la demande : search_messages.
    @property
    def can_search_recent(self) -> bool:
        return callable(getattr(self._inner, "search_messages_api", None))

    def search_recent(self, query: str, limit: int = 25) -> list[dict]:
        """Résultats du service, chacun avec le thread_id de Trame de sa conversation quand il
        est connu (même id que la page : « title-19:… », « name:… »). Lève si le service refuse."""
        try:
            found = self._inner.search_messages_api(query, limit)
        except Exception as e:
            self._route("search_messages", "page", f"service indisponible : {e}")
            raise
        self._route("search_messages", "api")
        st = self._chat
        by_cid = {c: t for t, c in st.mapped.items()}
        for r in found:
            cid = r.pop("teams_id", None)
            tid = by_cid.get(cid) if cid else None
            if tid is None and cid:
                row = st.rows.get(cid) or {}
                if cid == "48:notes":
                    tid = next((t for t, c in st.mapped.items() if c == "48:notes"), None)
                elif row.get("kind") == "dm" or cid.endswith("@unq.gbl.spaces"):
                    tid = f"name:{r['conversation']}" if r.get("conversation") else None
                else:
                    tid = f"title-{cid}"
            r["thread_id"] = tid
        return found

    # --- Réunions terminées : lues sur le service, sans ouvrir les conversations ------------
    MAX_MEETING_CHATS = 12

    def list_meetings(self, limit: Optional[int] = None) -> list[dict]:
        """Les réunions terminées des conversations de réunion les plus récentes, lues sur le
        service de chat (rien n'est ouvert dans la page) : mêmes champs et même `mid` que la
        lecture des cartes de la page, donc la transcription se relit comme avant. Service
        indisponible : la page, comme avant."""
        api = getattr(self._inner, "meetings_api", None)
        st = self._chat
        if callable(api):
            if not st.ok:
                self._refresh_chat()
            rows = sorted((r for r in list(st.rows.values()) if r.get("kind") == "meeting"),
                          key=lambda r: -((r.get("last") or {}).get("ts") or 0))[: limit or self.MAX_MEETING_CHATS]
            if rows:
                try:
                    # Le sujet sert à retrouver l'occurrence dans l'agenda (créneau d'une occurrence déplacée).
                    chats = api([str(r["id"]) for r in rows], {str(r["id"]): str(r.get("topic") or "") for r in rows})
                except Exception as e:
                    self._route("meetings", "page", f"repli sur la page : {e}")
                else:
                    topic = {str(r["id"]): str(r.get("topic") or "").strip() for r in rows}
                    out = []
                    for c in chats:
                        tid, name = f"title-{c['thread']}", topic.get(c["thread"]) or "Réunion"
                        for r in c["recaps"]:
                            out.append({"thread_id": tid, "chat": name, "mid": r["mid"], "title": name,
                                        "when": r["when"], "transcript": r["transcript"]})
                    self._route("meetings", "api")
                    return out
        return self._inner.list_meetings(limit)

    # --- Nouvelle conversation : un tête-à-tête qui existe sur le service --------------
    def start_chat(self, name: str) -> Optional[WatchEntity]:
        """Le tête-à-tête avec `name`, sans ouvrir la page : la personne par la recherche de
        Teams (un seul nom identique), puis SA conversation sur le service de chat (l'id du
        tête-à-tête contient son identifiant), créée comme Teams le fait si elle n'existe pas
        encore. Rien n'est tapé. Personne introuvable, homonymes, service indisponible : la
        page, comme avant."""
        shown = " ".join((name or "").split())
        hit = self._existing_dm(shown) if shown else None
        if hit is None:
            return self._inner.start_chat(name)
        person, cid = hit
        st = self._chat
        thread_id = next((t for t, c in st.mapped.items() if c == cid), None) or f"name:{person}"
        st.started[thread_id] = cid
        st.mapped = {**st.mapped, thread_id: cid}
        st.strong.add(thread_id)
        if isinstance(getattr(self._inner, "chat_aliases", None), dict) and thread_id.startswith("name:"):
            self._inner.chat_aliases = {**self._inner.chat_aliases, thread_id: cid}
        for attr, value in (("_names", person), ("_kinds", Surface.dm)):
            table = getattr(self._inner, attr, None)
            if isinstance(table, dict):
                table[thread_id] = value
        self._route("start_chat", "api")
        return WatchEntity(thread_id=thread_id, display_name=person, surface=Surface.dm)

    def _existing_dm(self, name: str) -> Optional[tuple[str, str]]:
        res = self._people("start_chat", "search", query=name, limit=8)
        if res is None or not res.get("ok"):
            return None
        same = {str(p.get("mri")): str(p.get("name")) for p in res.get("people") or []
                if p.get("mri") and rail_label.same_name(str(p.get("name") or ""), name)}
        if len(same) != 1:
            why = "homonymes dans Teams" if same else "personne introuvable par la recherche de Teams"
            self._route("start_chat", "page", f"repli sur la page : {why}")
            return None
        mri, person = next(iter(same.items()))
        st = self._chat
        if not st.ok:
            self._refresh_chat()
        cid = next((c for c, r in st.rows.items() if r.get("kind") == "dm" and r.get("other") == mri), None)
        if cid is not None:
            return person, cid
        # Absent de la liste lue : trouvé par son id, ou créé (sans message), puis relu.
        dm = getattr(self._inner, "chat_dm", None)
        res = dm(mri) if callable(dm) else None
        if not res or not res.get("ok"):
            why = (res or {}).get("error") or "tête-à-tête introuvable sur le service"
            self._route("start_chat", "page", f"repli sur la page : {why}")
            return None
        cid = str(res["id"])
        st.rows.setdefault(cid, {"id": cid, "kind": "dm", "other": mri, "name": person})
        return person, cid

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
            # Échéance de la note (ISO UTC) ; « 9999-… » : jamais.
            out["message_expiry"] = str((res.get("note") or {}).get("expiry") or "") or None
        return out

    # Choix de Trame -> disponibilité du service de présence (comme le menu de Teams).
    AVAILABILITY = {"available": "Available", "busy": "Busy", "dnd": "DoNotDisturb", "brb": "BeRightBack",
                    "away": "Away", "offline": "Offline"}

    @staticmethod
    def status_expiry(duration: Optional[str], until: Optional[datetime], now: Optional[datetime] = None) -> str:
        """Échéance du statut, en ISO UTC (« … Z ») ; "" : jusqu'à ce qu'on le change. Les durées
        sont comptées en heure locale : « aujourd'hui » finit ce soir à 23:59:59, « cette semaine »
        dimanche soir. Une heure de fin (« Personnalisé ») est une heure locale."""
        now = now or datetime.now().astimezone()
        if until is not None:
            end = until if until.tzinfo else until.astimezone()
        elif duration is None:
            return ""
        elif duration in ("30m", "1h", "2h"):
            end = now + {"30m": timedelta(minutes=30), "1h": timedelta(hours=1), "2h": timedelta(hours=2)}[duration]
        elif duration == "today":
            end = now.replace(hour=23, minute=59, second=59, microsecond=0)
        elif duration == "week":
            end = (now + timedelta(days=6 - now.weekday())).replace(hour=23, minute=59, second=59, microsecond=0)
        else:
            raise ValueError(f"durée impossible : {duration}")
        return end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def set_my_status(self, choice: str, duration: Optional[str] = None,
                      until: Optional[datetime] = None) -> Optional[str]:
        """Statut choisi sur le service de présence, puis relu : le service doit garder CE choix
        (et son échéance). Rien n'est parti : le menu de la page, comme avant. Parti sans preuve :
        jamais refait par la page (le moteur dit de vérifier dans Teams)."""
        if choice not in presencemod.CHOICES:
            raise ValueError(f"statut inconnu : {choice}")
        if choice == "reset":
            if duration is not None or until is not None:
                raise ValueError("durée impossible pour « Réinitialiser »")
            res = self._people("set_status", "reset")
        else:
            res = self._people("set_status", "force", availability=self.AVAILABILITY[choice],
                               expiry=self.status_expiry(duration, until))
        if res is not None and not res.get("ok") and not res.get("uncertain"):
            # Refus net du service (rien n'a changé) : le menu de la page, comme avant.
            self._route("set_status", "page", f"repli sur la page : {res.get('error') or 'refusé'}")
            res = None
        if res is None:
            return self._inner.set_my_status(choice, duration, until)
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "statut non confirmé : vérifie dans Teams")
        if choice == "reset":
            return presencemod.from_service(res.get("availability"), res.get("activity"), bool(res.get("ooo")))
        # Prouvé : le service garde ce choix. L'activité du moment (une réunion) peut s'afficher
        # par-dessus dans Teams, mais le statut choisi est bien celui-ci.
        return choice

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
    # remplacent entièrement. L'envoi n'y est pas : brouillon et pièces jointes passent toujours
    # par la zone de saisie de la page.
    CHECK_FEATURES: dict[str, tuple[str, ...]] = {
        "read": ("read",), "react": ("react",), "delete": ("delete",), "mark_read": ("mark_read",),
        "my_status": ("own_status",), "set_note": ("status_note",),
        "set_status": ("set_status", "status_duration", "status_until")}

    def api_features(self) -> set[str]:
        """Fonctions faites aujourd'hui par le service de chat (voie « api » au dernier essai) :
        leurs repères de page ne servent plus qu'en repli. Un repli sur la page les en retire."""
        routes = self.routes()
        return {f for a, fs in self.CHECK_FEATURES.items() if routes.get(a, {}).get("via") == "api" for f in fs}

    # La carte « API Teams web » se relit toutes les 10 s : un seul diagnostic de la page pour la
    # signature et la session du service de chat (au lieu de deux), gardé HEALTH_TTL secondes.
    HEALTH_TTL = 8.0

    def health(self) -> dict:
        now = time.monotonic()
        cached = getattr(self, "_health_cache", None)
        if cached and now - cached[0] < self.HEALTH_TTL:
            return cached[1]
        try:
            page = self._inner.diagnose().get("diagnose")
        except Exception:
            page = None
        page = page if isinstance(page, dict) else {}
        sign, chat = page.get("sign_selftest"), page.get("chatsvc_selftest")
        out = {"signing": sign if isinstance(sign, dict) else None, "chatsvc": chat if isinstance(chat, dict) else None}
        object.__setattr__(self, "_health_cache", (now, out))
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
        return {**out, "teams_web": {"routes": self.routes(), "chat_map": self.chat_map(),
                                     "signing": signing if isinstance(signing, dict) else None,
                                     "chatsvc": chat if isinstance(chat, dict) else None}}
