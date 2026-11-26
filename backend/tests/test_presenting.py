from __future__ import annotations

SEND = "/api/threads/19%3Abb22%40thread.v2/send"


def _presenting(watcher, driver, on: bool):
    driver.my_presence = "presenting" if on else "available"
    watcher.apply_own_status()


def test_presenting_counts_as_screen_sharing(make_client):
    client, watcher, driver = make_client()
    assert watcher.state.capabilities.own_status
    _presenting(watcher, driver, True)
    assert watcher.state.my_presence == "presenting" and watcher.state.screen_sharing
    assert any("Présentation en cours" in l.text for l in watcher.state.logs)
    # Nothing is typed in Teams while presenting: the message waits in the outbox.
    r = client.post(SEND, json={"text": "Je te réponds après"}).json()
    assert r["queued"]["reason"].startswith("Partage d'écran") and driver.typed == []


def test_end_of_presentation_resumes(make_client):
    client, watcher, driver = make_client()
    watcher.outbox_auto = False
    _presenting(watcher, driver, True)
    client.post(SEND, json={"text": "Après la démo"})
    _presenting(watcher, driver, False)
    assert not watcher.state.screen_sharing
    assert any("Présentation terminée" in l.text for l in watcher.state.logs)
    watcher.flush_outbox()
    assert driver.typed[-1][1] == "Après la démo"


def test_guard_off_ignores_presenting(make_client):
    client, watcher, driver = make_client()
    watcher.cfg.setdefault("safety", {})["auto_pause_on_screen_share"] = False
    _presenting(watcher, driver, True)
    assert not watcher.state.screen_sharing
    assert client.post(SEND, json={"text": "Coucou"}).json() == {"ok": True}
