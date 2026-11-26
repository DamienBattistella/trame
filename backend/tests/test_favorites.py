from __future__ import annotations
import json

import config as cfgmod
from test_mcp import _call, _enable

SOFIA, LUCAS, PROD, CHIARA = "19:aa11@thread.v2", "19:bb22@thread.v2", "19:dd44@thread.v2", "19:ee55@thread.v2"


def _saved(home) -> list[str]:
    return json.loads((home / "config.json").read_text(encoding="utf-8")).get("favorites", [])


def test_add_and_remove_favorite_independent_of_follow(make_client, fresh_home):
    client, watcher, _d = make_client()
    before = {w.thread_id: (w.watch, w.mode) for w in watcher.state.watchlist}
    # Une conversation non suivie peut être épinglée ; ni « Suivie » ni le mode ne bougent.
    assert client.post(f"/api/favorite/{CHIARA}", json={"favorite": True}).json() == {"ok": True, "favorites": [CHIARA]}
    assert client.post(f"/api/favorite/{SOFIA}", json={"favorite": True}).json()["favorites"] == [CHIARA, SOFIA]
    # Ajouter deux fois ne duplique pas.
    assert client.post(f"/api/favorite/{CHIARA}", json={"favorite": True}).json()["favorites"] == [CHIARA, SOFIA]
    assert {w.thread_id: (w.watch, w.mode) for w in watcher.state.watchlist} == before
    assert client.get("/api/state").json()["favorites"] == [CHIARA, SOFIA]
    assert client.post(f"/api/favorite/{CHIARA}", json={"favorite": False}).json()["favorites"] == [SOFIA]
    # Retirer un non-favori ne fait rien ; une conversation inconnue est refusée.
    assert client.post(f"/api/favorite/{LUCAS}", json={"favorite": False}).json()["favorites"] == [SOFIA]
    assert client.post("/api/favorite/19:inconnue@thread.v2", json={"favorite": True}).status_code == 404
    assert _saved(fresh_home) == [SOFIA]


def test_order_is_kept_and_reorderable(make_client, fresh_home):
    client, watcher, _d = make_client()
    for t in (SOFIA, LUCAS, PROD):
        client.post(f"/api/favorite/{t}", json={"favorite": True})
    assert watcher.state.favorites == [SOFIA, LUCAS, PROD]
    r = client.put("/api/favorites", json={"order": [PROD, SOFIA, LUCAS]}).json()
    assert r["favorites"] == [PROD, SOFIA, LUCAS] and _saved(fresh_home) == [PROD, SOFIA, LUCAS]
    # Un ordre partiel ou avec des inconnus : les oubliés gardent leur place relative, à la suite.
    assert client.put("/api/favorites", json={"order": [LUCAS, "19:x@thread.v2", LUCAS]}).json()["favorites"] == [LUCAS, PROD, SOFIA]


def test_favorites_survive_restart_and_rediscovery(make_client, fresh_home):
    client, _w, _d = make_client()
    client.post(f"/api/favorite/{CHIARA}", json={"favorite": True})
    client.post(f"/api/favorite/{SOFIA}", json={"favorite": True})
    # Nouveau démarrage du moteur sur la même configuration.
    _client2, watcher2, driver2 = make_client()
    assert watcher2.state.favorites == [CHIARA, SOFIA]
    # Teams ne liste plus la conversation (hors de sa liste) : épinglée, elle reste connue.
    driver2._convs = [c for c in driver2._convs if c.thread_id != CHIARA]
    watcher2.refresh_conversations()
    assert any(w.thread_id == CHIARA for w in watcher2.state.watchlist)


def test_factory_reset_empties_favorites(make_client, fresh_home):
    client, watcher, _d = make_client()
    client.post(f"/api/favorite/{SOFIA}", json={"favorite": True})
    assert client.post("/api/reset", json={"confirm": "RESET"}).json() == {"ok": True}
    assert watcher.state.favorites == [] and _saved(fresh_home) == []
    assert cfgmod.load()["favorites"] == []


def test_mcp_list_conversations_marks_favorites_first(make_client):
    client, _w, _d = make_client()
    client.post(f"/api/favorite/{PROD}", json={"favorite": True})
    client.post(f"/api/favorite/{CHIARA}", json={"favorite": True})
    token = _enable(client)
    convs = json.loads(_call(client, token, "tools/call", {"name": "list_conversations", "arguments": {}}).json()["result"]["content"][0]["text"])
    assert [c["thread_id"] for c in convs[:2]] == [PROD, CHIARA]
    assert all(c["favorite"] is (c["thread_id"] in (PROD, CHIARA)) for c in convs)
    # Lecture seule : aucun outil MCP ne change les favoris.
    names = {t["name"] for t in _call(client, token, "tools/list").json()["result"]["tools"]}
    assert not any("favorite" in n for n in names)
