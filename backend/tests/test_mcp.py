from __future__ import annotations
import json


def _call(client, token, method, params=None, mid=1):
    return client.post("/mcp", json={"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}},
                       headers={"Authorization": f"Bearer {token}"})


def _enable(client):
    s = client.put("/api/settings", json={"mcp": {"enabled": True}}).json()["settings"]["mcp"]
    assert s["enabled"] and len(s["token"]) >= 20
    return s["token"]


def test_disabled_or_wrong_token_is_refused(make_client):
    client, _w, _d = make_client()
    assert _call(client, "x", "tools/list").status_code == 401
    _enable(client)
    assert _call(client, "mauvais", "tools/list").status_code == 401


def test_handshake_and_tools(make_client):
    client, _w, _d = make_client()
    token = _enable(client)
    init = _call(client, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}).json()
    assert init["result"]["serverInfo"]["name"] == "trame" and "tools" in init["result"]["capabilities"]
    assert client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                       headers={"Authorization": f"Bearer {token}"}).status_code == 202
    names = {t["name"] for t in _call(client, token, "tools/list").json()["result"]["tools"]}
    assert names == {"list_conversations", "read_conversation", "summarize_conversation", "list_drafts", "propose_reply"}


def test_propose_reply_lands_in_review_and_never_sends(make_client):
    client, watcher, driver = make_client()
    token = _enable(client)
    convs = json.loads(_call(client, token, "tools/call", {"name": "list_conversations", "arguments": {"status": "followed"}}).json()["result"]["content"][0]["text"])
    target = convs[0]["thread_id"]
    r = _call(client, token, "tools/call", {"name": "propose_reply", "arguments": {"thread_id": target, "text": "Je regarde et je reviens vers toi."}}).json()
    assert r["result"]["isError"] is False
    assert any(d.thread_id == target and d.proposal.startswith("Je regarde") for d in watcher.state.drafts)
    assert driver.typed == []
    bad = _call(client, token, "tools/call", {"name": "send_message", "arguments": {}}).json()
    assert bad["error"]["code"] == -32602


def test_regenerate_token(make_client):
    client, _w, _d = make_client()
    first = _enable(client)
    second = client.put("/api/settings", json={"mcp": {"regenerate_token": True}}).json()["settings"]["mcp"]["token"]
    assert second and second != first
    assert _call(client, first, "ping").status_code == 401 and _call(client, second, "ping").status_code == 200
