"""Démarrage : le moteur suit lui-même la disponibilité de Teams (sans attendre l'interface), et
l'expose capacité par capacité pour que l'interface dise « Teams se connecte… » sans erreur."""
from __future__ import annotations

import threading
import time

from drivers.mock import MockTeamsDriver
from drivers.web_api import WebApiDriver


class Waiting(MockTeamsDriver):
    """Un pilote de page Teams qui devient prêt au 3e coup d'œil."""

    waits_for_relay = True

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.pings = 0

    def status(self):
        self.pings += 1
        return {"relay": True, "ready": self.pings >= 3}

    def chat_ready(self):
        return self.pings >= 3


def test_engine_detects_teams_ready_itself_within_seconds(make_client):
    client, watcher, driver = make_client(driver=Waiting(interval=9999))
    watcher.READY_POLL_WAITING = 0.01
    watcher.READY_POLL_READY = 60
    watcher.state.selftest_ok = False
    t = threading.Thread(target=watcher._readiness_loop, daemon=True)
    t.start()
    deadline = time.time() + 3
    while time.time() < deadline and watcher.state.readiness.page != "ready":
        time.sleep(0.01)
    assert watcher.state.selftest_ok is True
    state = client.get("/api/state").json()
    assert state["readiness"]["page"] == "ready" and state["readiness"]["chat"] == "ready"
    watcher._stop.set()


def test_readiness_is_waiting_while_teams_loads(make_client):
    _client, watcher, driver = make_client(driver=Waiting(interval=9999))
    watcher._set_readiness("waiting")
    assert watcher.state.readiness.page == "waiting" and watcher.state.readiness.since


def test_driver_without_page_is_ready_at_once(make_client):
    _client, watcher, _ = make_client()
    watcher._readiness_loop()  # pilote sans page à attendre : retourne aussitôt
    assert watcher.state.readiness.page == "ready" and watcher.state.readiness.chat == "off"


def test_api_card_reads_the_page_diagnosis_once_and_caches_it():
    calls = []

    class Page:
        def diagnose(self, thread_id=None):
            calls.append(1)
            return {"diagnose": {"sign_selftest": {"ok": True, "status": 200}, "chatsvc_selftest": {"ok": True, "stage": "ok"}}}

    d = WebApiDriver(Page())
    assert d.health() == {"signing": {"ok": True, "status": 200}, "chatsvc": {"ok": True, "stage": "ok"}}
    d.health()
    assert len(calls) == 1
