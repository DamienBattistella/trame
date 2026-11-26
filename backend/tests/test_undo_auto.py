from __future__ import annotations

from drivers.base import DeleteUncertain, Focus
from drivers.mock import MockTeamsDriver
from models import IncomingMessage, Surface

DM_AUTO = "19:aa11@thread.v2"  # followed in auto mode in the sample config


def _msg(text: str = "Tu es dispo ?"):
    return IncomingMessage(thread_id=DM_AUTO, sender="Sofia Marino", text=text, received_at="10:00", surface=Surface.dm)


def _auto(make_client, driver=None):
    client, watcher, d = make_client(driver=driver) if driver else make_client()
    watcher.cfg["reply"] = {**watcher.cfg.get("reply", {}), "auto_send_countdown_seconds": 0}
    assert watcher._process(_msg()) == "sent"
    return client, watcher, d


class RecordingDelete(MockTeamsDriver):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.deleted = []

    def delete_focused(self, thread_id, target, restore=True):
        self.deleted.append((thread_id, target.sender, target.text))
        return Focus(ok=True)


def test_auto_reply_is_undoable_for_a_while(make_client):
    _client, watcher, driver = _auto(make_client)
    [item] = watcher.state.undoable
    sent = driver.typed[-1][1]
    assert item.thread_id == DM_AUTO and item.text == sent
    assert item.expires_at_ms > 0


def test_undo_deletes_the_reply_in_teams(make_client):
    client, watcher, driver = _auto(make_client, RecordingDelete(interval=9999))
    item = watcher.state.undoable[0]
    before = watcher.state.thread_updates.get(DM_AUTO, 0)
    assert client.post(f"/api/undo/{item.id}").json() == {"ok": True}
    # Found by its text, never by a guessed sender; Teams then checks it is the user's own.
    assert driver.deleted == [(DM_AUTO, "", item.text)]
    assert watcher.state.undoable == [] and watcher.state.thread_updates[DM_AUTO] == before + 1
    assert any("Réponse automatique retirée" in l.text for l in watcher.state.logs)


def test_too_late_or_unknown_is_refused(make_client):
    client, watcher, driver = _auto(make_client, RecordingDelete(interval=9999))
    item = watcher.state.undoable[0]
    watcher.state.undoable = [item.model_copy(update={"expires_at_ms": 1})]
    assert client.post(f"/api/undo/{item.id}").status_code == 410
    assert client.post("/api/undo/inconnu").status_code == 410
    assert driver.deleted == []


def test_uncertain_undo_says_so_and_stops_offering(make_client):
    class Uncertain(MockTeamsDriver):
        def delete_focused(self, thread_id, target, restore=True):
            raise DeleteUncertain("pas de réponse à « delete »")

    client, watcher, _ = _auto(make_client, Uncertain(interval=9999))
    item = watcher.state.undoable[0]
    r = client.post(f"/api/undo/{item.id}")
    assert r.status_code == 409 and "vérifie dans Teams" in r.json()["error"]
    assert watcher.state.undoable == []


def test_manual_sends_are_not_offered(make_client):
    client, watcher, _ = make_client()
    client.post("/api/threads/19%3Abb22%40thread.v2/send", json={"text": "Salut"})
    assert watcher.state.undoable == []
