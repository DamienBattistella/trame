"""WebApiDriver : liste de la page complétée par le service de chat (ids des tête-à-tête,
non-lus, nouveaux messages), avec repli exact sur la page quand le service refuse."""
from __future__ import annotations

from drivers import rail_label
from drivers.preview_watch import PreviewWatcher
from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver
from models import Surface, WatchEntity

ME = "8:orgid:me"
GROUP = "19:grp@thread.v2"
DM = "19:aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002@unq.gbl.spaces"


def row(cid, kind, name, last_id=None, sender="Ana Martin", frm="8:orgid:ana", text="Salut", horizon=0, user=True):
    last = None if last_id is None else {"id": str(last_id), "ts": last_id, "from": frm, "sender": sender,
                                         "user": user, "text": text, "files": 0, "images": 0, "at": "10:00"}
    return {"id": cid, "kind": kind, "name": name, "topic": name if kind != "dm" else "", "horizon": horizon, "last": last}


class FakePage:
    """Le pilote de la page : liste fixe, aperçus suivis comme le vrai, service de chat pilotable."""

    POLL_SECONDS = 0

    def __init__(self, rows=None):
        self.chat_aliases: dict[str, str] = {}
        self._previews = PreviewWatcher()
        self._kinds = {"title-" + GROUP: Surface.group, "name:Ana Martin": Surface.dm}
        self.labels = {"title-" + GROUP: "Chat Projet X Last message Paul: bonjour 09:00", "name:Ana Martin": "Chat Ana Martin Away Last message Salut 10:00"}
        self.rows = rows or []
        self.fail = None
        self.syncs: list[str] = []
        self.on_conversations = None

    chat_id = staticmethod(WebBridgeDriver.chat_id)

    def _items(self, deep=False):
        return [{"thread_id": t, "label": lab, "parsed": rail_label.parse(lab)} for t, lab in self.labels.items()]

    def _entities(self, items):
        out = []
        for rank, it in enumerate(items):
            t = it["thread_id"]
            out.append(WatchEntity(thread_id=t, display_name="Projet X" if t.startswith("title-") else "Ana Martin",
                                   surface=self._kinds[t], rank=rank, unread=False))
        return out

    def chat_list(self, sync=""):
        self.syncs.append(sync)
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        return {"rows": list(self.rows), "sync": "S1", "full": not sync, "me": ME}

    def list_unread(self, thread_ids=None):
        return []


def tick(d):
    got = []
    d.watch_tick(got.append)
    return got


def test_conversations_are_linked_to_their_teams_id_without_changing_trame_ids():
    page = FakePage([row(GROUP, "group", "Projet X", 1), row(DM, "dm", "Ana Martin", 2)])
    d = WebApiDriver(page)
    seen = []
    page.on_conversations = seen.append
    tick(d)
    # Les ids de Trame restent ceux de la page ; le tête-à-tête est relié par son nom.
    assert d.chat_map()["mapped"] == 2 and d.chat_map()["mapped_by_name"] == 1
    assert page.chat_aliases == {"name:Ana Martin": DM}
    assert {e.thread_id for e in seen[0]} == {"title-" + GROUP, "name:Ana Martin"}


def test_two_one_to_one_chats_with_the_same_name_are_never_guessed():
    other = DM.replace("0001_", "0009_")
    page = FakePage([row(DM, "dm", "Ana Martin", 2), row(other, "dm", "Ana Martin", 3)])
    d = WebApiDriver(page)
    tick(d)
    assert page.chat_aliases == {} and d.chat_map()["mapped_by_name"] == 0


def test_unread_comes_from_the_read_horizon_and_ignores_my_own_messages():
    page = FakePage([row(GROUP, "group", "Projet X", 2000, horizon=1000),
                     row(DM, "dm", "Ana Martin", 3000, frm=ME, sender="Moi", horizon=1000)])
    d = WebApiDriver(page)
    seen = []
    page.on_conversations = seen.append
    tick(d)
    unread = {e.thread_id: e.unread for e in seen[0]}
    assert unread == {"title-" + GROUP: True, "name:Ana Martin": False}
    assert d.routes()["unread"]["via"] == "api"


def test_new_message_reported_once_with_full_text_id_and_sender_no_flood_at_start():
    page = FakePage([row(GROUP, "group", "Projet X", 1000, text="ancien")])
    d = WebApiDriver(page)
    assert tick(d) == []  # premier passage : on note, on ne rejoue rien
    page.rows = [row(GROUP, "group", "Projet X", 9_999_999_999_999, sender="Paul Durand", frm="8:orgid:paul",
                     text="Le point est décalé à 15 h, ça te va ?")]
    got = tick(d)
    assert [(m.thread_id, m.sender, m.text, m.id) for m in got] == [
        ("title-" + GROUP, "Paul Durand", "Le point est décalé à 15 h, ça te va ?", "9999999999999")]
    assert tick(d) == []  # pas deux fois
    assert page.syncs[1:] == ["S1", "S1"]  # lectures suivantes incrémentales


def test_my_own_messages_and_thread_events_are_not_new_messages():
    page = FakePage([row(GROUP, "group", "Projet X", 1000)])
    d = WebApiDriver(page)
    tick(d)
    page.rows = [row(GROUP, "group", "Projet X", 9_999_999_999_998, frm=ME)]
    assert tick(d) == []
    page.rows = [row(GROUP, "group", "Projet X", 9_999_999_999_999, user=False)]
    assert tick(d) == []


