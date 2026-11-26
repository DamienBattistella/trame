"""Supprimer un de ses propres messages dans Teams : jamais celui d'un autre, jamais un
message que le pilote ne retrouve pas avec certitude, jamais de faux succès."""
from __future__ import annotations

from conftest import RefusingDriver
from drivers.base import DeleteUncertain
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver
from drivers.windows_uia import WindowsUIADriver
from models import DELETED_TEXT

DM = "19:aa11@thread.v2"
DM_URL = "/api/threads/19%3Aaa11%40thread.v2"
# Deuxième message du fil de démo de Sofia : écrit par l'utilisateur (id m1).
MINE = {"id": "m1", "sender": "Damien Battistella", "text": "Je regarde. C'est le job de tests d'intégration HL7 ?", "at": "08:54"}
# Troisième message : écrit par Sofia (id m2).
THEIRS = {"id": "m2", "sender": "Sofia Marino", "text": "Oui, le test du parseur OBX tombe en timeout sur le runner Windows."}


def test_delete_own_message(make_client):
    client, watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    r = client.post(f"{DM_URL}/delete", json={"message": MINE})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert driver.deleted == {f"{DM}/m1"}
    # Le fil en cache montre la bulle « supprimée », sans relire Teams ; les autres restent.
    msgs = client.get(f"{DM_URL}/messages").json()["messages"]
    assert msgs[1]["deleted"] is True and msgs[1]["text"] == DELETED_TEXT
    assert msgs[2]["deleted"] is False and msgs[2]["text"] == THEIRS["text"]
    # Une relecture de Teams dit la même chose.
    fresh = client.get(f"{DM_URL}/messages?fresh=true").json()["messages"]
    assert fresh[1]["deleted"] is True and fresh[1]["text"] == DELETED_TEXT
    assert any("Message supprimé" in item.text and "Je regarde" in item.text for item in watcher.state.logs)


def test_delete_refuses_someone_elses_message(make_client):
    client, watcher, driver = make_client()
    r = client.post(f"{DM_URL}/delete", json={"message": THEIRS})
    assert r.status_code == 403 and r.json()["ok"] is False and "tes propres messages" in r.json()["error"]
    assert driver.deleted == set() and driver.opened == []
    assert any("Suppression refusée" in item.text for item in watcher.state.logs)


def test_delete_refuses_a_message_without_author(make_client):
    client, _watcher, driver = make_client()
    r = client.post(f"{DM_URL}/delete", json={"message": {**MINE, "sender": ""}})
    assert r.status_code == 403 and driver.deleted == set()


def test_delete_refuses_a_message_claimed_mine_but_read_as_someone_elses(make_client):
    # Le fil lu dit que m2 est à Sofia : se dire auteur ne suffit pas.
    client, _watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    r = client.post(f"{DM_URL}/delete", json={"message": {**THEIRS, "sender": "Damien Battistella"}})
    assert r.status_code == 403 and driver.deleted == set()


def test_delete_driver_refuses_another_authors_message(make_client):
    # Même sans fil en cache, le pilote ne retrouve pas ce message sous cet auteur : rien.
    client, _watcher, driver = make_client()
    r = client.post(f"{DM_URL}/delete", json={"message": {**THEIRS, "id": None, "sender": "Damien Battistella"}})
    assert r.status_code == 409 and "Rien n'a été supprimé" in r.json()["error"]
    assert driver.deleted == set()


def test_delete_refuses_a_message_not_found(make_client):
    client, watcher, driver = make_client()
    gone = {**MINE, "text": "Un texte qui n'est pas dans la conversation."}
    r = client.post(f"{DM_URL}/delete", json={"message": gone})
    assert r.status_code == 409 and "Rien n'a été supprimé" in r.json()["error"]
    assert driver.deleted == set()
    assert any("Suppression refusée" in item.text for item in watcher.state.logs)


def test_delete_refuses_when_conversation_not_confirmed(make_client):
    client, _watcher, driver = make_client(driver=RefusingDriver(interval=9999))
    r = client.post(f"{DM_URL}/delete", json={"message": MINE})
    assert r.status_code == 409 and driver.deleted == set()


