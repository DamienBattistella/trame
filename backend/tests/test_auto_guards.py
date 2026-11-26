from __future__ import annotations

from datetime import datetime

from models import IncomingMessage, Surface

DM_AUTO = "19:aa11@thread.v2"  # followed in auto mode in the sample config


def _msg(text: str = "Tu es dispo ?"):
    return IncomingMessage(thread_id=DM_AUTO, sender="Sofia Marino", text=text, received_at="10:00", surface=Surface.dm)


def _watcher(make_client, **safety):
    client, watcher, driver = make_client()
    watcher.cfg["reply"] = {**watcher.cfg.get("reply", {}), "auto_send_countdown_seconds": 0}
    watcher.cfg["safety"] = {**watcher.cfg.get("safety", {}), **safety}
    return client, watcher, driver


def test_cap_per_hour_keeps_the_next_replies_as_drafts(make_client):
    _client, watcher, driver = _watcher(make_client, auto_max_per_hour=2)
    assert watcher._process(_msg("un ?")) == "sent"
    assert watcher._process(_msg("deux ?")) == "sent"
    assert watcher._process(_msg("trois ?")) == "draft"
    assert len(driver.typed) == 2
    assert any("plafond atteint (2 réponses" in l.text for l in watcher.state.logs)
    assert any(d.thread_id == DM_AUTO for d in watcher.state.drafts)


def test_zero_means_no_cap(make_client):
    _client, watcher, driver = _watcher(make_client, auto_max_per_hour=0)
    for i in range(7):
        assert watcher._process(_msg(f"question {i} ?")) == "sent"


def test_quiet_hours_and_weekends(make_client):
    _client, watcher, _ = _watcher(make_client, auto_quiet_hours=True, auto_quiet_from="19:00", auto_quiet_to="08:00",
                                   auto_weekends=False)
    thursday = datetime(2026, 11, 26)
    assert watcher._auto_guard(DM_AUTO, thursday.replace(hour=22)).startswith("heures de silence")
    assert watcher._auto_guard(DM_AUTO, thursday.replace(hour=7, minute=59)).startswith("heures de silence")
    assert watcher._auto_guard(DM_AUTO, thursday.replace(hour=8)) is None
    assert watcher._auto_guard(DM_AUTO, datetime(2026, 11, 28, 12)) == "pas d'envoi automatique le week-end"


def test_today_recap_lists_what_left_alone(make_client):
    client, watcher, driver = _watcher(make_client)
    watcher._process(_msg())
    [sent] = watcher.state.auto_today
    assert sent.thread_id == DM_AUTO and sent.text == driver.typed[-1][1] and sent.at
    assert client.get("/api/state").json()["auto_today"][0]["text"] == sent.text


def test_settings_round_trip(make_client):
    client, watcher, _ = make_client()
    r = client.put("/api/settings", json={"safety": {"auto_max_per_hour": 3, "auto_quiet_hours": True,
                                                       "auto_quiet_from": "20:30", "auto_quiet_to": "07:00",
                                                       "auto_weekends": False}})
    assert r.status_code == 200
    s = client.get("/api/settings").json()["settings"]["safety"]
    assert (s["auto_max_per_hour"], s["auto_quiet_hours"], s["auto_quiet_from"], s["auto_quiet_to"], s["auto_weekends"]) == \
        (3, True, "20:30", "07:00", False)
    assert client.put("/api/settings", json={"safety": {"auto_quiet_from": "25:00"}}).status_code == 422
