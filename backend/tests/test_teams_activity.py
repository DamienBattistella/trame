"""Flux « Activité » de Teams (mentions, réponses, réactions) et derniers appels, lus sur le
service de chat (48:notifications, 48:calllogs) sans ouvrir le volet Activité."""
from __future__ import annotations

import json
import time

import pytest

from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver
from tests.test_mcp import _call, _enable
from tests.test_web_api_list import FakePage, row
from tests.test_older_conversations import SHOWN

NOW = int(time.time() * 1000)
PAGE_RESULT = {
    "ok": True,
    "activity": [
        {"kind": "mention", "type": "mention", "ts": NOW, "from": "Ana\nMartin", "conversation": "Équipe Interop",
         "thread": "19:recent@thread.v2", "message": "1795777000000", "preview": "@toi tu regardes ?"},
        {"kind": "reaction", "type": "reactionInChat", "ts": NOW - 1000, "from": "Marc Petit", "conversation": "",
         "thread": "19:p_q@unq.gbl.spaces", "message": "12"},
        {"kind": "weird", "type": "x", "ts": "nope", "thread": "javascript:alert(1)", "message": "1; drop"},
    ],
    "calls": [
        {"direction": "incoming", "state": "Missed", "type": "twoParty", "ts": NOW, "duration_s": 0,
         "with": "Marc Petit", "thread": "19:p_q@unq.gbl.spaces"},
        {"direction": "outgoing", "state": "accepted", "ts": NOW - 5000, "duration_s": "600", "with": "Ana Martin"},
    ],
    "errors": {"activity": None, "calls": None, "secret": "x"},
    "shape": {"activity_keys": ["activityType"], "token": "jamais"},
}


def _bridge(result=PAGE_RESULT):
    d = WebBridgeDriver()
    seen = []

    def rpc(op, timeout=None, **args):
        seen.append((op, args))
        return result
    d._rpc = rpc
    return d, seen


def test_bridge_checks_what_the_page_returns():
    d, seen = _bridge()
    out = d.activity_api(500)
    assert seen == [("chatactivity", {"limit": 200, "calls": True})]
    mention, reaction, weird = out["activity"]
    assert mention["from"] == "Ana Martin" and mention["teams_id"] == "19:recent@thread.v2"
    assert mention["message_id"] == "1795777000000" and mention["at"]
    assert weird["kind"] == "other" and weird["teams_id"] is None and weird["message_id"] is None and weird["at"] is None
    missed, out_call = out["calls"]
    assert missed["missed"] is True and missed["state"] == "missed"
    assert out_call["missed"] is False and out_call["duration_s"] == 600
    assert "secret" not in out["errors"] and out["shape"] == {"activity_keys": ["activityType"]}


def test_bridge_raises_when_the_page_refuses():
    d, _ = _bridge({"ok": False, "error": "jeton Teams expiré"})
    with pytest.raises(WebBridgeDriver.ApiError, match="expiré"):
        d.activity_api()


class ActivityPage(FakePage):
    def __init__(self, *a, fail=False, **k):
        super().__init__(*a, **k)
        self.fail = fail

    def activity_api(self, limit=50, calls=True):
        if self.fail:
            raise RuntimeError("service de chat refusé (HTTP 503)")
        d, _ = _bridge()
        return d.activity_api(limit, calls)


def _driver(fail=False):
    rows = [row("19:recent@thread.v2", "group", NOW, topic="Équipe Interop"),
            row("19:p_q@unq.gbl.spaces", "dm", NOW, name="Marc Petit")]
    d = WebApiDriver(ActivityPage([SHOWN], rows, fail=fail))
    d.list_conversations()
    return d


def test_api_driver_maps_conversations_to_trame_ids():
    d = _driver()
    out = d.teams_activity()
    assert [a["thread_id"] for a in out["activity"]] == ["title-19:recent@thread.v2", "name:Marc Petit", None]
    assert [c["thread_id"] for c in out["calls"]] == ["name:Marc Petit", None]
    assert d.routes()["activity"]["via"] == "api"


def test_api_driver_falls_back_and_says_why():
    d = _driver(fail=True)
    with pytest.raises(RuntimeError):
        d.teams_activity()
    assert d.routes()["activity"]["via"] == "page" and "503" in d.routes()["activity"]["reason"]


def test_endpoint_filters_and_unsupported_driver(make_client):
    client, watcher, _ = make_client()
    assert client.get("/api/teams/activity").json() == {"ok": True, "supported": False, "activity": [], "calls": [], "errors": {}}
    watcher.driver = _driver()
    r = client.get("/api/teams/activity?kind=mention").json()
    assert r["ok"] and r["supported"] and [a["kind"] for a in r["activity"]] == ["mention"]
    assert len(r["calls"]) == 2
    assert client.get("/api/teams/activity?kind=evil").status_code == 400
    watcher.driver = _driver(fail=True)
    assert client.get("/api/teams/activity").status_code == 503


def test_mcp_tool_lists_activity_and_missed_calls(make_client):
    client, watcher, _ = make_client()
    watcher.driver = _driver()
    token = _enable(client)
    res = _call(client, token, "tools/call", {"name": "list_activity", "arguments": {"missed_only": True}}).json()["result"]
    body = json.loads(res["content"][0]["text"])
    assert body["supported"] and len(body["activity"]) == 3
    assert [c["with"] for c in body["calls"]] == ["Marc Petit"]
