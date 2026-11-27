"""WebApiDriver : recherche dans les conversations récentes sur le service de chat, avec le
thread_id de Trame de chaque conversation ; la recherche de Teams (page) reste à part."""
from __future__ import annotations

import pytest

from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver

DM = "19:aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002@unq.gbl.spaces"


def hit(conv, teams_id, text="La PR #214 est prête"):
    return {"conversation": conv, "sender": "Ana Martin", "mine": False, "at": "14:02", "text": text, "teams_id": teams_id}


class FakePage:
    def __init__(self, api=None, fail=None):
        self.api = api if api is not None else []
        self.fail = fail
        self.page: list[str] = []

    def search_messages_api(self, query, limit=25):
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        return [dict(h) for h in self.api]

    def search_messages(self, query, limit=25):
        self.page.append(query)
        return []


def test_recent_results_carry_the_trame_thread_id_of_their_conversation():
    page = FakePage([hit("Projet X", "19:grp@thread.v2"), hit("Ana Martin", DM), hit("", "48:notes"), hit("Nulle part", None)])
    d = WebApiDriver(page)
    d._chat.mapped = {"name:Ana Martin": DM, "self-notes": "48:notes"}
    got = d.search_recent("pr")
    assert [h["thread_id"] for h in got] == ["title-19:grp@thread.v2", "name:Ana Martin", "self-notes", None]
    assert all("teams_id" not in h for h in got)
    assert page.page == [] and d.routes()["search_messages"]["via"] == "api"


def test_teams_search_is_the_page_and_is_never_replaced_by_recent_results():
    page = FakePage([hit("Projet X", "19:grp@thread.v2")])
    d = WebApiDriver(page)
    d.search_messages("pr")
    assert page.page == ["pr"]


def test_recent_search_refused_raises_for_the_caller_to_fall_back():
    d = WebApiDriver(FakePage(fail="liste refusée par le service de chat"))
    assert d.can_search_recent is True
    with pytest.raises(WebBridgeDriver.ApiError):
        d.search_recent("pr")
