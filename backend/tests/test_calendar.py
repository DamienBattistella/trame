"""Calendrier : l'agenda de Teams (Graph, lu dans la page) découpé par jour en heure locale,
et les transcriptions des réunions de la période rattachées même hors des 12 conversations
de réunion les plus récentes."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

import transcripts as t
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
    assert driver.asked == [[(MEET, "Weekly Hexaflux", JOIN)]]
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


# --- Réunions de canal : fil de la publication, transcription lue sur Graph ---------------
CHANNEL = "19:canal42@thread.tacv2"
CHAN_THREAD = f"{CHANNEL};messageid=1795000000000"
CHAN_JOIN = "https://teams.microsoft.com/l/meetup-join/19%3acanal42%40thread.tacv2/1795000000000?context=x"
VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ana Martin>Bonjour à tous</v>\n\n00:00:05.000 --> 00:00:07.000\n<v Marc Dupont>On commence</v>\n"


def chan_event(**kw):
    return ev(id="chan", subject="Revue d'équipe", start="2026-11-26T09:00:00Z", end="2026-11-26T10:00:00Z",
              join_url=CHAN_JOIN, thread=CHANNEL, root="1795000000000", recurring=False, **kw)


def test_calendar_days_gives_a_channel_meeting_its_publication_thread():
    out = calendar_days([chan_event(), ev(id="chan-no-root", thread=CHANNEL, root="")], date(2026, 11, 23), date(2026, 11, 29), NOW)
    chan = next(e for e in out if e["event_id"] == "chan")
    assert chan["chat_id"] == CHAN_THREAD and chan["thread_id"] == "chan:" + CHAN_THREAD
    # Sans publication connue, le canal seul n'est pas un fil de réunion à relire.
    assert next(e for e in out if e["event_id"] == "chan-no-root")["thread_id"] == ""


class ChannelPage(ChatPage):
    def __init__(self, graph=None):
        super().__init__()
        self.graph = graph or {"ok": True, "vtt": VTT}
        self.graph_asked = []

    def meetings_api(self, threads, topics=None):
        self.asked.append((list(threads), dict(topics or {})))
        return [{"thread": CHAN_THREAD, "recaps": [{"mid": "1795003480000", "when": "jeudi 26 novembre 2026 10:00 - 11:00",
                                                    "transcript": False}]}]

    def transcript_graph(self, join_url, at=0):
        self.graph_asked.append((join_url, at))
        return self.graph


def test_web_api_reads_channel_meetings_and_their_transcript_on_graph():
    page = ChannelPage()
    d = WebApiDriver(page)
    got = d.meetings_of_chats([(CHAN_THREAD, "Revue d'équipe", CHAN_JOIN), ("19:canal42@thread.tacv2", "x", CHAN_JOIN)])
    assert page.asked == [([CHAN_THREAD], {CHAN_THREAD: "Revue d'équipe"})]
    assert got == [{"thread_id": "chan:" + CHAN_THREAD, "chat": "Revue d'équipe", "mid": "1795003480000", "title": "Revue d'équipe",
                    "when": "jeudi 26 novembre 2026 10:00 - 11:00", "transcript": False, "join_url": CHAN_JOIN}]
    res = d.meeting_transcript_graph(CHAN_JOIN, 1795003480000)
    assert page.graph_asked == [(CHAN_JOIN, 1795003480000)]
    assert res["ok"] and res["entries"] == [{"speaker": "Ana Martin", "time": "00:00:01", "text": "Bonjour à tous"},
                                            {"speaker": "Marc Dupont", "time": "00:00:05", "text": "On commence"}]
    refused = WebApiDriver(ChannelPage({"ok": False, "reason": "denied", "error": "HTTP 403"})).meeting_transcript_graph(CHAN_JOIN)
    assert refused["reason"] == "graph_denied"


@pytest.fixture
def transcripts_dir(tmp_path, monkeypatch):
    """Jamais le vrai dossier Documents dans les tests."""
    folder = tmp_path / "Transcriptions"
    monkeypatch.setattr(t, "default_dir", lambda: folder)
    return folder


def channel_driver(graph=None):
    d = calendar_driver([chan_event()], [{"thread_id": "chan:" + CHAN_THREAD, "chat": "Revue d'équipe", "mid": "1795003480000",
                                          "title": "Revue d'équipe", "when": "jeudi 26 novembre 2026 10:00 - 11:00",
                                          "transcript": False, "join_url": CHAN_JOIN}])
    d.graph_asked = []

    def meeting_transcript_graph(join_url, at=0):
        d.graph_asked.append((join_url, at))
        return graph or {"ok": True, "entries": [{"speaker": "Ana Martin", "time": "00:00:01", "text": "Bonjour à tous"}],
                         "complete": True}

    d.meeting_transcript_graph = meeting_transcript_graph
    return d


def test_api_channel_meeting_listed_from_the_calendar_and_its_transcript_saved(make_client, transcripts_dir):
    driver = channel_driver()
    client, _w, _d = make_client(driver=driver)
    r = client.get("/api/calendar", params={"start": "2026-11-23", "end": "2026-11-29"}).json()
    assert driver.asked == [[(CHAN_THREAD, "Revue d'équipe", CHAN_JOIN)]]
    m = next(x for x in r["meetings"] if x["thread_id"] == "chan:" + CHAN_THREAD)
    assert m["join_url"] == CHAN_JOIN and r["events"][0]["thread_id"] == m["thread_id"]
    saved = client.post("/api/meetings/transcript", json={"thread_id": m["thread_id"], "mid": m["mid"]}).json()
    assert saved["ok"] and saved["name"] == "2026-11-26 Revue d'équipe.vtt", saved
    assert driver.graph_asked == [(CHAN_JOIN, 1795003480000)]
    assert "<v Ana Martin>Bonjour à tous</v>" in Path(saved["path"]).read_text(encoding="utf-8")


def test_api_channel_transcript_refusals_are_explained(make_client):
    driver = channel_driver({"ok": False, "reason": "graph_denied", "error": "HTTP 403"})
    client, _w, _d = make_client(driver=driver)
    # Lien inconnu (réunion jamais vue dans le Calendrier).
    nolink = client.post("/api/meetings/transcript", json={"thread_id": "chan:" + CHAN_THREAD, "mid": "1795003480000"})
    assert nolink.status_code == 404 and "Calendrier" in nolink.json()["error"]
    client.get("/api/calendar", params={"start": "2026-11-23", "end": "2026-11-29"})
    denied = client.post("/api/meetings/transcript", json={"thread_id": "chan:" + CHAN_THREAD, "mid": "1795003480000"})
    assert denied.status_code == 403 and "Graph" in denied.json()["error"]


def test_meetings_list_also_brings_channel_meetings_from_the_calendar(make_client):
    driver = channel_driver()
    client, _w, _d = make_client(driver=driver)
    listed = client.get("/api/meetings").json()["meetings"]
    assert any(x["thread_id"] == "chan:" + CHAN_THREAD for x in listed)
