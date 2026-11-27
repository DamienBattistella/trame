"""MCP: a reply deposited for a precise message keeps that message and quotes it when sent."""
from __future__ import annotations

import json

from test_vision import DM, IdDriver, SeeingBrain


def _mcp(client, name, args):
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                  "params": {"name": name, "arguments": args}},
                    headers={"Authorization": f"Bearer {client.mcp_token}"}).json()["result"]
    return r["isError"], (json.loads(r["content"][0]["text"]) if not r["isError"] else r["content"][0]["text"])


def _enable(client, send=False):
    s = client.put("/api/settings", json={"mcp": {"enabled": True, "allow_send": send}}).json()["settings"]["mcp"]
    client.mcp_token = s["token"]


def _someone_elses_message(client, watcher):
    convs = _mcp(client, "list_conversations", {})[1]
    for c in convs:
        msgs = _mcp(client, "read_conversation", {"thread_id": c["thread_id"]})[1]["messages"]
        m = next((m for m in reversed(msgs) if not m["mine"] and m["text"] and m.get("id")), None)
        if m:
            return c["thread_id"], m
    raise AssertionError("aucun message d'un collègue dans le mock")


def test_propose_reply_targets_and_quotes_a_message(make_client):
    client, watcher, driver = make_client()
    _enable(client, send=True)
    tid, m = _someone_elses_message(client, watcher)
    err, out = _mcp(client, "propose_reply", {"thread_id": tid, "message_id": m["id"], "text": "Je regarde ça."})
    assert not err and out["quoted"] is True
    d = next(d for d in watcher.state.drafts if d.id == out["draft_id"])
    assert d.reply_to.id == m["id"] and d.incoming == m["text"] and d.from_ == m["sender"]
    # Sent through the MCP: the reply quotes that message in Teams.
    err, sent = _mcp(client, "send_draft", {"draft_id": d.id})
    assert not err, sent
    assert driver.replies[-1][1] == m["text"] and driver.replies[-1][2] == "Je regarde ça."


def test_propose_reply_without_message_id_is_unchanged(make_client):
    client, watcher, _driver = make_client()
    _enable(client)
    tid, _m = _someone_elses_message(client, watcher)
    err, out = _mcp(client, "propose_reply", {"thread_id": tid, "text": "Ok."})
    assert not err and "quoted" not in out
    d = next(d for d in watcher.state.drafts if d.id == out["draft_id"])
    assert d.reply_to is None and d.incoming == "Réponse préparée par un assistant externe (MCP)."


def test_image_only_message_is_targeted_without_quote(make_client):
    client, watcher, _driver = make_client(driver=IdDriver(interval=9999), brain=SeeingBrain())
    _enable(client)
    err, out = _mcp(client, "propose_reply", {"thread_id": DM, "message_id": "m0", "text": "Je vois l'erreur."})
    assert not err and out["quoted"] is False
    d = next(d for d in watcher.state.drafts if d.id == out["draft_id"])
    assert d.reply_to is None and d.incoming == "[image]\n[image]\n[image]"


def test_suggest_reply_saved_for_a_message_keeps_the_target(make_client):
    client, watcher, _driver = make_client()
    _enable(client)
    tid, m = _someone_elses_message(client, watcher)
    err, out = _mcp(client, "suggest_reply", {"thread_id": tid, "message_id": m["id"], "save": True})
    assert not err and out["quoted"] is True
    assert next(d for d in watcher.state.drafts if d.id == out["draft_id"]).reply_to.id == m["id"]


def test_propose_reply_unknown_message(make_client):
    client, _watcher, _driver = make_client(driver=IdDriver(interval=9999))
    _enable(client)
    err, text = _mcp(client, "propose_reply", {"thread_id": DM, "message_id": "nope", "text": "x"})
    assert err and "introuvable" in text
