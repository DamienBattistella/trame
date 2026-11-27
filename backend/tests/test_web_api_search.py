"""WebApiDriver : recherche de messages dans les fils récents sur le service de chat, puis la
recherche de Teams dans la page quand le service ne trouve rien ou refuse."""
from __future__ import annotations

from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver

HIT = {"conversation": "Équipe Interop", "sender": "Ana Martin", "mine": False, "at": "14:02", "text": "La PR #214 est prête"}


class FakePage:
    def __init__(self, api=None, fail=None):
        self.api = api if api is not None else [HIT]
        self.fail = fail
        self.page: list[str] = []

    def search_messages_api(self, query, limit=25):
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        return list(self.api)

    def search_messages(self, query, limit=25):
        self.page.append(query)
        return [{"conversation": "Ancien", "sender": "Marc", "mine": False, "at": "12/03", "text": "vieux message PR"}]


def test_recent_messages_found_on_the_service_without_teams_search():
    page = FakePage()
    d = WebApiDriver(page)
    assert d.search_messages("pr 214") == [HIT]
    assert page.page == []
    assert d.routes()["search_messages"]["via"] == "api"


def test_nothing_in_recent_threads_goes_to_teams_search():
    page = FakePage(api=[])
    d = WebApiDriver(page)
    assert d.search_messages("vieux")[0]["conversation"] == "Ancien"
    assert page.page == ["vieux"]
    assert "rien dans les fils récents" in d.routes()["search_messages"]["reason"]


def test_service_refusal_goes_to_teams_search():
    page = FakePage(fail="liste refusée par le service de chat")
    d = WebApiDriver(page)
    d.search_messages("pr")
    assert page.page == ["pr"] and d.routes()["search_messages"]["via"] == "page"
