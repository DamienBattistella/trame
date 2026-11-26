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
    assert {"list_conversations", "read_conversation", "summarize_conversation", "list_drafts", "propose_reply",
            "get_status", "get_logs", "get_telemetry", "edit_draft", "dismiss_draft", "suggest_reply",
            "follow_conversation", "lookup_person", "get_persona", "catch_up", "set_paused"} <= names
    assert not names & {"send_draft", "send_message"}


def test_propose_reply_lands_in_review_and_never_sends(make_client):
    client, watcher, driver = make_client()
    token = _enable(client)
    convs = json.loads(_call(client, token, "tools/call", {"name": "list_conversations", "arguments": {"status": "followed"}}).json()["result"]["content"][0]["text"])
    target = convs[0]["thread_id"]
    r = _call(client, token, "tools/call", {"name": "propose_reply", "arguments": {"thread_id": target, "text": "Je regarde et je reviens vers toi."}}).json()
    assert r["result"]["isError"] is False
    assert any(d.thread_id == target and d.proposal.startswith("Je regarde") for d in watcher.state.drafts)
    assert driver.typed == []
    bad = _call(client, token, "tools/call", {"name": "delete_everything", "arguments": {}}).json()
    assert bad["error"]["code"] == -32602


def test_regenerate_token(make_client):
    client, _w, _d = make_client()
    first = _enable(client)
    second = client.put("/api/settings", json={"mcp": {"regenerate_token": True}}).json()["settings"]["mcp"]["token"]
    assert second and second != first
    assert _call(client, first, "ping").status_code == 401 and _call(client, second, "ping").status_code == 200


def test_status_logs_and_telemetry_tools(make_client):
    client, watcher, _d = make_client()
    token = _enable(client)
    watcher.log("warn", "Envoi à Alice refusé : « secret 40k »")

    def tool(name, **args):
        r = _call(client, token, "tools/call", {"name": name, "arguments": args}).json()["result"]
        assert r["isError"] is False, r
        return json.loads(r["content"][0]["text"])

    status = tool("get_status")
    assert status["teams"]["driver"] and "followed" in status
    logs = tool("get_logs", level="warn")
    assert logs and all(l["level"] == "warn" for l in logs) and not any("40k" in l["text"] for l in logs)
    assert [l["level"] for l in tool("get_logs", query="ALICE")] == ["warn"] and tool("get_logs", query="zzz") == []
    full = tool("get_logs", full=True)
    assert full["text"].startswith("# Trame : journaux")
    assert "records" in tool("get_telemetry", limit=5)


def _tool(client, token, tool_name, **args):
    r = _call(client, token, "tools/call", {"name": tool_name, "arguments": args}).json()["result"]
    return r["isError"], (json.loads(r["content"][0]["text"]) if not r["isError"] else r["content"][0]["text"])


def test_conversation_by_name_and_draft_lifecycle(make_client):
    client, watcher, driver = make_client()
    token = _enable(client)
    first = watcher.state.watchlist[0]
    err, read = _tool(client, token, "read_conversation", name=first.display_name.upper())
    assert not err and read["thread_id"] == first.thread_id
    err, msg = _tool(client, token, "read_conversation", name="Personne Inconnue XYZ")
    assert err and "Aucune discussion" in msg
    err, d = _tool(client, token, "propose_reply", name=first.display_name, text="Premier jet")
    assert not err
    err, edited = _tool(client, token, "edit_draft", draft_id=d["draft_id"], text="Version finale")
    assert not err and edited["draft"]["proposal"] == "Version finale"
    err, _ = _tool(client, token, "dismiss_draft", draft_id=d["draft_id"])
    assert not err and all(x.id != d["draft_id"] for x in watcher.state.drafts)
    assert driver.typed == []


def test_sending_requires_explicit_permission(make_client):
    client, watcher, driver = make_client()
    token = _enable(client)
    target = watcher.state.watchlist[0]
    err, msg = _tool(client, token, "send_message", thread_id=target.thread_id, text="Coucou")
    assert err and "autorisé" in msg and driver.typed == []
    err, msg = _tool(client, token, "follow_conversation", thread_id=target.thread_id, mode="auto")
    assert err and "Auto" in msg
    s = client.put("/api/settings", json={"mcp": {"allow_send": True}}).json()["settings"]["mcp"]
    assert s["allow_send"] is True
    names = {t["name"] for t in _call(client, token, "tools/list").json()["result"]["tools"]}
    assert {"send_draft", "send_message"} <= names
    err, sent = _tool(client, token, "send_message", thread_id=target.thread_id, text="Coucou")
    assert not err and sent["ok"] and driver.typed[-1][1] == "Coucou"


def test_prompts_and_settings_hide_token(make_client):
    client, _w, _d = make_client()
    token = _enable(client)
    prompts = _call(client, token, "prompts/list").json()["result"]["prompts"]
    assert {p["name"] for p in prompts} == {"trier_mes_messages", "repondre_a", "diagnostiquer_trame"}
    got = _call(client, token, "prompts/get", {"name": "repondre_a", "arguments": {"nom": "Romain"}}).json()["result"]
    assert "Romain" in got["messages"][0]["content"]["text"]
    err, settings = _tool(client, token, "get_settings")
    assert not err and "token" not in settings["mcp"]
    err, persona = _tool(client, token, "get_persona")
    assert not err and "soul" in persona
    err, who = _tool(client, token, "lookup_person", name="Quelqu'un")
    assert not err and who["found"] is False


def test_own_status_tools(make_client):
    client, watcher, driver = make_client()
    token = _enable(client)
    names = {t["name"] for t in _call(client, token, "tools/list").json()["result"]["tools"]}
    assert {"get_my_status", "set_my_status"} <= names
    assert _tool(client, token, "set_my_status", presence="dnd", message="  En atelier  ") == (
        False, {"ok": True, "presence": "dnd", "message": "En atelier"})
    assert driver.my_presence == "dnd" and driver.my_message == "En atelier"
    assert _tool(client, token, "get_my_status") == (False, {"presence": "dnd", "message": "En atelier"})
    assert _tool(client, token, "get_status")[1]["my_presence"] == "dnd"
    # Effacer le message seulement : le statut ne bouge pas.
    assert _tool(client, token, "set_my_status", message="")[0] is False
    assert driver.my_presence == "dnd" and driver.my_message == ""


def test_set_my_status_refusals(make_client):
    from drivers.mock import MockTeamsDriver

    class Stubborn(MockTeamsDriver):
        def set_my_status(self, choice):
            return "dnd"

    client, _watcher, driver = make_client(driver=Stubborn(interval=9999))
    token = _enable(client)
    assert _tool(client, token, "set_my_status")[0]
    assert _tool(client, token, "set_my_status", presence="in_meeting")[0]
    err, msg = _tool(client, token, "set_my_status", presence="available")
    assert err and "Ne pas déranger" in msg
