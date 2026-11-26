from __future__ import annotations

from drivers.base import SendUncertain
from drivers.mock import MockTeamsDriver
from models import IncomingMessage, Surface

DM = "19:bb22@thread.v2"
SEND = "/api/threads/19%3Abb22%40thread.v2/send"


def _client(make_client, driver):
    client, watcher, d = make_client(driver=driver)
    watcher.outbox_auto = False  # the test drives the outbox itself
    return client, watcher, d


class RelayDriver(MockTeamsDriver):
    """Teams intégré whose relay can be down (the Teams window of Trame reconnecting)."""

    relay = False

    def relay_connected(self) -> bool:
        return self.relay


class FlakyDriver(MockTeamsDriver):
    """Opening the conversation fails the way the bridge does when its page is gone."""

    failures: list[str] = []

    def open_thread(self, thread_id: str) -> bool:
        if self.failures:
            raise RuntimeError(self.failures.pop(0))
        return super().open_thread(thread_id)


class UncertainDriver(MockTeamsDriver):
    def _type_into_active(self, thread_id, text, send):
        raise SendUncertain("pas de réponse à « type »")


def test_relay_down_queues_then_sends_once_when_back(make_client):
    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    r = client.post(SEND, json={"text": "Je regarde ça"}).json()
    assert r["ok"] and r["queued"]["status"] == "waiting" and "pas prêt" in r["queued"]["reason"]
    assert driver.typed == [] and len(watcher.state.outbox) == 1
    watcher.flush_outbox()  # still down: nothing typed
    assert driver.typed == []
    driver.relay = True
    watcher.flush_outbox()
    watcher.flush_outbox()  # never twice
    assert driver.typed == [(DM, "Je regarde ça", True)] and watcher.state.outbox == []
    assert any("depuis la file d'envoi" in l.text for l in watcher.state.logs)


def test_page_gone_during_send_is_queued_but_other_refusals_are_not(make_client):
    client, watcher, driver = _client(make_client, FlakyDriver(interval=9999))
    driver.failures = ["Teams intégré : la fenêtre Teams de Trame n'est pas prête."]
    r = client.post(SEND, json={"text": "Coucou"}).json()
    assert r["queued"]["text"] == "Coucou" and driver.typed == []
    client.post(f"/api/outbox/{r['queued']['id']}/cancel")
    driver.failures = ["Teams intégré : « Lucas » absente de la liste"]
    r = client.post(SEND, json={"text": "Autre"})
    assert r.status_code == 409 and watcher.state.outbox == []


def test_uncertain_send_is_never_retried_by_itself(make_client):
    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    client.post(SEND, json={"text": "Coucou"})
    driver.relay = True
    driver.__class__ = type("Both", (RelayDriver, UncertainDriver), {})
    watcher.flush_outbox()
    item = watcher.state.outbox[0]
    assert item.status == "uncertain" and "peut-être" in item.reason
    watcher.flush_outbox()
    assert watcher.state.outbox[0].attempts == 1


def test_messages_keep_their_order(make_client):
    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    client.post(SEND, json={"text": "Premier"})
    client.post(SEND, json={"text": "Second"})
    driver.relay = True
    real_open = driver.open_thread
    driver.open_thread = lambda tid: (_ for _ in ()).throw(RuntimeError("« Lucas » absente de la liste"))
    watcher.flush_outbox()
    assert [x.status for x in watcher.state.outbox] == ["failed", "waiting"] and driver.typed == []
    driver.open_thread = real_open
    watcher.flush_outbox()  # the first is stuck: the second waits behind it
    assert driver.typed == []
    first = watcher.state.outbox[0].id
    assert client.post(f"/api/outbox/{first}/retry").json() == {"ok": True}
    watcher.flush_outbox()
    assert [t[1] for t in driver.typed] == ["Premier", "Second"] and watcher.state.outbox == []


def test_cancel_removes_and_unknown_is_404(make_client):
    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    item = client.post(SEND, json={"text": "Coucou"}).json()["queued"]
    assert client.post(f"/api/outbox/{item['id']}/cancel").json() == {"ok": True}
    assert watcher.state.outbox == []
    assert client.post(f"/api/outbox/{item['id']}/cancel").status_code == 404
    driver.relay = True
    watcher.flush_outbox()
    assert driver.typed == []


def test_draft_sent_while_not_ready_leaves_drafts_for_the_outbox(make_client):
    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    watcher._process(IncomingMessage(thread_id=DM, sender="Lucas Bernard", text="Tu as vu ?", received_at="10:00",
                                     surface=Surface.dm), force_draft=True)
    draft = next(d for d in watcher.state.drafts if d.thread_id == DM)
    r = client.post(f"/api/drafts/{draft.id}/send", json={"text": "Oui, je regarde"}).json()
    assert r["queued"]["text"] == "Oui, je regarde" and all(d.id != draft.id for d in watcher.state.drafts)
    driver.relay = True
    watcher.flush_outbox()
    assert driver.typed[-1] == (DM, "Oui, je regarde", True)


def test_too_old_is_not_sent_by_itself(make_client, monkeypatch):
    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    item = client.post(SEND, json={"text": "Vieux"}).json()["queued"]
    watcher._outbox_payload[item["id"]]["since"] -= watcher.OUTBOX_MAX_AGE + 1
    driver.relay = True
    watcher.flush_outbox()
    assert driver.typed == [] and watcher.state.outbox[0].status == "failed"

def test_simultaneous_passes_send_only_once(make_client):
    import threading

    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    client.post(SEND, json={"text": "Une seule fois"})
    driver.relay = True
    slow = driver._type_into_active

    def typing(thread_id, text, send):
        import time
        time.sleep(0.05)
        return slow(thread_id, text, send)

    driver._type_into_active = typing
    passes = [threading.Thread(target=watcher.flush_outbox) for _ in range(5)]
    for p in passes:
        p.start()
    for p in passes:
        p.join()
    watcher.flush_outbox()
    assert [t[1] for t in driver.typed] == ["Une seule fois"] and watcher.state.outbox == []

def test_new_message_goes_behind_one_still_waiting(make_client):
    client, watcher, driver = _client(make_client, RelayDriver(interval=9999))
    client.post(SEND, json={"text": "Avant"})
    driver.relay = True  # Teams is back, but « Avant » has not left yet
    r = client.post(SEND, json={"text": "Après"}).json()
    assert r["queued"]["reason"].startswith("un message précédent") and driver.typed == []
    watcher.flush_outbox()
    assert [t[1] for t in driver.typed] == ["Avant", "Après"]
