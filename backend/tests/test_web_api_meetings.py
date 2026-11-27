"""WebApiDriver : réunions terminées lues sur le service de chat (rien d'ouvert dans la page),
même `mid` que la carte de la page ; la page reprend si le service refuse."""
from __future__ import annotations

from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver

MEET = "19:meeting_YTM1abc@thread.v2"


class FakePage:
    def __init__(self, fail=None):
        self.fail = fail
        self.asked: list = []
        self.page: list = []

    def chat_list(self, sync=""):
        return {"full": True, "sync": "S", "me": "8:orgid:me", "rows": [
            {"id": MEET, "kind": "meeting", "topic": "Migration weekly", "last": {"id": "2", "ts": 2000}},
            {"id": "19:grp@thread.v2", "kind": "group", "topic": "Projet X", "last": {"id": "9", "ts": 9000}},
        ]}

    def meetings_api(self, threads):
        self.asked.append(list(threads))
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        return [{"thread": MEET, "recaps": [{"mid": "1795774816062", "when": "vendredi 27 novembre 2026 11:00 - 11:20",
                                             "transcript": True}]}]

    def list_meetings(self, limit=None):
        self.page.append(limit)
        return []


def test_meetings_are_read_on_the_service_with_the_page_ids():
    page = FakePage()
    d = WebApiDriver(page)
    got = d.list_meetings()
    assert page.asked == [[MEET]] and page.page == []
    assert got == [{"thread_id": "title-" + MEET, "chat": "Migration weekly", "mid": "1795774816062",
                    "title": "Migration weekly", "when": "vendredi 27 novembre 2026 11:00 - 11:20", "transcript": True}]
    assert d.routes()["meetings"]["via"] == "api"


def test_meetings_fall_back_to_the_page_when_the_service_refuses():
    page = FakePage(fail="fil refusé")
    d = WebApiDriver(page)
    d.list_meetings()
    assert page.page == [None] and d.routes()["meetings"]["via"] == "page"
