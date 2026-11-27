"""Modifier un de ses propres messages dans Teams : jamais celui d'un autre, jamais un message
que le pilote ne retrouve pas avec certitude, jamais un message riche réécrit en texte brut,
jamais de faux succès. Même rigueur que la suppression."""
from __future__ import annotations

import pytest

from conftest import RefusingDriver
from drivers.base import EditUncertain, Focus
from drivers.mock import MockTeamsDriver
from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver
from drivers.windows_uia import WindowsUIADriver
from models import MessageRef

DM = "19:aa11@thread.v2"
DM_URL = "/api/threads/19%3Aaa11%40thread.v2"
# Deuxième message du fil de démo de Sofia : écrit par l'utilisateur (id m1).
MINE = {"id": "m1", "sender": MockTeamsDriver.ME, "text": "Je regarde. C'est le job de tests d'intégration HL7 ?", "at": "08:54"}
# Troisième message : écrit par Sofia (id m2).
THEIRS = {"id": "m2", "sender": "Sofia Marino", "text": "Oui, le test du parseur OBX tombe en timeout sur le runner Windows."}
NEW = "Je regarde. C'est bien le job d'intégration HL7 ?"


def test_edit_own_message(make_client):
    client, watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": f"  {NEW}  "})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert driver.edited == {f"{DM}/m1": NEW}
    # Le fil en cache montre le nouveau texte, marqué « Modifié », sans relire Teams.
    msgs = client.get(f"{DM_URL}/messages").json()["messages"]
    assert msgs[1]["text"] == NEW and msgs[1]["edited"] is True
    assert msgs[2]["edited"] is False and msgs[2]["text"] == THEIRS["text"]
    # Une relecture de Teams dit la même chose.
    fresh = client.get(f"{DM_URL}/messages?fresh=true").json()["messages"]
    assert fresh[1]["text"] == NEW and fresh[1]["edited"] is True
    assert any("Message modifié" in item.text and "Je regarde" in item.text for item in watcher.state.logs)


def test_edit_capability_is_advertised(make_client):
    client, _w, _d = make_client()
    assert client.get("/api/state").json()["capabilities"]["edit"] is True


def test_edit_refuses_someone_elses_message(make_client):
    client, watcher, driver = make_client()
    r = client.post(f"{DM_URL}/edit", json={"message": THEIRS, "text": "autre chose"})
    assert r.status_code == 403 and "tes propres messages" in r.json()["error"]
    assert driver.edited == {} and driver.opened == []
    assert any("Modification refusée" in item.text for item in watcher.state.logs)


def test_edit_refuses_a_message_claimed_mine_but_read_as_someone_elses(make_client):
    client, _watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    r = client.post(f"{DM_URL}/edit", json={"message": {**THEIRS, "sender": MockTeamsDriver.ME}, "text": "x"})
    assert r.status_code == 403 and driver.edited == {}


def test_edit_driver_refuses_another_authors_message(make_client):
    # Sans fil en cache, le pilote ne retrouve pas ce message sous cet auteur : rien.
    client, _watcher, driver = make_client()
    r = client.post(f"{DM_URL}/edit", json={"message": {**THEIRS, "id": None, "sender": MockTeamsDriver.ME}, "text": "x"})
    assert r.status_code == 409 and "Rien n'a été modifié" in r.json()["error"]
    assert driver.edited == {}


@pytest.mark.parametrize("text", ["", "   \n  "])
def test_edit_refuses_an_empty_text(make_client, text):
    client, _watcher, driver = make_client()
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": text})
    assert r.status_code == 422 and "supprime-le" in r.json()["error"]
    assert driver.edited == {} and driver.opened == []


def test_edit_with_the_same_text_does_nothing(make_client):
    client, _watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    opened = list(driver.opened)
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": MINE["text"]})
    assert r.status_code == 200 and driver.edited == {} and driver.opened == opened


def test_edit_refuses_a_deleted_message(make_client):
    client, _watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    assert client.post(f"{DM_URL}/delete", json={"message": MINE}).status_code == 200
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": NEW})
    assert r.status_code == 409 and "supprimé" in r.json()["error"] and driver.edited == {}


def test_edit_refuses_a_rich_message(make_client):
    # Citation, mention, pièce jointe ou carte : réécrites en texte brut, elles seraient perdues.
    client, watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    with watcher._lock:
        cached = watcher._thread_cache[DM][1]
        next(m for m in cached if m.get("id") == "m1")["mentions"] = ["Sofia Marino"]
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": NEW})
    assert r.status_code == 409 and "modifie-le dans Teams" in r.json()["error"] and driver.edited == {}


def test_edit_refuses_when_conversation_not_confirmed(make_client):
    client, _watcher, driver = make_client(driver=RefusingDriver(interval=9999))
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": NEW})
    assert r.status_code == 409 and driver.edited == {}


class UncertainDriver(MockTeamsDriver):
    def _edit_in_active(self, thread_id, target, text):
        raise EditUncertain("nouveau texte non affiché dans Teams")


