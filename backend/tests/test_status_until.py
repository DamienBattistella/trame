"""« Personnalisé » : un statut jusqu'à une date et une heure locales."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

import presence as presencemod
from drivers.web_bridge import WebBridgeDriver

URL = "/api/me/status"
LABELS = ["Votre profil, statut Ne pas déranger"]
NOW = datetime(2026, 11, 26, 16, 50)


def _soon(days: int = 1, hour: int = 14, minute: int = 30) -> datetime:
    """A valid end, relative to the real clock (the route reads it)."""
    return (datetime.now() + timedelta(days=days)).replace(hour=hour, minute=minute, second=0, microsecond=0)


def test_parse_until_accepts_a_half_hour_in_the_future():
    assert presencemod.parse_until("2026-11-26T18:30", NOW) == datetime(2026, 11, 26, 18, 30)
    assert presencemod.parse_until(" 2026-12-26T09:00 ", NOW) == datetime(2026, 12, 26, 9, 0)


@pytest.mark.parametrize("value, why", [
    ("", "illisible"),
    ("demain", "illisible"),
    ("2026-11-26 18:30", "illisible"),
    ("2026-11-31T10:00", "illisible"),
    ("2026-11-26T18:15", "demi-heures"),
    ("2026-11-26T16:30", "déjà passée"),
    ("2026-11-26T16:50", "demi-heures"),
    ("2026-12-27T09:00", "30 jours"),
])
def test_parse_until_refusals(value, why):
    with pytest.raises(ValueError, match=why):
        presencemod.parse_until(value, NOW)


def test_until_label_reads_naturally():
    assert presencemod.until_label(datetime(2026, 11, 26, 14, 30), NOW) == "14 h 30"
    assert presencemod.until_label(datetime(2026, 11, 27, 9, 0), NOW) == "demain 9 h"
    assert presencemod.until_label(datetime(2026, 12, 3, 14, 30), NOW) == "jeudi 3 décembre 14 h 30"


def test_status_until_reaches_the_driver(make_client):
    client, watcher, driver = make_client()
    end = _soon()
    r = client.post(URL, json={"presence": "dnd", "until": f"{end:%Y-%m-%dT%H:%M}"}).json()
    assert r == {"ok": True, "presence": "dnd", "until": f"{end:%Y-%m-%dT%H:%M}"}
    assert driver.my_presence == "dnd" and driver.my_until == end and driver.my_duration is None
    assert any("jusqu'à demain 14 h 30" in l.text for l in watcher.state.logs)


def test_status_until_refusals_leave_teams_alone(make_client):
    client, _watcher, driver = make_client()
    end = f"{_soon():%Y-%m-%dT%H:%M}"
    past = f"{datetime.now() - timedelta(days=1):%Y-%m-%dT%H:00}"
    far = f"{_soon(days=40):%Y-%m-%dT%H:%M}"
    for body in ({"presence": "reset", "until": end},
                 {"presence": "dnd", "duration": "1h", "until": end},
                 {"presence": "dnd", "until": past},
                 {"presence": "dnd", "until": far},
                 {"presence": "dnd", "until": "x" * 40}):
        assert client.post(URL, json=body).status_code == 422, body
    assert driver.my_until is None and driver.my_presence != "dnd"


def test_bridge_sends_date_and_local_time(monkeypatch):
    driver = WebBridgeDriver()
    calls = []

    def rpc(op, timeout=None, **args):
        calls.append((op, args))
        return {"ok": True, "labels": LABELS}

    monkeypatch.setattr(driver, "_rpc", rpc)
    assert driver.set_my_status("dnd", until=datetime(2026, 12, 3, 9, 0)) == "dnd"
    assert calls == [("setstatusfor", {"choice": "dnd", "duration": "custom", "date": "2026-12-03", "time": "09:00"})]
    with pytest.raises(ValueError):
        driver.set_my_status("reset", until=datetime(2026, 12, 3, 9, 0))


def test_bridge_failure_is_reported(make_client, monkeypatch):
    client, _watcher, driver = make_client()

    def refuse(*_a, **_k):
        raise RuntimeError("Teams intégré : jour refusé par Teams")

    monkeypatch.setattr(driver, "set_my_status", refuse)
    r = client.post(URL, json={"presence": "dnd", "until": f"{_soon():%Y-%m-%dT%H:%M}"})
    assert r.status_code == 502 and "jour refusé" in r.text
