from __future__ import annotations

from drivers.web_bridge import WebBridgeDriver

URL = "/api/me/status"
LABELS = ["Votre profil, statut Ne pas déranger"]


def test_status_with_duration_reaches_the_driver(make_client):
    client, watcher, driver = make_client()
    r = client.post(URL, json={"presence": "dnd", "duration": "1h"}).json()
    assert r == {"ok": True, "presence": "dnd", "duration": "1h"}
    assert driver.my_presence == "dnd" and driver.my_duration == "1h"
    assert any("pour 1 heure" in l.text for l in watcher.state.logs)


def test_without_duration_nothing_changes(make_client):
    client, _watcher, driver = make_client()
    assert client.post(URL, json={"presence": "busy"}).json() == {"ok": True, "presence": "busy"}
    assert driver.my_duration is None


def test_duration_is_refused_for_reset_and_unknown_values(make_client):
    client, _watcher, driver = make_client()
    assert client.post(URL, json={"presence": "reset", "duration": "1h"}).status_code == 422
    assert client.post(URL, json={"presence": "dnd", "duration": "3 jours"}).status_code == 422
    assert driver.my_duration is None


def test_bridge_uses_the_duration_panel_only_with_a_duration(monkeypatch):
    driver = WebBridgeDriver()
    calls = []

    def rpc(op, timeout=None, **args):
        calls.append((op, args))
        return {"ok": True, "labels": LABELS}

    monkeypatch.setattr(driver, "_rpc", rpc)
    assert driver.set_my_status("dnd", "today") == "dnd"
    assert driver.set_my_status("dnd") == "dnd"
    assert calls == [("setstatusfor", {"choice": "dnd", "duration": "today"}), ("setstatus", {"choice": "dnd"})]
