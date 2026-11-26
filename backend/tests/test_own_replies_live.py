from __future__ import annotations

from models import IncomingMessage, Surface

DM_AUTO = "19:aa11@thread.v2"  # followed in auto mode in the sample config
DM = "19:bb22@thread.v2"


def _msg(thread_id: str, text: str = "Tu es dispo ?"):
    return IncomingMessage(thread_id=thread_id, sender="Sofia Marino", text=text, received_at="10:00",
                           surface=Surface.dm)


def test_auto_reply_updates_the_thread_and_shows_its_reflection(make_client):
    client, watcher, driver = make_client()
    watcher.cfg["reply"] = {**watcher.cfg.get("reply", {}), "auto_send_countdown_seconds": 0}
    before = watcher.state.thread_updates.get(DM_AUTO, 0)
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert driver.typed and driver.typed[-1][0] == DM_AUTO
    # The open discussion sees its own reply without waiting for the next message.
    assert watcher.state.thread_updates[DM_AUTO] == before + 1
    run = watcher.reflections.snapshot()[0]
    assert run["action"] == "reply" and run["title"] == "Réponse à un message reçu"
    assert run["status"] == "done" and run["threadId"] == DM_AUTO and run["result"]
    assert any("Message reçu de Sofia Marino" in s["text"] for s in run["steps"])


def test_draft_reply_shows_its_reflection_without_touching_the_thread(make_client):
    _client, watcher, driver = make_client()
    before = watcher.state.thread_updates.get(DM, 0)
    assert watcher._process(_msg(DM), force_draft=True) == "draft"
    assert driver.typed == [] and watcher.state.thread_updates.get(DM, 0) == before
    assert watcher.reflections.snapshot()[0]["action"] == "reply"


def test_received_and_manual_sends_update_the_thread(make_client):
    client, watcher, _driver = make_client()
    watcher._on_message(_msg(DM, "Coucou"))
    after_received = watcher.state.thread_updates[DM]
    assert client.post("/api/threads/19%3Abb22%40thread.v2/send", json={"text": "Salut"}).json() == {"ok": True}
    assert watcher.state.thread_updates[DM] == after_received + 1
    assert client.get("/api/state").json()["thread_updates"][DM] == after_received + 1
