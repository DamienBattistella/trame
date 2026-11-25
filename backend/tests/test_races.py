from __future__ import annotations
import threading

from conftest import FakeBrain
from drivers.mock import MockTeamsDriver
from models import IncomingMessage, Surface

DM_AUTO = "19:aa11@thread.v2"
DM_DRAFT = "19:bb22@thread.v2"


def _msg(thread_id: str, text: str = "Tu es dispo ?", sender: str = "Quelqu'un"):
    return IncomingMessage(thread_id=thread_id, sender=sender, text=text, received_at="10:00", surface=Surface.dm)


class LateShareDriver(MockTeamsDriver):
    """Screen share starts after the first check (during the LLM call / countdown)."""

    def __init__(self):
        super().__init__(interval=9999)
        self.calls = 0

    def is_screen_sharing(self) -> bool:
        self.calls += 1
        return self.calls > 1


def test_screen_share_started_mid_pipeline_blocks_auto_send(make_client):
    driver = LateShareDriver()
    _client, watcher, _ = make_client(driver=driver)
    watcher.cfg["reply"] = {**watcher.cfg.get("reply", {}), "auto_send_countdown_seconds": 0}
    assert watcher._process(_msg(DM_AUTO)) == "draft"
    assert driver.typed == []


def test_pause_after_countdown_cancels_auto_send(make_client):
    _client, watcher, driver = make_client()
    watcher.cfg["reply"] = {**watcher.cfg.get("reply", {}), "auto_send_countdown_seconds": 0}
    real = watcher._countdown_ok

    def countdown_then_pause(secs):
        ok = real(secs)
        watcher.state.paused = True
        return ok

    watcher._countdown_ok = countdown_then_pause
    assert watcher._process(_msg(DM_AUTO)) == "draft"
    assert driver.typed == []


def test_double_send_delivers_once(make_client):
    client, watcher, driver = make_client()
    watcher._process(_msg(DM_DRAFT))
    draft_id = next(d.id for d in watcher.state.drafts if d.thread_id == DM_DRAFT)
    gate = threading.Event()
    real = driver._type_into_active

    def slow(thread_id, text, send):
        gate.wait(2)
        return real(thread_id, text, send)

    driver._type_into_active = slow
    results = []
    t = threading.Thread(target=lambda: results.append(client.post(f"/api/drafts/{draft_id}/send").status_code))
    t.start()
    while draft_id not in watcher._in_flight:
        pass
    second = client.post(f"/api/drafts/{draft_id}/send")
    gate.set()
    t.join()
    assert second.status_code == 409 and results == [200]
    assert [x for x in driver.typed if x[2]] == [(DM_DRAFT, "Réponse de test", True)]


def test_own_messages_and_echoes_never_trigger_a_reply(make_client):
    _client, watcher, driver = make_client()
    watcher.cfg["reply"] = {**watcher.cfg.get("reply", {}), "auto_send_countdown_seconds": 0}
    self_name = watcher.cfg.get("triggers", {}).get("self_names", ["Damien"])[0]
    assert watcher._process(_msg(DM_AUTO, sender=self_name.upper())) is None
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert watcher._process(_msg(DM_AUTO, text="Réponse de test", sender="")) is None
    assert len(driver.typed) == 1


def test_new_message_updates_draft_in_place(make_client):
    _client, watcher, _driver = make_client()
    watcher._process(_msg(DM_DRAFT, "Premier"))
    first = next(d for d in watcher.state.drafts if d.thread_id == DM_DRAFT)
    watcher._process(_msg(DM_DRAFT, "Second"))
    same = [d for d in watcher.state.drafts if d.thread_id == DM_DRAFT]
    assert len(same) == 1 and same[0].id == first.id and same[0].incoming == "Second"
