"""WebApiDriver : la liste de la page complétée par le service de chat (groupes nommés et
tête-à-tête récents que la page n'a pas dessinés), sous les ids que la page leur donnerait."""
from __future__ import annotations

import time

from drivers.web_api import WebApiDriver
from models import Surface, WatchEntity

NOW = int(time.time() * 1000)
OLD = NOW - 90 * 86400 * 1000
GRP = "19:grp@thread.v2"
DM = "19:aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002@unq.gbl.spaces"


def row(cid, kind, ts, **extra):
    return {"id": cid, "kind": kind, "last": {"id": str(ts), "ts": ts, "at": "10:00", "user": True, "from": "8:orgid:x"},
            "horizon": 0, **extra}


class FakePage:
    def __init__(self, page, rows):
        self.page = page
        self.rows = rows
        self._names: dict = {}
        self._kinds: dict = {}
        self.chat_aliases: dict = {}

    def list_conversations(self, deep=False):
        return list(self.page)

    def chat_list(self, sync=""):
        return {"full": True, "rows": self.rows, "sync": "S", "me": "8:orgid:me"}


SHOWN = WatchEntity(thread_id="name:Ana Martin", display_name="Ana Martin", surface=Surface.dm)


def test_recent_conversations_the_page_did_not_draw_are_added_with_page_ids():
    rows = [row(GRP, "group", NOW - 1000, topic="Projet FHIR"),
            row(DM, "dm", NOW - 2000, name="Marc Petit"),
            row("19:old@thread.v2", "group", OLD, topic="Vieux projet"),
            row("19:notopic@thread.v2", "group", NOW, topic=""),
            row("19:hidden@thread.v2", "group", NOW, topic="Caché", hidden=True),
            row("48:notes", "self", NOW)]
    page = FakePage([SHOWN], rows)
    d = WebApiDriver(page)
    got = d.list_conversations()
    assert [(e.thread_id, e.display_name, e.surface) for e in got] == [
        ("name:Ana Martin", "Ana Martin", Surface.dm),
        ("48:notes", "Mes notes", Surface.dm),  # tes notes : la page ne les montre pas
        (f"title-{GRP}", "Projet FHIR", Surface.group),
        ("name:Marc Petit", "Marc Petit", Surface.dm),
    ]
    assert [e.rank for e in got[1:]] == [1, 2, 3]
    assert page._names["name:Marc Petit"] == "Marc Petit"
    assert d.routes()["list"]["via"] == "api"
    # Reliées par construction : lisibles et écrivables par le service.
    d._map([SHOWN])
    assert d._chat.mapped["name:Marc Petit"] == DM and "name:Marc Petit" in d._chat.strong


def test_namesakes_and_conversations_the_page_already_shows_are_not_added():
    rows = [row(DM, "dm", NOW, name="Ana Martin"),
            row("19:x_y@unq.gbl.spaces", "dm", NOW, name="Paul Roy"),
            row("19:y_z@unq.gbl.spaces", "dm", NOW, name="Paul Roy")]
    d = WebApiDriver(FakePage([SHOWN], rows))
    assert [e.thread_id for e in d.list_conversations()] == ["name:Ana Martin"]
    assert d.routes()["list"]["via"] == "page"


def test_self_notes_from_the_service_when_the_page_shows_none():
    rows = [row("48:notes", "self", NOW - 1000), row(GRP, "group", NOW - 2000, topic="Projet FHIR")]
    d = WebApiDriver(FakePage([SHOWN], rows))
    got = {e.thread_id: e for e in d.list_conversations()}
    assert got["48:notes"].is_self and got["48:notes"].display_name == "Mes notes"
    d._map([SHOWN])
    assert d._chat.mapped["48:notes"] == "48:notes" and "48:notes" in d._chat.strong
    # La page montre déjà tes notes : pas de doublon.
    mine = WatchEntity(thread_id="name:Moi (Vous)", display_name="Moi (Vous)", surface=Surface.dm, is_self=True)
    d2 = WebApiDriver(FakePage([SHOWN, mine], rows))
    assert "48:notes" not in [e.thread_id for e in d2.list_conversations()]
