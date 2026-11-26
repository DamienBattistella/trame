"""Gestes du quotidien : réagir à un message, répondre à un message précis."""
from __future__ import annotations
import threading
import time

from conftest import FakeBrain, RefusingDriver
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver

DM = "19:aa11@thread.v2"
DM_URL = "/api/threads/19%3Aaa11%40thread.v2"
# Troisième message du fil de démo de Sofia (id m2 dans le pilote de démo).
TARGET = {"id": "m2", "sender": "Sofia Marino", "text": "Oui, le test du parseur OBX tombe en timeout sur le runner Windows."}


def test_messages_carry_id_and_reactions(make_client):
    client, _watcher, _driver = make_client()
    msgs = client.get(f"{DM_URL}/messages").json()["messages"]
    assert msgs[2]["id"] == "m2" and msgs[2]["reactions"] == []
    assert client.get("/api/state").json()["capabilities"] == {"react": True, "reply": True, "mentions": True}


def test_react_to_a_precise_message(make_client):
    client, watcher, driver = make_client()
    client.get(f"{DM_URL}/messages")
    r = client.post(f"{DM_URL}/react", json={"message": TARGET, "reaction": "like"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert driver.reactions == {f"{DM}/m2": ["like"]}
    # Le fil en cache montre la réaction sans relire Teams.
    msgs = client.get(f"{DM_URL}/messages").json()["messages"]
    assert msgs[2]["reactions"] == ["like"]
    assert any("Réaction 👍" in item.text and "Sofia Marino" in item.text for item in watcher.state.logs)


def test_react_twice_keeps_a_single_reaction(make_client):
    client, _watcher, driver = make_client()
    for _ in range(2):
        assert client.post(f"{DM_URL}/react", json={"message": TARGET, "reaction": "heart"}).status_code == 200
    assert driver.reactions[f"{DM}/m2"] == ["heart"]


def test_react_refuses_a_message_that_changed(make_client):
    client, _watcher, driver = make_client()
    other = {**TARGET, "text": "Un autre texte que celui affiché dans Teams."}
    r = client.post(f"{DM_URL}/react", json={"message": other, "reaction": "like"})
    assert r.status_code == 409 and r.json()["ok"] is False and "Aucune réaction" in r.json()["error"]
    assert driver.reactions == {}


def test_react_refuses_wrong_author(make_client):
    client, _watcher, driver = make_client()
    r = client.post(f"{DM_URL}/react", json={"message": {**TARGET, "sender": "Lucas Bernard"}, "reaction": "like"})
    assert r.status_code == 409 and driver.reactions == {}


def test_react_unknown_reaction_is_rejected(make_client):
    client, _watcher, driver = make_client()
    r = client.post(f"{DM_URL}/react", json={"message": TARGET, "reaction": "rocket"})
    assert r.status_code == 422 and driver.reactions == {}


def test_only_the_one_click_reactions_of_teams(make_client):
    # La barre de survol de Teams n'offre que 👍 ❤️ 😆 😮 ; le reste passe par un sélecteur.
    client, _watcher, driver = make_client()
    for reaction in ("sad", "angry"):
        assert client.post(f"{DM_URL}/react", json={"message": TARGET, "reaction": reaction}).status_code == 422
    assert driver.reactions == {}


def test_react_needs_the_conversation_confirmed(make_client):
    client, _watcher, driver = make_client(driver=RefusingDriver(interval=9999))
    r = client.post(f"{DM_URL}/react", json={"message": TARGET, "reaction": "like"})
    assert r.status_code == 409 and driver.reactions == {}


def test_react_blocked_during_screen_share(make_client):
    client, watcher, driver = make_client()
    driver.is_screen_sharing = lambda: True
    r = client.post(f"{DM_URL}/react", json={"message": TARGET, "reaction": "like"})
    assert r.status_code == 409 and "Partage d'écran" in r.json()["error"]
    assert driver.reactions == {} and watcher.state.screen_sharing is True


def test_reply_to_a_precise_message(make_client):
    client, watcher, driver = make_client()
    r = client.post(f"{DM_URL}/send", json={"text": "Je relance avec le cache.", "reply_to": TARGET})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert driver.replies == [(DM, TARGET["text"], "Je relance avec le cache.", True)]
    assert any("en réponse à « Sofia Marino" in item.text for item in watcher.state.logs)


def test_reply_to_a_vanished_message_sends_nothing(make_client):
    client, _watcher, driver = make_client()
    gone = {"sender": "Sofia Marino", "text": "Message qui n'est plus dans le fil."}
    r = client.post(f"{DM_URL}/send", json={"text": "Réponse", "reply_to": gone})
    assert r.status_code == 409 and "Rien n'a été envoyé" in r.json()["error"]
    assert driver.typed == [] and driver.replies == []


def test_draft_sent_as_a_reply(make_client):
    client, watcher, driver = make_client()
    from models import IncomingMessage, Surface
    watcher._process(IncomingMessage(thread_id=DM, sender="Sofia Marino", text="Le build passe ?", received_at="10:41",
                                     surface=Surface.dm), force_draft=True)
    d = next(x for x in watcher.state.drafts if x.thread_id == DM)
    r = client.post(f"/api/drafts/{d.id}/send", json={"text": "Oui, vert.", "reply_to": TARGET})
    assert r.status_code == 200
    assert driver.replies == [(DM, TARGET["text"], "Oui, vert.", True)]
    assert all(x.id != d.id for x in watcher.state.drafts)


def test_suggest_targets_the_chosen_message(make_client):
    brain = FakeBrain()
    client, _watcher, _driver = make_client(brain=brain)
    r = client.post(f"{DM_URL}/suggest", json={"message": TARGET})
    assert r.status_code == 200 and r.json()["text"] == "Réponse de test"
    assert brain.calls == [TARGET["text"]]
    # Sans cible : toujours le dernier message reçu.
    assert client.post(f"{DM_URL}/suggest").status_code == 200
    assert brain.calls[-1] == "Le build passe de ton côté ?"


def test_suggest_target_outside_the_read_window(make_client):
    brain = FakeBrain()
    client, _watcher, _driver = make_client(brain=brain)
    old = {"sender": "Sofia Marino", "text": "Un message ancien, plus dans les derniers lus."}
    assert client.post(f"{DM_URL}/suggest", json={"message": old}).status_code == 200
    assert brain.calls == [old["text"]]


class PlainDriver(MockTeamsDriver):
    supports_reactions = False
    supports_reply = False
    supports_mentions = False


def test_driver_without_gestures_refuses_cleanly(make_client):
    client, _watcher, driver = make_client(driver=PlainDriver(interval=9999))
    assert client.get("/api/state").json()["capabilities"] == {"react": False, "reply": False, "mentions": False}
    r = client.post(f"{DM_URL}/react", json={"message": TARGET, "reaction": "like"})
    assert r.status_code == 501
    r = client.post(f"{DM_URL}/send", json={"text": "x", "reply_to": TARGET})
    assert r.status_code == 501 and driver.typed == []


# --- Teams intégré : les commandes relayées à la page ---

class GesturePage:
    def __init__(self, client, react_result):
        self.client, self.stop, self.react_result = client, False, react_result
        self.title = "Chat | Autre | Microsoft Teams"
        self.commands: list[tuple[str, dict]] = []
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def answer(self, op, a):
        self.commands.append((op, a))
        if op == "ping":
            return {"title": self.title, "ready": True}
        if op == "list":
            return [{"label": "Chat Romain CUREAU Away Last message salut 25/11", "aria": "level=2", "id": "r1"}]
        if op == "title":
            return self.title
        if op == "open":
            self.title = f"Chat | {a['name']} | Microsoft Teams"
            return {"ok": True, "title": self.title}
        if op == "read":
            return {"messages": [{"sender": "Romain CUREAU", "text": "Tu as vu ?", "at": "10:00", "id": "1700",
                                  "reactions": ["like", "bogus"]}], "top": True}
        if op == "type":
            return {"ok": True}
        if op == "react":
            return self.react_result
        return None

    def loop(self):
        while not self.stop:
            cmd = self.client.get("/api/teams-web/poll").json()["command"]
            if cmd:
                self.client.post("/api/teams-web/reply", json={"id": cmd["id"], "ok": True,
                                                               "result": self.answer(cmd["op"], cmd["args"])})


def _bridge(make_client, monkeypatch, react_result):
    monkeypatch.setattr(WebBridgeDriver, "RPC_TIMEOUT", 3.0)
    monkeypatch.setattr(WebBridgeDriver, "POLL_WAIT", 0.5)
    driver = WebBridgeDriver()
    client, watcher, _ = make_client(driver=driver)
    page = GesturePage(client, react_result)
    driver._last_poll = time.monotonic()
    page.thread.start()
    watcher.state.watchlist = driver.list_conversations()
    return client, watcher, page


URL = "/api/threads/name%3ARomain%20CUREAU"
REF = {"id": "1700", "sender": "Romain CUREAU", "text": "Tu as vu ?"}


def test_bridge_relays_reply_and_reaction(make_client, monkeypatch):
    client, _watcher, page = _bridge(make_client, monkeypatch, {"ok": True})
    try:
        msgs = client.get(f"{URL}/messages").json()["messages"]
        assert msgs[0]["id"] == "1700" and msgs[0]["reactions"] == ["like"]
        assert client.post(f"{URL}/send", json={"text": "Oui", "reply_to": REF}).json() == {"ok": True}
        typed = [a for op, a in page.commands if op == "type"]
        assert typed[-1]["quote"] == REF and typed[-1]["send"] is True
        assert client.post(f"{URL}/react", json={"message": REF, "reaction": "laugh"}).json() == {"ok": True}
        reacted = [a for op, a in page.commands if op == "react"]
        assert reacted == [{"name": "Romain CUREAU", "message": REF, "reaction": "laugh"}]
    finally:
        page.stop = True
        page.thread.join(timeout=5)


def test_bridge_unconfirmed_reaction_is_never_reported_done(make_client, monkeypatch):
    client, watcher, page = _bridge(make_client, monkeypatch,
                                    {"ok": False, "uncertain": True, "error": "réaction non visible"})
    try:
        r = client.post(f"{URL}/react", json={"message": REF, "reaction": "like"})
        assert r.status_code == 409 and "non confirmée" in r.json()["error"]
        assert any("non confirmée" in item.text for item in watcher.state.logs)
    finally:
        page.stop = True
        page.thread.join(timeout=5)


def test_bridge_refused_reaction(make_client, monkeypatch):
    client, _watcher, page = _bridge(make_client, monkeypatch,
                                     {"ok": False, "error": "message introuvable ou différent de celui choisi"})
    try:
        r = client.post(f"{URL}/react", json={"message": REF, "reaction": "like"})
        assert r.status_code == 409 and "introuvable" in r.json()["error"]
    finally:
        page.stop = True
        page.thread.join(timeout=5)


def test_bridge_gives_time_to_scroll_up_to_an_older_message(monkeypatch):
    # Citer ou réagir à un message que Teams n'a pas encore dessiné : la page remonte le
    # fil jusqu'à lui (15 s au plus), le moteur doit l'attendre au-delà.
    from models import MessageRef
    d = WebBridgeDriver()
    d._names["name:Romain CUREAU"] = "Romain CUREAU"
    calls = []

    def fake_rpc(op, timeout=None, **args):
        calls.append((op, timeout, args))
        return {"ok": True}

    monkeypatch.setattr(d, "_rpc", fake_rpc)
    ref = MessageRef(id="1700", sender="Romain CUREAU", text="Tu as vu ?")
    assert d._react_in_active("name:Romain CUREAU", ref, "like") is True
    assert d._reply_in_active("name:Romain CUREAU", ref, "Oui", True) is True
    assert d._type_into_active("name:Romain CUREAU", "Oui", True) is True
    (_, react_t, _), (_, quote_t, quote_args), (_, plain_t, plain_args) = calls
    assert react_t >= 20 and quote_t > react_t and quote_args["quote"]["id"] == "1700"
    assert plain_t == 15 and "quote" not in plain_args
