"""WebApiDriver : « Nouvelle conversation » avec quelqu'un dont le tête-à-tête existe sur le service
de chat, sans ouvrir la page ; la page reprend tout le reste (tête-à-tête jamais créé, homonymes)."""
from __future__ import annotations

from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver
from models import Surface, WatchEntity

ANA = "8:orgid:ana"
DM = "19:aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002@unq.gbl.spaces"


class FakePage:
    def __init__(self, people=None, rows=None, fail=None):
        self.people = people if people is not None else [{"name": "Ana Martin", "mri": ANA}]
        self.rows = rows if rows is not None else [{"id": DM, "kind": "dm", "other": ANA, "name": "Ana Martin"}]
        self.fail = fail
        self.calls: list[tuple] = []
        self.page: list[str] = []
        self.chat_aliases: dict[str, str] = {}
        self._names: dict[str, str] = {}
        self._kinds: dict[str, Surface] = {}
        self.last_error = None

    def teams_people(self, kind, **args):
        self.calls.append((kind, args))
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        return {"ok": True, "people": self.people}

    def chat_list(self, sync=""):
        return {"full": True, "rows": self.rows, "sync": "S", "me": "8:orgid:me"}

    dm_answer: dict = {"ok": False, "attempted": False, "error": "service indisponible"}
    dm_calls: list = []

    def chat_dm(self, mri):
        self.dm_calls = [*self.dm_calls, mri]
        return dict(self.dm_answer)

    def start_chat(self, name):
        self.page.append(name)
        return WatchEntity(thread_id=f"name:{name}", display_name=name, surface=Surface.dm)


def test_existing_one_to_one_opened_on_the_service_without_the_page():
    page = FakePage()
    d = WebApiDriver(page)
    e = d.start_chat("  ana   martin ")
    assert e.thread_id == "name:Ana Martin" and e.display_name == "Ana Martin" and e.surface == Surface.dm
    assert page.page == []
    assert page.chat_aliases == {"name:Ana Martin": DM}
    assert page._names["name:Ana Martin"] == "Ana Martin"
    assert d.routes()["start_chat"]["via"] == "api"


def test_started_chat_stays_linked_and_writable_after_the_next_list_refresh():
    page = FakePage()
    d = WebApiDriver(page)
    d.start_chat("Ana Martin")
    d._refresh_chat()
    d._map([])  # la page ne montre pas ce tête-à-tête
    assert d._chat.mapped["name:Ana Martin"] == DM
    assert "name:Ana Martin" in d._chat.strong
    assert page.chat_aliases == {"name:Ana Martin": DM}


def test_one_to_one_missing_from_the_list_is_found_or_created_on_the_service():
    page = FakePage(rows=[])
    page.dm_answer = {"ok": True, "id": DM, "created": True}
    d = WebApiDriver(page)
    e = d.start_chat("Ana Martin")
    assert page.dm_calls == [ANA]
    assert page.page == [] and e.thread_id == "name:Ana Martin"
    assert page.chat_aliases == {"name:Ana Martin": DM}
    assert d.routes()["start_chat"]["via"] == "api"


def test_one_to_one_the_service_cannot_open_goes_to_the_page():
    page = FakePage(rows=[])
    d = WebApiDriver(page)
    d.start_chat("Ana Martin")
    assert page.page == ["Ana Martin"]
    assert "service indisponible" in d.routes()["start_chat"]["reason"]


def test_namesakes_or_nobody_found_go_to_the_page():
    twins = FakePage(people=[{"name": "Ana Martin", "mri": ANA}, {"name": "Ana Martin", "mri": "8:orgid:ana2"}])
    d = WebApiDriver(twins)
    d.start_chat("Ana Martin")
    assert twins.page == ["Ana Martin"] and "homonymes" in d.routes()["start_chat"]["reason"]
    nobody = FakePage(people=[{"name": "Anabelle Roy", "mri": "8:orgid:x"}])
    d = WebApiDriver(nobody)
    d.start_chat("Ana Martin")
    assert nobody.page == ["Ana Martin"]


def test_search_unavailable_goes_to_the_page():
    page = FakePage(fail="aucun jeton Teams observé pour l'instant")
    d = WebApiDriver(page)
    d.start_chat("Ana Martin")
    assert page.page == ["Ana Martin"]
    assert d.routes()["start_chat"]["via"] == "page"