def test_edit_not_confirmed_is_never_a_success(make_client):
    client, watcher, _driver = make_client(driver=UncertainDriver(interval=9999))
    client.get(f"{DM_URL}/messages")
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": NEW})
    assert r.status_code == 409 and "non confirmée" in r.json()["error"]
    assert not any("Message modifié" in item.text for item in watcher.state.logs)


class NoEditDriver(MockTeamsDriver):
    supports_edit = False


def test_driver_without_edit_refuses_cleanly(make_client):
    client, _watcher, driver = make_client(driver=NoEditDriver(interval=9999))
    assert client.get("/api/state").json()["capabilities"]["edit"] is False
    r = client.post(f"{DM_URL}/edit", json={"message": MINE, "text": NEW})
    assert r.status_code == 501 and driver.edited == {}


def test_windows_uia_driver_cannot_edit():
    assert WindowsUIADriver.supports_edit is False


def test_mcp_never_exposes_edit(make_client):
    # Modifier n'est qu'un geste de l'utilisateur dans la vue : aucun outil MCP.
    client, _w, driver = make_client()
    s = client.put("/api/settings", json={"mcp": {"enabled": True, "allow_send": True}}).json()["settings"]["mcp"]
    res = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                      headers={"Authorization": f"Bearer {s['token']}"}).json()
    names = {t["name"] for t in res["result"]["tools"]}
    # edit_draft modifie un brouillon de Trame, jamais un message déjà dans Teams.
    assert names and not any(("edit" in n and n != "edit_draft") or "modif" in n for n in names)
    assert driver.edited == {}


# --- Pont Teams web : par la page --------------------------------------------------------

def test_web_bridge_sends_edit_to_the_page():
    d = WebBridgeDriver()
    d._names[DM] = "Sofia Marino"
    seen: list[tuple[str, dict]] = []

    def rpc(op, timeout=None, **args):
        seen.append((op, args))
        return {"ok": True}

    d._rpc = rpc
    assert d._edit_in_active(DM, MessageRef(**MINE), NEW) is True
    op, args = seen[0]
    assert op == "edit" and args["name"] == "Sofia Marino" and args["text"] == NEW
    assert args["message"]["text"] == MINE["text"]


def test_web_bridge_unconfirmed_edit_is_uncertain():
    d = WebBridgeDriver()
    d._rpc = lambda op, timeout=None, **a: {"ok": False, "uncertain": True, "error": "nouveau texte non affiché"}
    with pytest.raises(EditUncertain):
        d._edit_in_active(DM, MessageRef(**MINE), NEW)


# --- Service de chat d'abord, page en repli ----------------------------------------------

TID = "title-19:grp@thread.v2"
REF = MessageRef(id="1795777000001", sender="Ana Martin", text="Bonjour")


class FakePage:
    def __init__(self, answer):
        self.answer = answer
        self.calls: list[tuple] = []
        self.page: list[tuple] = []
        self.chat_aliases: dict[str, str] = {}
        self.last_error = None

    _ref = staticmethod(WebBridgeDriver._ref)
    chat_id = staticmethod(WebBridgeDriver.chat_id)

    def chat_gesture(self, kind, thread_id, **args):
        self.calls.append((kind, thread_id, args))
        return dict(self.answer)

    def edit_focused(self, thread_id, target, text, restore=True):
        self.page.append(("edit", thread_id, text))
        return Focus(ok=True)


def test_proven_edit_never_touches_the_page():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    assert d.edit_focused(TID, REF, "Bonjour à tous").ok
    assert page.calls == [("edit", TID, {"message": {"id": "1795777000001", "sender": "Ana Martin", "text": "Bonjour"},
                                         "text": "Bonjour à tous"})]
    assert page.page == [] and d.routes()["edit"]["via"] == "api"


def test_edit_not_attempted_falls_back_to_the_page():
    page = FakePage({"ok": False, "attempted": False, "error": "texte différent de celui affiché"})
    d = WebApiDriver(page)
    assert d.edit_focused(TID, REF, "Bonjour à tous").ok
    assert page.page == [("edit", TID, "Bonjour à tous")]
    assert d.routes()["edit"]["via"] == "page" and "texte différent" in d.routes()["edit"]["reason"]


def test_edit_refused_by_the_service_is_not_retried_on_the_page():
    # Message riche : la page ne ferait pas mieux, le refus est définitif.
    page = FakePage({"ok": False, "attempted": True, "refused": True, "error": "message avec citation"})
    d = WebApiDriver(page)
    focus = d.edit_focused(TID, REF, "Bonjour à tous")
    assert not focus.ok and "citation" in focus.reason and page.page == []


def test_edit_sent_without_proof_is_uncertain_and_never_redone():
    page = FakePage({"ok": False, "attempted": True, "uncertain": True, "error": "modification non confirmée"})
    d = WebApiDriver(page)
    with pytest.raises(EditUncertain):
        d.edit_focused(TID, REF, "Bonjour à tous")
    assert page.page == []
