"""« En train d'écrire » et « Vu » : lus dans la liste que Trame interroge déjà."""
from __future__ import annotations

import drivers.base as basemod
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver

ROMAIN = "19:r1@unq.gbl.spaces"
HUGO = "19:h2@unq.gbl.spaces"
FHIR = "19:p3@thread.v2"


def _items(romain_typing=False, open_hugo=None):
    hugo = {"label": "Hugo Lannes 24/11 Vous : merci", "id": HUGO}
    if open_hugo is not None:
        hugo.update(open_hugo)
    return [
        {"label": "Romain CUREAU 25/11 je vais préparer ça", "id": ROMAIN, "typing": romain_typing},
        hugo,
        {"label": "Projet FHIR 10:02 Lucas: ok", "id": FHIR, "typing": True},
    ]


def _driver(monkeypatch, items, now):
    monkeypatch.setattr(basemod.time, "monotonic", lambda: now[0])
    d = WebBridgeDriver()
    monkeypatch.setattr(d, "_rpc", lambda op, timeout=None, **a: items())
    return d


def test_typing_comes_from_the_chat_list_and_fades(monkeypatch):
    now = [1000.0]
    state = {"romain": True}
    d = _driver(monkeypatch, lambda: _items(romain_typing=state["romain"]), now)
    d.list_conversations()
    assert d.activity(ROMAIN) == {"typing": True, "typing_text": None, "seen": None}
    assert d.activity(FHIR)["typing"] is True
    assert d.activity(HUGO)["typing"] is False
    # Teams retire les points : plus d'indicateur au relevé suivant.
    state["romain"] = False
    d.list_conversations()
    assert d.activity(ROMAIN)["typing"] is False
    # Plus de relevé (fenêtre Teams fermée) : l'indicateur ne reste pas affiché.
    now[0] += d.TYPING_TTL + 1
    assert d.activity(FHIR)["typing"] is False


def test_open_conversation_gives_who_types_and_the_read_receipt(monkeypatch):
    now = [1000.0]
    open_hugo = {"open": True, "typing_text": "Hugo Lannes est en train d’écrire", "status": "seen"}
    state = {"open": open_hugo}
    d = _driver(monkeypatch, lambda: _items(open_hugo=state["open"]), now)
    d.list_conversations()
    assert d.activity(HUGO) == {"typing": True, "typing_text": "Hugo Lannes est en train d’écrire", "seen": True}
    # Teams ouvre une autre conversation : le « Vu » de Hugo n'est plus suivi.
    state["open"] = None
    items = _items()
    items[0].update(open=True, status="sent", typing_text="")
    monkeypatch.setattr(d, "_rpc", lambda op, timeout=None, **a: items)
    d.list_conversations()
    assert d.activity(HUGO)["seen"] is None
    assert d.activity(ROMAIN) == {"typing": False, "typing_text": None, "seen": False}


def test_read_receipt_of_each_message_from_the_thread(monkeypatch):
    d = WebBridgeDriver()
    monkeypatch.setattr(d, "_rpc", lambda op, timeout=None, **a: {"top": True, "messages": [
        {"sender": "Hugo", "text": "c'est bien ça"},
        {"sender": "Damien", "text": "Merci", "status": "seen"},
        {"sender": "Damien", "text": "Et demain ?", "status": "sent"},
        {"sender": "Damien", "text": "?", "status": "bizarre"},
    ]})
    msgs, _ = d.read_history(HUGO, 30)
    assert [m.seen for m in msgs] == [None, True, False, None]


def test_api_relays_activity_and_seen(make_client, monkeypatch):
    driver = MockTeamsDriver(interval=9999)
    client, watcher, _ = make_client(driver=driver)
    tid = watcher.state.watchlist[0].thread_id
    assert client.get(f"/api/threads/{tid}/activity").json() == {
        "ok": True, "typing": False, "typing_text": None, "seen": None}
    driver._note_activity(tid, typing=True, typing_text="Ana est en train d’écrire", seen=True)
    body = client.get(f"/api/threads/{tid}/activity").json()
    assert body["typing"] and body["typing_text"] == "Ana est en train d’écrire" and body["seen"] is True
    messages = client.get(f"/api/threads/{tid}/messages").json()["messages"]
    assert all("seen" in m for m in messages)
