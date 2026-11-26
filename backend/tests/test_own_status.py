from __future__ import annotations

import pytest

import presence
from drivers.base import TeamsDriver
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import BridgeUnavailable, WebBridgeDriver


# --- what Teams' profile button says ---
@pytest.mark.parametrize("labels, expected", [
    (["Votre profil, statut Ne pas déranger ", "do not disturb"], "dnd"),
    (["Your profile, status Available", "available"], "available"),
    (["Votre profil, statut Occupé(e)"], "busy"),
    (["Votre profil, statut De retour bientôt"], "brb"),
    (["Votre profil, statut Absent du bureau", "away"], "ooo"),
    (["Votre profil", "appear offline"], "offline"),
    (["Votre profil, statut Inconnu"], None),
    ([], None),
])
def test_own_status_read_from_profile_button(labels, expected):
    assert presence.own_from_labels(labels) == expected


# --- web bridge: what the page answers ---
def _bridge(monkeypatch, answers):
    driver = WebBridgeDriver()
    calls = []

    def rpc(op, timeout=None, **args):
        calls.append((op, args))
        return answers.pop(0)

    monkeypatch.setattr(driver, "_rpc", rpc)
    return driver, calls


def test_bridge_reads_status_and_message(monkeypatch):
    driver, calls = _bridge(monkeypatch, [
        {"ok": True, "labels": ["Votre profil, statut Disponible"]},
        {"ok": True, "labels": ["do not disturb"], "message": "  En  congés  "},
    ])
    assert driver.my_status() == {"presence": "available"}
    assert driver.my_status(with_message=True) == {"presence": "dnd", "message": "En congés"}
    assert calls == [("mystatus", {"message": False}), ("mystatus", {"message": True})]


def test_bridge_set_status_returns_what_teams_shows(monkeypatch):
    driver, calls = _bridge(monkeypatch, [{"ok": True, "labels": ["Votre profil, statut Occupé(e)", "busy"]}])
    assert driver.set_my_status("busy") == "busy"
    assert calls == [("setstatus", {"choice": "busy"})]


def test_bridge_set_status_refusal_is_raised(monkeypatch):
    driver, _ = _bridge(monkeypatch, [{"ok": False, "error": "menu du profil non ouvert"}])
    with pytest.raises(BridgeUnavailable, match="menu du profil"):
        driver.set_my_status("dnd")


def test_bridge_rejects_unknown_choice_without_asking_teams(monkeypatch):
    driver, calls = _bridge(monkeypatch, [])
    with pytest.raises(ValueError):
        driver.set_my_status("in_meeting")
    assert calls == []


def test_bridge_status_message_is_normalised(monkeypatch):
    driver, calls = _bridge(monkeypatch, [{"ok": True, "message": "Au  bureau"}])
    assert driver.set_status_message("  Au\nbureau ") == "Au bureau"
    assert calls == [("setnote", {"text": "Au bureau"})]


def test_base_driver_refuses_clearly():
    class Bare(MockTeamsDriver):
        can_set_status = False
        my_status = TeamsDriver.my_status
        set_my_status = TeamsDriver.set_my_status
        set_status_message = TeamsDriver.set_status_message

    d = Bare(interval=9999)
    for call in (d.my_status, lambda: d.set_my_status("dnd"), lambda: d.set_status_message("x")):
        with pytest.raises(Exception, match="statut"):
            call()


# --- API ---
def test_set_status_through_api(make_client):
    client, watcher, driver = make_client()
    assert watcher.state.capabilities.own_status
    r = client.post("/api/me/status", json={"presence": "dnd"})
    assert r.json() == {"ok": True, "presence": "dnd"}
    assert driver.my_presence == "dnd" and watcher.state.my_presence == "dnd"
    assert client.post("/api/me/status", json={"presence": "reset"}).json() == {"ok": True, "presence": "available"}


def test_status_and_message_read_through_api(make_client):
    client, _watcher, driver = make_client()
    driver.my_presence, driver.my_message = "away", "En déplacement"
    assert client.get("/api/me/status").json() == {"ok": True, "presence": "away", "message": "En déplacement"}


def test_unknown_status_is_refused(make_client):
    client, _watcher, driver = make_client()
    assert client.post("/api/me/status", json={"presence": "in_meeting"}).status_code == 422
    assert driver.my_presence == "available"


class StubbornDriver(MockTeamsDriver):
    """Teams keeps showing Do not disturb (notifications paused): the click had no effect."""

    def set_my_status(self, choice):
        return "dnd"


def test_never_a_false_success(make_client):
    client, watcher, _driver = make_client(driver=StubbornDriver(interval=9999))
    r = client.post("/api/me/status", json={"presence": "available"})
    assert r.status_code == 409 and "Ne pas déranger" in r.json()["error"]
    assert watcher.state.my_presence == "dnd"
    assert any("Disponible" in l.text for l in watcher.state.logs if l.level == "warn")


class BrokenMenuDriver(MockTeamsDriver):
    def set_my_status(self, choice):
        raise RuntimeError("entrée « Modifier l'état » introuvable")


def test_menu_failure_is_reported(make_client):
    client, _watcher, _driver = make_client(driver=BrokenMenuDriver(interval=9999))
    r = client.post("/api/me/status", json={"presence": "busy"})
    assert r.status_code == 502 and "Modifier l'état" in r.json()["error"]


def test_status_message_through_api(make_client):
    client, _watcher, driver = make_client()
    assert client.post("/api/me/status-message", json={"text": " En  réunion jusqu'à 15 h "}).json() == {
        "ok": True, "message": "En réunion jusqu'à 15 h"}
    assert client.post("/api/me/status-message", json={"text": ""}).json() == {"ok": True, "message": ""}
    assert driver.my_message == ""


def test_status_message_too_long_is_refused(make_client):
    client, _watcher, driver = make_client()
    r = client.post("/api/me/status-message", json={"text": "x" * 300})
    assert r.status_code == 422 and driver.my_message == ""


class LossyMessageDriver(MockTeamsDriver):
    def set_status_message(self, text):
        return text[:10]


def test_status_message_checked_against_teams(make_client):
    client, _watcher, _driver = make_client(driver=LossyMessageDriver(interval=9999))
    assert client.post("/api/me/status-message", json={"text": "Un message assez long"}).status_code == 409


def test_unsupported_driver_answers_501(make_client):
    class Bare(MockTeamsDriver):
        can_set_status = False

    client, watcher, _driver = make_client(driver=Bare(interval=9999))
    assert not watcher.state.capabilities.own_status
    assert client.post("/api/me/status", json={"presence": "dnd"}).status_code == 501
    assert client.get("/api/me/status").status_code == 501


def test_presence_loop_copies_own_status(make_client):
    _client, watcher, driver = make_client()
    driver.my_presence = "brb"
    watcher.apply_presence()
    assert watcher.state.my_presence == "brb"
