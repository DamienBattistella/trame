"""WebApiDriver : changement de statut (Disponible, Occupé…) par le service de présence de Teams,
prouvé par relecture, avec repli sur le menu de la page quand rien n'est parti."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver


class FakePage:
    def __init__(self, answers=None, fail=None):
        self.answers = answers or {}
        self.fail = fail
        self.calls: list[tuple] = []
        self.page: list[tuple] = []

    def teams_people(self, kind, **args):
        self.calls.append((kind, args))
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        ans = self.answers[kind]
        return ans(args) if callable(ans) else dict(ans)

    def set_my_status(self, choice, duration=None, until=None):
        self.page.append((choice, duration, until))
        return choice


def proven(args):
    return {"ok": True, "availability": args["availability"], "activity": args["availability"], "ooo": False,
            "forced": {"availability": args["availability"], "expiry": args["expiry"]}}


@pytest.mark.parametrize("choice, availability", [
    ("available", "Available"), ("busy", "Busy"), ("dnd", "DoNotDisturb"),
    ("brb", "BeRightBack"), ("away", "Away"), ("offline", "Offline"),
])
def test_status_set_on_the_presence_service_until_changed(choice, availability):
    page = FakePage({"force": proven})
    d = WebApiDriver(page)
    assert d.set_my_status(choice) == choice
    assert page.calls == [("force", {"availability": availability, "expiry": ""})]
    assert page.page == []
    assert d.routes()["set_status"]["via"] == "api"


def test_a_meeting_shown_over_the_chosen_status_is_still_a_success():
    page = FakePage({"force": lambda a: {**proven(a), "activity": "InAMeeting"}})
    assert WebApiDriver(page).set_my_status("busy") == "busy"


def test_duration_and_until_become_an_expiry():
    page = FakePage({"force": proven})
    d = WebApiDriver(page)
    d.set_my_status("dnd", "1h")
    expiry = datetime.strptime(page.calls[-1][1]["expiry"], "%Y-%m-%dT%H:%M:%S.000Z").replace(tzinfo=timezone.utc)
    assert abs((expiry - datetime.now(timezone.utc)) - timedelta(hours=1)) < timedelta(seconds=5)
    end = datetime(2030, 3, 14, 17, 30)
    d.set_my_status("away", until=end)
    assert page.calls[-1][1]["expiry"] == end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def test_today_ends_tonight_and_week_ends_sunday_night_local_time():
    paris = timezone(timedelta(hours=1))
    thursday = datetime(2026, 11, 26, 15, 0, tzinfo=paris)
    assert WebApiDriver.status_expiry("today", None, thursday) == "2026-11-26T22:59:59.000Z"
    assert WebApiDriver.status_expiry("week", None, thursday) == "2026-11-29T22:59:59.000Z"
    sunday = datetime(2026, 11, 29, 9, 0, tzinfo=paris)
    assert WebApiDriver.status_expiry("week", None, sunday) == "2026-11-29T22:59:59.000Z"
    assert WebApiDriver.status_expiry("30m", None, thursday) == "2026-11-26T14:30:00.000Z"
    assert WebApiDriver.status_expiry(None, None, thursday) == ""


def test_reset_lets_teams_decide_and_reports_what_it_shows():
    page = FakePage({"reset": {"ok": True, "availability": "Busy", "activity": "InAMeeting", "ooo": False,
                               "forced": {"availability": "", "expiry": ""}}})
    d = WebApiDriver(page)
    assert d.set_my_status("reset") == "in_meeting"
    assert page.calls == [("reset", {})]


def test_nothing_sent_falls_back_to_the_page_menu():
    page = FakePage(fail="aucun jeton Teams observé pour l'instant")
    d = WebApiDriver(page)
    assert d.set_my_status("dnd", "2h") == "dnd"
    assert page.page == [("dnd", "2h", None)]
    assert d.routes()["set_status"]["via"] == "page"


def test_refused_by_the_service_falls_back_to_the_page_menu():
    page = FakePage({"force": {"ok": False, "attempted": True, "error": "statut refusé (HTTP 403)"}})
    d = WebApiDriver(page)
    assert d.set_my_status("busy") == "busy"
    assert page.page == [("busy", None, None)]
    assert "403" in d.routes()["set_status"]["reason"]


def test_sent_without_proof_is_never_redone_by_the_page():
    page = FakePage({"force": {"ok": False, "attempted": True, "uncertain": True,
                               "error": "statut non confirmé par le service de présence"}})
    with pytest.raises(RuntimeError, match="non confirmé"):
        WebApiDriver(page).set_my_status("away")
    assert page.page == []


def test_status_landmarks_only_watched_as_fallback_while_the_service_answers():
    d = WebApiDriver(FakePage({"force": proven}))
    d.set_my_status("busy")
    assert {"set_status", "status_duration", "status_until"} <= d.api_features()
    d = WebApiDriver(FakePage(fail="aucun jeton"))
    d.set_my_status("busy")
    assert not {"set_status", "status_duration", "status_until"} & d.api_features()


def test_reset_with_a_duration_is_refused():
    with pytest.raises(ValueError):
        WebApiDriver(FakePage()).set_my_status("reset", "1h")
