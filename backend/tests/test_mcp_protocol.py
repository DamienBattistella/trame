"""MCP au-delà des outils : négociation, sessions, ressources, complétion, sortie structurée,
progression et journal en flux, confirmation d'envoi (elicitation)."""
from __future__ import annotations
import json
import threading
import time
from urllib.parse import quote


def _enable(client, **mcp):
    return client.put("/api/settings", json={"mcp": {"enabled": True, **mcp}}).json()["settings"]["mcp"]["token"]


def _post(client, token, body, sid=None, stream=False):
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/json, text/event-stream" if stream else "application/json"}
    if sid:
        headers["Mcp-Session-Id"] = sid
    return client.post("/mcp", json=body, headers=headers)


def _rpc(client, token, method, params=None, sid=None, mid=1):
    return _post(client, token, {"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}, sid).json()


def _events(text):
    return [json.loads(line[len("data: "):]) for line in text.splitlines() if line.startswith("data: ")]


def _init(client, token, capabilities=None, version="2025-06-18"):
    r = _post(client, token, {"jsonrpc": "2.0", "id": 0, "method": "initialize",
                              "params": {"protocolVersion": version, "capabilities": capabilities or {},
                                         "clientInfo": {"name": "t", "version": "1"}}})
    return r.headers.get("mcp-session-id"), r.json()["result"]


def test_negotiation_capabilities_and_session(make_client):
    client, _w, _d = make_client()
    token = _enable(client)
    sid, init = _init(client, token)
    assert sid and init["protocolVersion"] == "2025-06-18"
    assert {"tools", "prompts", "resources", "completions", "logging"} <= set(init["capabilities"])
    _sid, old = _init(client, token, version="2025-03-26")
    assert old["protocolVersion"] == "2025-03-26"
    _sid, future = _init(client, token, version="2099-01-01")
    assert future["protocolVersion"] == "2025-06-18"
    # Une session inconnue (Trame redémarré) est servie quand même.
    assert _rpc(client, token, "ping", sid="inconnue")["result"] == {}
    assert client.delete("/mcp", headers={"Authorization": f"Bearer {token}", "Mcp-Session-Id": sid}).status_code == 204
    assert client.delete("/mcp", headers={"Authorization": "Bearer faux"}).status_code == 401


def test_resources_list_templates_and_read(make_client):
    client, watcher, _d = make_client()
    token = _enable(client)
    listed = _rpc(client, token, "resources/list")["result"]["resources"]
    uris = {r["uri"] for r in listed}
    assert {"trame://status", "trame://persona", "trame://conversations", "trame://drafts"} <= uris
    followed = next(w for w in watcher.state.watchlist if w.watch)
    conv = "trame://conversation/" + quote(followed.thread_id, safe="")
    assert conv in uris
    templates = {t["uriTemplate"] for t in _rpc(client, token, "resources/templates/list")["result"]["resourceTemplates"]}
    assert "trame://conversation/{thread_id}" in templates and "trame://person/{name}" in templates

    status = _rpc(client, token, "resources/read", {"uri": "trame://status"})["result"]["contents"][0]
    assert status["mimeType"] == "application/json" and "followed" in json.loads(status["text"])
    settings = json.loads(_rpc(client, token, "resources/read", {"uri": "trame://settings"})["result"]["contents"][0]["text"])
    assert "token" not in settings["mcp"]
    read = json.loads(_rpc(client, token, "resources/read", {"uri": conv})["result"]["contents"][0]["text"])
    assert read["thread_id"] == followed.thread_id and "messages" in read
    persona = _rpc(client, token, "resources/read", {"uri": "trame://persona"})["result"]["contents"][0]
    assert persona["mimeType"] == "text/markdown"
    assert _rpc(client, token, "resources/read", {"uri": "trame://rien"})["error"]["code"] == -32002
    assert _rpc(client, token, "resources/read", {"uri": "https://exemple.org"})["error"]["code"] == -32002
    assert _rpc(client, token, "resources/read", {"uri": "trame://draft/zzz"})["error"]["code"] == -32002


def test_completion_for_prompts_and_templates(make_client):
    client, watcher, _d = make_client()
    token = _enable(client)
    first = watcher.state.watchlist[0]
    part = first.display_name[:3].lower()
    got = _rpc(client, token, "completion/complete", {"ref": {"type": "ref/prompt", "name": "repondre_a"},
                                                      "argument": {"name": "nom", "value": part}})["result"]["completion"]
    assert first.display_name in got["values"] and got["total"] >= 1
    ids = _rpc(client, token, "completion/complete",
               {"ref": {"type": "ref/resource", "uri": "trame://conversation/{thread_id}"},
                "argument": {"name": "thread_id", "value": part}})["result"]["completion"]["values"]
    assert first.thread_id in ids
    none = _rpc(client, token, "completion/complete", {"ref": {"type": "ref/prompt", "name": "inconnu"},
                                                       "argument": {"name": "x", "value": ""}})["result"]["completion"]
    assert none["values"] == []


def test_structured_output_and_resource_link(make_client):
    client, watcher, _d = make_client()
    token = _enable(client)
    first = watcher.state.watchlist[0]
    r = _rpc(client, token, "tools/call", {"name": "read_conversation", "arguments": {"thread_id": first.thread_id}})["result"]
    assert r["structuredContent"]["thread_id"] == first.thread_id
    assert json.loads(r["content"][0]["text"]) == r["structuredContent"]
    link = next(c for c in r["content"] if c["type"] == "resource_link")
    assert link["uri"] == "trame://conversation/" + quote(first.thread_id, safe="")
    # Une liste reste en texte seul : structuredContent est toujours un objet.
    lst = _rpc(client, token, "tools/call", {"name": "list_drafts", "arguments": {}})["result"]
    assert "structuredContent" not in lst


def test_progress_and_logging_stream(make_client):
    client, _w, _d = make_client()
    token = _enable(client)
    sid, _ = _init(client, token)
    assert _rpc(client, token, "logging/setLevel", {"level": "info"}, sid=sid)["result"] == {}
    assert _rpc(client, token, "logging/setLevel", {"level": "bavard"}, sid=sid)["error"]["code"] == -32602
    r = _post(client, token, {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                              "params": {"name": "get_status", "arguments": {}, "_meta": {"progressToken": "p1"}}},
              sid=sid, stream=True)
    assert r.headers["content-type"].startswith("text/event-stream")
    events = _events(r.text)
    progress = [e["params"] for e in events if e.get("method") == "notifications/progress"]
    assert [p["progress"] for p in progress] == [0, 1] and all(p["progressToken"] == "p1" for p in progress)
    logs = [e["params"] for e in events if e.get("method") == "notifications/message"]
    assert logs and all(l["level"] != "debug" for l in logs)
    assert events[-1]["id"] == 7 and events[-1]["result"]["isError"] is False
    # Sans jeton de progression ni journal demandé, la réponse reste du JSON simple.
    plain = _post(client, token, {"jsonrpc": "2.0", "id": 8, "method": "tools/call",
                                  "params": {"name": "get_status", "arguments": {}}}, stream=True)
    assert plain.headers["content-type"].startswith("application/json")


def _send_with_answer(client, token, watcher, answer):
    sid, _ = _init(client, token, capabilities={"elicitation": {}})
    target = watcher.state.watchlist[0]
    out: dict = {}

    def run():
        out["r"] = _post(client, token, {"jsonrpc": "2.0", "id": 11, "method": "tools/call",
                                         "params": {"name": "send_message",
                                                    "arguments": {"thread_id": target.thread_id, "text": "Coucou"}}},
                         sid=sid, stream=True)

    t = threading.Thread(target=run)
    t.start()
    router_pending = None
    for _ in range(200):
        router_pending = _pending_ids(client)
        if router_pending:
            break
        time.sleep(0.02)
    assert router_pending, "aucune question posée au client"
    rid = router_pending[0]
    assert _post(client, token, {"jsonrpc": "2.0", "id": rid, "result": answer}, sid=sid).status_code == 202
    t.join(10)
    return _events(out["r"].text)


def _pending_ids(client):
    return list(client.app.state.mcp_pending)


def test_send_asks_the_user_first_when_the_client_can(make_client, monkeypatch):
    import mcp_server
    monkeypatch.setattr(mcp_server, "ELICIT_TIMEOUT", 5)
    client, watcher, driver = make_client()
    token = _enable(client, allow_send=True)
    events = _send_with_answer(client, token, watcher, {"action": "decline"})
    ask = next(e for e in events if e.get("method") == "elicitation/create")
    assert "Coucou" in ask["params"]["message"] and "confirm" in ask["params"]["requestedSchema"]["properties"]
    assert events[-1]["result"]["isError"] is True and "annulé" in events[-1]["result"]["content"][0]["text"]
    assert driver.typed == []
    events = _send_with_answer(client, token, watcher, {"action": "accept", "content": {"confirm": True}})
    assert events[-1]["result"]["isError"] is False and driver.typed[-1][1] == "Coucou"


def test_send_without_elicitation_support_is_unchanged(make_client):
    client, watcher, driver = make_client()
    token = _enable(client, allow_send=True)
    sid, _ = _init(client, token)
    target = watcher.state.watchlist[0]
    r = _rpc(client, token, "tools/call", {"name": "send_message", "arguments": {"thread_id": target.thread_id, "text": "Salut"}}, sid=sid)
    assert r["result"]["isError"] is False and driver.typed[-1][1] == "Salut"


def test_prompt_embeds_persona_resource(make_client):
    client, watcher, _d = make_client()
    token = _enable(client)
    watcher.soul = "# Moi\nJe tutoie."
    got = _rpc(client, token, "prompts/get", {"name": "repondre_a", "arguments": {"nom": "Romain"}})["result"]
    assert got["messages"][0]["content"]["type"] == "resource"
    assert got["messages"][0]["content"]["resource"]["uri"] == "trame://persona"
    assert "Romain" in got["messages"][-1]["content"]["text"]
