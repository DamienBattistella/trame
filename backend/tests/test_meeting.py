"""« Rejoindre dans Teams » : le lien d'une conversation de réunion, vérifié avant d'être gardé."""
from __future__ import annotations

import pytest

import drivers.base as basemod
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver
from meeting import join_url

MEETING = "19:meeting_YTM1@thread.v2"
JOIN = ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_YTM1%40thread.v2/0"
        "?context=%7b%22Tid%22%3a%229fff%22%2c%22Oid%22%3a%222eff%22%7d")


@pytest.mark.parametrize("url", [
    JOIN,
    "https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_x%40thread.v2/0",
    "https://teams.microsoft.com/meet/123456789?p=abc",
    "https://teams.live.com/meet/9876?p=xyz",
])
def test_teams_meeting_links_are_kept(url):
    assert join_url(url) == url


@pytest.mark.parametrize("url", [
    None, 42, "", "   ",
    "http://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0",       # pas https
    "https://evil.example/l/meetup-join/19%3ameeting_x/0",             # autre hôte
    "https://teams.microsoft.com.evil.example/l/meetup-join/x/0",      # hôte qui imite
    "https://user@teams.microsoft.com/l/meetup-join/x/0",              # identifiants dans l'URL
    "https://teams.microsoft.com:8443/l/meetup-join/x/0",              # port
    "https://teams.microsoft.com/l/chat/0/0?users=x",                  # pas une réunion
    "https://teams.microsoft.com/l/meetup-join/",                      # sans réunion
    "https://teams.microsoft.com/l/meetup-join/x\n/0",                 # caractère de contrôle
    "javascript:alert(1)",
    "https://teams.microsoft.com/l/meetup-join/" + "x" * 3000,
])
def test_anything_else_is_dropped(url):
    assert join_url(url) is None


def _reading(monkeypatch, meeting):
    d = WebBridgeDriver()
    monkeypatch.setattr(d, "_rpc", lambda op, timeout=None, **a: {"top": True, "meeting": meeting, "messages": [
        {"sender": "Christian", "text": "Did you have any news?"},
    ]})
    return d


def test_reading_a_meeting_chat_gives_its_link(monkeypatch):
    d = _reading(monkeypatch, {"url": JOIN, "live": False})
    assert d.meeting(MEETING) is None
    d.read_history(MEETING, 30)
    assert d.meeting(MEETING) == {"url": JOIN, "live": False}


def test_a_link_that_is_not_a_teams_meeting_is_not_kept(monkeypatch):
    d = _reading(monkeypatch, {"url": "https://evil.example/l/meetup-join/x/0", "live": True})
    d.read_history(MEETING, 30)
    assert d.meeting(MEETING) is None


def test_no_meeting_any_more_clears_the_link(monkeypatch):
    d = _reading(monkeypatch, {"url": JOIN, "live": True})
    d.read_history(MEETING, 30)
    monkeypatch.setattr(d, "_rpc", lambda op, timeout=None, **a: {"top": True, "messages": []})
    d.read_history(MEETING, 30)
    assert d.meeting(MEETING) is None


def test_in_progress_fades_but_the_link_stays(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(basemod.time, "monotonic", lambda: now[0])
    d = _reading(monkeypatch, {"url": JOIN, "live": True})
    d.read_history(MEETING, 30)
    assert d.meeting(MEETING) == {"url": JOIN, "live": True}
    now[0] += d.MEETING_LIVE_TTL + 1
    assert d.meeting(MEETING) == {"url": JOIN, "live": False}


def test_only_a_true_live_counts(monkeypatch):
    d = _reading(monkeypatch, {"url": JOIN, "live": "yes"})
    d.read_history(MEETING, 30)
    assert d.meeting(MEETING)["live"] is False


def test_api_gives_the_meeting_with_the_messages(make_client):
    client, watcher, _ = make_client(driver=MockTeamsDriver(interval=9999))
    meeting = "19:meeting_ff66@thread.v2"
    r = client.get(f"/api/threads/{meeting}/messages").json()
    assert r["ok"] and r["messages"]
    assert r["meeting"]["live"] is True
    assert r["meeting"]["url"].startswith("https://teams.microsoft.com/l/meetup-join/")
    # Une conversation ordinaire n'a pas de réunion.
    other = client.get("/api/threads/19:aa11@thread.v2/messages").json()
    assert other["meeting"] is None
