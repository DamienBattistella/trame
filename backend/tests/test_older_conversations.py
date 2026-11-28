"""« Anciennes conversations » : celles que le service de chat connaît et que la liste ne montre
pas, parcourues à la demande, et ouvertes dans la liste seulement sur un clic."""
from __future__ import annotations

import time

import pytest

from drivers.web_api import WebApiDriver
from models import Surface, WatchEntity
from tests.test_web_api_list import FakePage, row

NOW = int(time.time() * 1000)
DAY = 86400 * 1000
SHOWN = WatchEntity(thread_id="name:Ana Martin", display_name="Ana Martin", surface=Surface.dm)


def _rows():
    return [row("19:ana_x@unq.gbl.spaces", "dm", NOW, name="Ana Martin"),
            row("19:recent@thread.v2", "group", NOW - DAY, topic="Équipe Interop"),
            row("19:old@thread.v2", "group", NOW - 200 * DAY, topic="Vieux projet séjours"),
            row("19:meeting_abc@thread.v2", "meeting", NOW - 100 * DAY, topic="Revue de sprint"),
            row("19:p_q@unq.gbl.spaces", "dm", NOW - 300 * DAY, name="Marc Petit"),
            row("19:empty@thread.v2", "group", NOW - 50 * DAY, topic="Vide", empty=True),
            row("19:notopic@thread.v2", "group", NOW - 60 * DAY, topic=""),
            row("19:x_y@unq.gbl.spaces", "dm", NOW - 70 * DAY, name="Paul Roy"),
            row("19:y_z@unq.gbl.spaces", "dm", NOW - 80 * DAY, name="Paul Roy")]


def _driver():
    d = WebApiDriver(FakePage([SHOWN], _rows()))
    d.list_conversations()
    return d


def test_lists_what_the_list_does_not_show_most_recent_first():
    d = _driver()
    items, total = d.older_conversations(exclude=["name:Ana Martin"])
    assert [(e.thread_id, e.display_name, e.surface) for e in items] == [
        ("title-19:recent@thread.v2", "Équipe Interop", Surface.group),
        ("title-19:meeting_abc@thread.v2", "Revue de sprint", Surface.group),
        ("title-19:old@thread.v2", "Vieux projet séjours", Surface.group),
        ("name:Marc Petit", "Marc Petit", Surface.dm),
    ]
    assert total == 4  # ni vide, ni sans nom, ni homonymes, ni celle déjà dans la liste


def test_filter_by_name_ignores_case_and_accents_and_pages():
    d = _driver()
    items, total = d.older_conversations("SEJOURS vieux", exclude=["name:Ana Martin"])
    assert [e.display_name for e in items] == ["Vieux projet séjours"] and total == 1
    first, total = d.older_conversations(limit=2, exclude=["name:Ana Martin"])
    rest, _ = d.older_conversations(offset=2, limit=2, exclude=["name:Ana Martin"])
    assert total == 4 and [e.display_name for e in first + rest] == [
        "Équipe Interop", "Revue de sprint", "Vieux projet séjours", "Marc Petit"]


def test_open_links_a_listed_conversation_only():
    d = _driver()
    d.older_conversations(exclude=["name:Ana Martin"])
    assert d.open_older("title-19:invented@thread.v2") is None  # jamais un id venu d'ailleurs
    e = d.open_older("name:Marc Petit")
    assert e.display_name == "Marc Petit" and e.surface == Surface.dm
    assert d._chat.mapped["name:Marc Petit"] == "19:p_q@unq.gbl.spaces"
    assert "name:Marc Petit" in d._chat.strong
    assert d._inner.chat_aliases["name:Marc Petit"] == "19:p_q@unq.gbl.spaces"
    # Gardée à la relecture suivante de la liste, même si la page ne la montre pas.
    d._map([SHOWN])
    assert d._chat.mapped["name:Marc Petit"] == "19:p_q@unq.gbl.spaces"


def test_service_down_raises():
    class Down(FakePage):
        def chat_list(self, sync=""):
            raise RuntimeError("401")
    d = WebApiDriver(Down([SHOWN], []))
    with pytest.raises(RuntimeError):
        d.older_conversations()


def test_watcher_endpoints_list_and_open(make_client):
    client, watcher, _driver_ = make_client()
    d = _driver()
    watcher.driver = d
    r = client.get("/api/conversations/older?q=marc").json()
    assert r["ok"] and r["supported"] and r["total"] == 1
    tid = r["conversations"][0]["thread_id"]
    opened = client.post("/api/conversations/older/open", json={"thread_id": tid}).json()
    assert opened["ok"] and opened["conversation"]["display_name"] == "Marc Petit"
    assert any(w.thread_id == tid for w in watcher.state.watchlist)
    # Déjà dans la liste : n'est plus proposée.
    assert client.get("/api/conversations/older?q=marc").json()["total"] == 0
    assert client.post("/api/conversations/older/open", json={"thread_id": "title-19:nope@thread.v2"}).status_code == 404


def test_drivers_without_the_service_say_so(make_client):
    client, _watcher, _driver_ = make_client()
    r = client.get("/api/conversations/older").json()
    assert r["ok"] and r["supported"] is False and r["conversations"] == []