def test_delete_twice_is_refused(make_client):
    client, _watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    assert client.post(f"{DM_URL}/delete", json={"message": MINE}).status_code == 200
    r = client.post(f"{DM_URL}/delete", json={"message": MINE})
    assert r.status_code == 409 and "déjà supprimé" in r.json()["error"]


class UncertainDriver(MockTeamsDriver):
    def _delete_in_active(self, thread_id, target):
        raise DeleteUncertain("message non affiché comme supprimé, vérifie dans Teams")


def test_delete_not_confirmed_is_never_a_success(make_client):
    client, watcher, _driver = make_client(driver=UncertainDriver(interval=9999))
    client.get(f"{DM_URL}/messages")
    r = client.post(f"{DM_URL}/delete", json={"message": MINE})
    assert r.status_code == 409 and "non confirmée" in r.json()["error"]
    assert not any("Message supprimé" in item.text for item in watcher.state.logs)


class NoDeleteDriver(MockTeamsDriver):
    supports_delete = False


def test_driver_without_delete_refuses_cleanly(make_client):
    client, _watcher, driver = make_client(driver=NoDeleteDriver(interval=9999))
    assert client.get("/api/state").json()["capabilities"]["delete"] is False
    r = client.post(f"{DM_URL}/delete", json={"message": MINE})
    assert r.status_code == 501 and driver.deleted == set()


def test_windows_uia_driver_says_why_it_cannot_delete():
    assert WindowsUIADriver.supports_delete is False
    assert "Teams intégré" in WindowsUIADriver.delete_unsupported


def test_mcp_never_exposes_delete(make_client):
    # Supprimer n'est qu'un geste de l'utilisateur dans la vue : aucun outil MCP, même
    # avec l'envoi autorisé.
    client, _w, driver = make_client()
    s = client.put("/api/settings", json={"mcp": {"enabled": True, "allow_send": True}}).json()["settings"]["mcp"]
    res = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                      headers={"Authorization": f"Bearer {s['token']}"}).json()
    names = {t["name"] for t in res["result"]["tools"]}
    assert names and not any("delete" in n or "remove" in n or "supprim" in n for n in names)
    assert driver.deleted == set()


def test_web_bridge_sends_delete_and_reads_deleted_messages():
    d = WebBridgeDriver()
    d._names[DM] = "Sofia Marino"
    seen: list[tuple[str, dict]] = []

    def rpc(op, timeout=None, **args):
        seen.append((op, args))
        if op == "delete":
            return {"ok": True}
        # Tel que Teams web l'affiche : le lien « Annuler » collé au point, puis seul.
        return {"messages": [{"sender": "Damien Battistella", "text": "Ce message a été supprimé.Annuler", "id": "a"},
                             {"sender": "Damien Battistella", "text": "This message has been deleted.", "id": "c"},
                             {"sender": "Sofia Marino", "text": "Ce message a été supprimé, c'est ça ?", "id": "b"}],
                "top": True}

    d._rpc = rpc
    from models import MessageRef
    assert d._delete_in_active(DM, MessageRef(**MINE)) is True
    op, args = seen[0]
    assert op == "delete" and args["name"] == "Sofia Marino" and args["message"]["text"] == MINE["text"]
    msgs, _top = d.read_history(DM, 10)
    assert msgs[0].deleted and msgs[0].text == DELETED_TEXT
    assert msgs[1].deleted and msgs[1].text == DELETED_TEXT
    assert not msgs[2].deleted


def test_web_bridge_unconfirmed_delete_is_uncertain():
    d = WebBridgeDriver()
    d._rpc = lambda op, timeout=None, **a: {"ok": False, "uncertain": True, "error": "non affiché comme supprimé"}
    from models import MessageRef
    try:
        d._delete_in_active(DM, MessageRef(**MINE))
    except DeleteUncertain as e:
        assert "supprimé" in str(e)
    else:
        raise AssertionError("une suppression non confirmée doit lever DeleteUncertain")