def test_page_previews_are_not_doubled_for_linked_conversations():
    page = FakePage([row(GROUP, "group", "Projet X", 1000), row(DM, "dm", "Ana Martin", 1000)])
    d = WebApiDriver(page)
    tick(d)
    page.labels["name:Ana Martin"] = "Chat Ana Martin Away Last message Nouveau 10:05"  # la page voit un nouvel aperçu…
    page.rows = [row(GROUP, "group", "Projet X", 1000), row(DM, "dm", "Ana Martin", 9_999_999_999_999, text="Nouveau")]
    got = tick(d)
    assert [m.text for m in got] == ["Nouveau"] and got[0].id == "9999999999999"  # …un seul message, celui du service


def test_refusal_falls_back_to_the_page_exactly_and_restarts_with_a_full_list():
    page = FakePage([row(GROUP, "group", "Projet X", 1000)])
    d = WebApiDriver(page)
    tick(d)
    page.fail = "service de chat refusé (HTTP 401)"
    page.labels["name:Ana Martin"] = "Chat Ana Martin Away Last message Tu es là ? 10:06"
    got = tick(d)
    assert [(m.thread_id, m.text) for m in got] == [("name:Ana Martin", "Tu es là ?")]  # l'aperçu de la page
    assert d.routes()["watch"]["via"] == "page" and "HTTP 401" in d.routes()["watch"]["reason"]
    page.fail = None
    tick(d)
    assert page.syncs[-1] == ""  # reprise par une liste complète


def test_last_message_going_back_to_an_older_one_is_not_a_new_message():
    # Le dernier message supprimé : la conversation redonne le précédent (plus ancien).
    page = FakePage([row(GROUP, "group", "Projet X", 9_999_999_999_000)])
    d = WebApiDriver(page)
    tick(d)
    page.rows = [row(GROUP, "group", "Projet X", 9_999_999_998_000, text="message d'avant")]
    assert tick(d) == []


def test_old_messages_are_never_replayed_when_a_conversation_is_linked_later():
    # Constaté en direct : des messages du 10/11 et du 16/11 annoncés au démarrage.
    page = FakePage([row(GROUP, "group", "Projet X", 1000)])
    d = WebApiDriver(page)
    tick(d)
    page.rows = [row(GROUP, "group", "Projet X", 1000), row(DM, "dm", "Ana Martin", 1_731_200_000_000, text="vieux")]
    assert tick(d) == []
    # Et même si un ancien message remplace un autre ancien message, rien n'est annoncé.
    page.rows = [row(GROUP, "group", "Projet X", 1_731_300_000_000), row(DM, "dm", "Ana Martin", 1_731_200_000_000)]
    assert tick(d) == []


def test_one_to_one_linked_by_name_only_when_its_last_message_is_the_one_the_page_shows():
    # Constaté en direct : « Céline M. » relié par son nom à une AUTRE conversation de la même
    # personne (dernier message de mardi, alors que la page affichait celui de 13:44).
    page = FakePage([row(GROUP, "group", "Projet X", 1000), row(DM, "dm", "Ana Martin", 1000, text="Message de mardi")])
    page.labels["name:Ana Martin"] = "Chat Ana Martin Away Last message Tu as deux minutes ? 13:44"
    d = WebApiDriver(page)
    tick(d)
    assert "name:Ana Martin" not in d._chat.mapped and page.chat_aliases == {}
    # Le fil de ce tête-à-tête est donc lu par la page, et son nouveau message vient de l'aperçu.
    page.labels["name:Ana Martin"] = "Chat Ana Martin Away Last message Tu es là ? 13:46"
    assert [(m.thread_id, m.text) for m in tick(d)] == [("name:Ana Martin", "Tu es là ?")]
    # Quand l'aperçu (tronqué par la page) et le dernier message concordent, il est relié.
    page.rows = [row(GROUP, "group", "Projet X", 1000), row(DM, "dm", "Ana Martin", 1001, text="Tu es là ? Je t'appelle")]
    page.labels["name:Ana Martin"] = "Chat Ana Martin Away Last message Tu es là ? Je t'app… 13:46"
    tick(d)
    assert page.chat_aliases == {"name:Ana Martin": DM}


def test_image_or_file_alone_is_named_as_such():
    page = FakePage([row(GROUP, "group", "Projet X", 1000)])
    d = WebApiDriver(page)
    tick(d)
    r = row(GROUP, "group", "Projet X", 9_999_999_999_999, text="")
    r["last"]["images"] = 1
    page.rows = [r]
    assert [m.text for m in tick(d)] == ["(image)"]


def test_one_to_one_also_linked_when_the_page_shows_the_same_time_of_last_message():
    # Aperçu non comparable (« a envoyé une image », emoji…) : la même heure à la minute suffit.
    page = FakePage([row(GROUP, "group", "Projet X", 1000), row(DM, "dm", "Ana Martin", 1000, text="")])
    page.rows[1]["last"]["at"] = "13:44"
    page.labels["name:Ana Martin"] = "Chat Ana Martin Away Last message A envoyé une image 13:44"
    d = WebApiDriver(page)
    tick(d)
    assert page.chat_aliases == {"name:Ana Martin": DM}
    # Autre heure (le cas réel : mardi 11:02 contre 13:44) : jamais relié.
    page.rows[1]["last"]["at"] = "mardi 11:02"
    tick(d)
    assert page.chat_aliases == {}
    # Une date affichée par la page : même jour côté service de chat.
    page.rows[1]["last"]["at"] = "25/11 16:05"
    page.labels["name:Ana Martin"] = "Chat Ana Martin Away Last message A envoyé une image 25/11"
    tick(d)
    assert page.chat_aliases == {"name:Ana Martin": DM}
