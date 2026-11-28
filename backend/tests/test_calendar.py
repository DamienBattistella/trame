"""Calendrier : l'agenda de Teams (Graph, lu dans la page) découpé par jour en heure locale,
et les transcriptions des réunions de la période rattachées même hors des 12 conversations
de réunion les plus récentes."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from drivers.mock import MockTeamsDriver
from drivers.web_api import WebApiDriver
from watcher import calendar_days

PARIS = timezone(timedelta(hours=1))
NOW = datetime(2026, 11, 28, 13, 23, tzinfo=PARIS)
MEET = "19:meeting_hexaflux@thread.v2"
JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_hexaflux%40thread.v2/0?context=x"


def ev(**kw):
    base = {"id": "e1", "subject": "Weekly Hexaflux", "start": "2026-11-25T08:45:00Z", "end": "2026-11-25T09:15:00Z",
            "all_day": False, "start_day": "", "end_day": "", "show_as": "busy", "private": False, "cancelled": False,
            "online": True, "join_url": JOIN, "thread": MEET, "organizer": "Ana Martin", "location": "", "recurring": True,
            "response": "accepted"}
    return {**base, **kw}


def test_calendar_days_local_time_overnight_split_all_day_and_cancelled():
    raw = [
        ev(),
        ev(id="oof", subject="Out of the office", start="2026-11-25T18:00:00Z", end="2026-11-26T07:00:00Z",
           show_as="oof", online=False, join_url="", thread=""),
        ev(id="ad", subject="Unsubscribe", all_day=True, start="2026-11-25T00:00:00Z", end="2026-11-26T00:00:00Z",
           start_day="2026-11-25", end_day="2026-11-26", private=True, online=False, join_url="", thread=""),
        ev(id="x", subject="Annulée", cancelled=True),
        ev(id="next", subject="À venir", start="2026-11-30T09:00:00Z", end="2026-11-30T10:00:00Z"),
        ev(id="bad", join_url="https://evil.test/l/meetup-join/x"),
    ]
    out = calendar_days(raw, date(2026, 11, 23), date(2026, 11, 29), NOW)
    weekly = next(e for e in out if e["event_id"] == "e1")
    assert (weekly["date"], weekly["start"], weekly["end"]) == ("2026-11-25", "09:45", "10:15")
    assert weekly["thread_id"] == "title-" + MEET and weekly["chat_id"] == MEET and weekly["join_url"] == JOIN
    assert weekly["started"] and weekly["ended"]
    away = [e for e in out if e["event_id"] == "oof"]
    assert [(e["date"], e["start"], e["end"]) for e in away] == [("2026-11-25", "19:00", "00:00"), ("2026-11-26", "00:00", "08:00")]
    day = next(e for e in out if e["event_id"] == "ad")
    assert day["all_day"] and day["date"] == "2026-11-25" and day["start"] is None and day["private"]
    assert not any(e["event_id"] in ("x", "next") for e in out)  # annulée ; hors période
    assert next(e for e in out if e["event_id"] == "bad")["join_url"] == ""  # lien qui n'est pas Teams


class ChatPage:
    def __init__(self):
        self.asked = []

    def chat_list(self, sync=""):
        return {"full": True, "sync": "S", "me": "8:orgid:me", "rows": []}

    def meetings_api(self, threads, topics=None):
        self.asked.append((list(threads), dict(topics or {})))
        return [{"thread": MEET, "recaps": [{"mid": "1700000000999", "when": "mercredi 25 novembre 2026 09:45 - 10:15",
                                             "transcript": True}]}]

    def calendar_api(self, start, end):
        return [ev()]


def test_web_api_reads_the_meeting_chats_the_calendar_shows_even_when_not_recent():
    page = ChatPage()
    d = WebApiDriver(page)
    assert d.can_read_calendar and d.calendar_events("2026-11-23", "2026-11-29")[0]["thread"] == MEET
    got = d.meetings_of_chats([(MEET, "Weekly Hexaflux"), ("19:pas-une-reunion@thread.v2", "x")])
    assert page.asked == [([MEET], {MEET: "Weekly Hexaflux"})]
    assert got == [{"thread_id": "title-" + MEET, "chat": "Weekly Hexaflux", "mid": "1700000000999",
                    "title": "Weekly Hexaflux", "when": "mercredi 25 novembre 2026 09:45 - 10:15", "transcript": True}]


def calendar_driver(events, recaps):
    d = MockTeamsDriver(interval=9999)
    d.asked = []
    d.can_read_calendar = True
    d.calendar_events = lambda start, end: events

    def meetings_of_chats(chats):
        d.asked.append(list(chats))
        return recaps

    d.meetings_of_chats = meetings_of_chats
    return d


def test_api_calendar_returns_events_and_reads_missing_meeting_chats_once(make_client):
    recaps = [{"thread_id": "title-" + MEET, "chat": "Weekly Hexaflux", "mid": "1700000000999",
               "title": "Weekly Hexaflux", "when": "mercredi 25 novembre 2026 09:45 - 10:15", "transcript": True}]
    driver = calendar_driver([ev(), ev(id="later", start="2030-01-01T09:00:00Z", end="2030-01-01T10:00:00Z")], recaps)
    client, _w, _d = make_client(driver=driver)
    r = client.get("/api/calendar", params={"start": "2026-11-23", "end": "2026-11-29"}).json()
    assert r["ok"] and [e["event_id"] for e in r["events"]] == ["e1"]
    assert driver.asked == [[(MEET, "Weekly Hexaflux")]]
    m = next(m for m in r["meetings"] if m["thread_id"] == "title-" + MEET)
    assert (m["date"], m["start"], m["end"], m["transcript"]) == ("2026-11-25", "09:45", "10:15", True)
    # Gardée sur le poste ; déjà connue : la conversation n'est pas relue.
    assert any(x["thread_id"] == "title-" + MEET for x in client.get("/api/meetings/known").json()["meetings"])
    client.get("/api/calendar", params={"start": "2026-11-23", "end": "2026-11-29"})
    assert len(driver.asked) == 1


def test_api_calendar_does_not_reread_a_meeting_that_never_happened_at_each_display(make_client):
    driver = calendar_driver([ev()], [])
    client, _w, _d = make_client(driver=driver)
    for _ in range(3):
        assert client.get("/api/calendar", params={"start": "2026-11-23", "end": "2026-11-29"}).json()["ok"]
    assert len(driver.asked) == 1


def test_api_calendar_errors(make_client):
    client, _w, _d = make_client()
    assert client.get("/api/calendar", params={"start": "2026-11-23", "end": "2026-11-29"}).status_code == 501
    driver = calendar_driver([], [])
    client, _w, _d = make_client(driver=driver)
    assert client.get("/api/calendar", params={"start": "x", "end": "2026-11-29"}).status_code == 422
    assert client.get("/api/calendar", params={"start": "2026-01-01", "end": "2026-12-31"}).status_code == 422
    driver.calendar_events = lambda s, e: (_ for _ in ()).throw(RuntimeError("Graph refuse"))
    bad = client.get("/api/calendar", params={"start": "2026-11-23", "end": "2026-11-29"})
    assert bad.status_code == 502 and "Graph refuse" in bad.json()["error"]
