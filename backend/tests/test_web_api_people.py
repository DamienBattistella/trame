"""WebApiDriver : statut, note, recherche de personnes et présence des tête-à-tête par le service
de présence et le middletier de Teams, avec repli sur la page."""
from __future__ import annotations

import pytest

import presence as presencemod
from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver
from models import Surface, WatchEntity


class FakePage:
    def __init__(self, answers=None, fail=None):
        self.answers = answers or {}
        self.fail = fail
        self.calls: list[tuple] = []
        self.page: list[tuple] = []
        self.noted: dict[str, object] = {}

    def teams_people(self, kind, **args):
        self.calls.append((kind, args))
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        ans = self.answers[kind]
        return ans(args) if callable(ans) else dict(ans)

    def my_status(self, with_message=False):
        self.page.append(("my_status",))
        return {"presence": "available", **({"message": "page"} if with_message else {})}

    def set_status_message(self, text):
        self.page.append(("setnote", text))
        return text

    def search_people(self, query, limit=8):
        self.page.append(("search", query))
        return []

    def _note_presence(self, thread_id, value):
        self.noted[thread_id] = value


ME = {"ok": True, "availability": "Busy", "activity": "InAMeeting", "ooo": False,
      "note": {"message": "En atelier jusqu'à 16 h", "expiry": "2099-01-01T10:00:00.000Z"}}


@pytest.mark.parametrize("availability, activity, ooo, expected", [
    ("Available", "Available", False, "available"),
    ("Busy", "InAMeeting", False, "in_meeting"),
    ("Busy", "InACall", False, "in_call"),
    ("DoNotDisturb", "Presenting", False, "presenting"),
    ("DoNotDisturb", "DoNotDisturb", False, "dnd"),
    ("BeRightBack", "BeRightBack", False, "brb"),
    ("Away", "Away", True, "ooo"),
    ("Offline", "OffWork", False, "offline"),
    ("PresenceUnknown", "PresenceUnknown", False, None),
])
def test_service_values_become_trame_statuses(availability, activity, ooo, expected):
    assert presencemod.from_service(availability, activity, ooo) == expected


def test_my_status_and_note_read_on_the_presence_service():
    d = WebApiDriver(FakePage({"me": ME}))
    assert d.my_status(with_message=True) == {"presence": "in_meeting", "message": "En atelier jusqu'à 16 h"}
    assert d.routes()["my_status"]["via"] == "api"


def test_note_keeps_its_expiry_and_is_proven():
    page = FakePage({"me": ME, "note": lambda a: {"ok": True, "message": a["message"], "expiry": a["expiry"]}})
    d = WebApiDriver(page)
    assert d.set_status_message("  Retour   lundi ") == "Retour lundi"
    assert page.calls[-1] == ("note", {"message": "Retour lundi", "expiry": "2099-01-01T10:00:00.000Z"})
    assert page.page == []


def test_note_without_expiry_or_expired_never_expires_like_teams():
    expired = {**ME, "note": {"message": "x", "expiry": "2020-01-01T00:00:00.000Z"}}
    page = FakePage({"me": expired, "note": lambda a: {"ok": True, "message": a["message"]}})
    WebApiDriver(page).set_status_message("Télétravail")
    assert page.calls[-1][1]["expiry"] == WebApiDriver.NOTE_NEVER


def test_note_sent_without_proof_is_never_rewritten_by_the_page():
    page = FakePage({"me": ME, "note": {"ok": False, "attempted": True, "uncertain": True, "error": "note non confirmée"}})
    with pytest.raises(RuntimeError, match="non confirmée"):
        WebApiDriver(page).set_status_message("Absent")
    assert page.page == []


def test_service_refused_falls_back_to_the_page():
    page = FakePage(fail="présence refusée (HTTP 401)")
    d = WebApiDriver(page)
    assert d.my_status() == {"presence": "available"}
    assert d.set_status_message("x") == "x"
    assert d.search_people("ana") == []
    assert [p[0] for p in page.page] == ["my_status", "setnote", "search"]
    assert d.routes()["my_status"]["via"] == "page" and "HTTP 401" in d.routes()["my_status"]["reason"]


def test_people_search_names_from_the_middletier():
    page = FakePage({"search": {"ok": True, "people": [{"name": "Ana Martin"}, {"name": "Anatole Roy"}, {"name": ""}]}})
    d = WebApiDriver(page)
    assert d.can_search_people
    assert d.search_people("ana", limit=5) == ["Ana Martin", "Anatole Roy"]
    assert page.calls == [("search", {"query": "ana", "limit": 5})]


def test_presence_of_one_to_one_chats_read_for_the_whole_list_and_throttled():
    page = FakePage({"of": {"ok": True, "people": {"8:orgid:ana": {"availability": "Busy", "activity": "InACall"}}}})
    d = WebApiDriver(page)
    d._chat.rows = {"19:a_b@unq.gbl.spaces": {"other": "8:orgid:ana"}}
    ent = [WatchEntity(thread_id="name:Ana Martin", display_name="Ana Martin", surface=Surface.dm),
           WatchEntity(thread_id="title-19:g@thread.v2", display_name="Projet", surface=Surface.group)]
    d._refresh_presence(ent, {"name:Ana Martin": "19:a_b@unq.gbl.spaces"})
    assert ent[0].presence == "in_call" and page.noted == {"name:Ana Martin": "in_call"}
    assert page.calls == [("of", {"mris": ["8:orgid:ana"]})]
    d._refresh_presence(ent, {"name:Ana Martin": "19:a_b@unq.gbl.spaces"})
    assert len(page.calls) == 1  # au plus une lecture par minute
