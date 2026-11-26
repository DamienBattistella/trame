"""Contrôle de la page Teams web : ce qui manque, ce que ça casse, quand le moteur le dit."""
from __future__ import annotations
import threading
import time
from datetime import datetime

import teams_check as tc
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver
from watcher import Watcher

NOW = datetime(2026, 11, 26, 10, 0, 0)


def _all(value=True, **over):
    return {k: over.get(k, value) for k in tc.LANDMARKS}


def test_nothing_missing():
    check = tc.evaluate(_all(), {}, NOW)
    assert check.ok and check.summary == "" and check.missing == []
    assert check.verified == len(tc.LANDMARKS) and check.unverified == 0


def test_one_feature_says_what_breaks_and_nothing_else():
    check = tc.evaluate(_all(mention_list=False), {}, NOW)
    assert not check.ok
    assert check.summary == "Teams a changé : la mention ne marchera plus, rien d'autre n'est touché."
    assert [(m.key, m.how) for m in check.missing] == [("mention_list", "page")]


def test_several_features_and_plural():
    check = tc.evaluate(_all(react_like=False, quote=False), {}, NOW)
    assert check.summary == ("Teams a changé : les réactions et la réponse à un message précis "
                             "ne marcheront plus, rien d'autre n'est touché.")
    assert tc.summarize(["attach"]).endswith("les pièces jointes ne marcheront plus, rien d'autre n'est touché.")


def test_missing_chat_list_breaks_everything():
    check = tc.evaluate(_all(rail=False), {}, NOW)
    assert "plus rien ne peut être lu ni envoyé" in check.summary
    assert "rien d'autre" not in check.summary


def test_unverifiable_landmarks_are_neither_ok_nor_missing():
    results = _all(None)
    results["rail"] = True
    check = tc.evaluate(results, {}, NOW)
    assert check.ok and check.verified == 1 and check.unverified == len(tc.LANDMARKS) - 1


def test_menu_landmark_seen_missing_by_an_operation():
    at = int(NOW.timestamp() * 1000)
    marks = tc.merge_marks({}, {"read_entry": {"ok": False, "at": at}, "bogus": {"ok": False, "at": at}})
    assert set(marks) == {"read_entry"}
    check = tc.evaluate(_all(None, rail=True), marks, NOW)
    assert [(m.key, m.how, m.at) for m in check.missing] == [("read_entry", "usage", "2026-11-26T10:00:00")]
    assert "le marquage comme lu ne marchera plus" in check.summary
    # Constaté présent ensuite : l'alerte tombe.
    marks = tc.merge_marks(marks, {"read_entry": {"ok": True, "at": at + 1000}})
    assert tc.evaluate(_all(None, rail=True), marks, NOW).ok
    # Un constat plus ancien ne remplace pas le dernier.
    assert tc.merge_marks(marks, {"read_entry": {"ok": False, "at": at}})["read_entry"]["ok"] is True


def test_seen_on_the_page_wins_over_an_old_usage_mark():
    marks = tc.merge_marks({}, {"unread": {"ok": False, "at": 1}})
    assert tc.evaluate(_all(), marks, NOW).ok


# --- moteur ---

class Driver(MockTeamsDriver):
    def __init__(self, raw):
        super().__init__(interval=9999)
        self.raw = raw

    def probe_page(self):
        return self.raw


def _warns(watcher):
    return [l.text for l in watcher.state.logs if l.level == "warn"]


def test_watcher_exposes_the_check_and_logs_changes_only(make_client):
    driver = Driver({"ready": True, "results": _all(), "marks": {}})
    client, watcher, _ = make_client(driver=driver)
    assert watcher.check_teams().ok
    assert any("Contrôle de Teams" in l.text for l in watcher.state.logs)
    driver.raw = {"ready": True, "results": _all(mention_list=False), "marks": {}}
    for _ in range(3):
        watcher.check_teams()
    assert len(_warns(watcher)) == 1
    assert _warns(watcher)[0].startswith("Teams a changé : la mention ne marchera plus")
    state = client.get("/api/state").json()["teams_check"]
    assert state["ok"] is False and state["missing"][0]["key"] == "mention_list"
    assert state["missing"][0]["label"] == "suggestions de mention" and state["at"]
    driver.raw = {"ready": True, "results": _all(), "marks": {}}
    watcher.check_teams()
    assert watcher.state.teams_check.ok
    assert "revenus" in watcher.state.logs[0].text


def test_teams_not_shown_keeps_the_last_check(make_client):
    driver = Driver({"ready": True, "results": _all(send=False), "marks": {}})
    client, watcher, _ = make_client(driver=driver)
    watcher.check_teams()
    driver.raw = {"ready": False, "results": {}, "marks": {}}
    assert watcher.check_teams() is None
    assert watcher.state.teams_check.missing[0].key == "send"
    res = client.post("/api/teams/check")
    assert res.status_code == 409


def test_api_runs_the_check(make_client):
    client, watcher, _ = make_client(driver=Driver({"ready": True, "results": _all(attach=False), "marks": {}}))
    body = client.post("/api/teams/check").json()
    assert body["ok"] and body["check"]["summary"].startswith("Teams a changé : les pièces jointes")


def test_mock_driver_shows_the_alert_on_demand(make_client, monkeypatch):
    monkeypatch.setattr(MockTeamsDriver, "missing_landmarks", ("mention_list",))
    _client, watcher, _ = make_client()
    check = watcher.check_teams()
    assert [m.key for m in check.missing] == ["mention_list"]


def test_loop_checks_after_connection_and_after_a_refusal(make_client, monkeypatch):
    monkeypatch.setattr(Watcher, "CHECK_SETTLE", 0.05)
    calls = []
    driver = Driver({"ready": True, "results": _all(), "marks": {}})
    driver.probe_page = lambda: calls.append(time.monotonic()) or driver.raw
    _client, watcher, _ = make_client(driver=driver)
    deadline = time.monotonic() + 3
    while not calls and time.monotonic() < deadline:
        time.sleep(0.02)
    assert calls, "pas de contrôle au démarrage"
    n = len(calls)
    # Plusieurs refus rapprochés : un seul contrôle.
    for _ in range(5):
        driver.on_page_failure()
    deadline = time.monotonic() + 3
    while len(calls) == n and time.monotonic() < deadline:
        time.sleep(0.02)
    time.sleep(0.2)
    assert len(calls) == n + 1


def test_bridge_signals_a_refusal_but_not_a_probe(monkeypatch):
    driver = WebBridgeDriver()
    driver._last_poll = time.monotonic()
    fired = []
    driver.on_page_failure = lambda: fired.append(True)

    def page(answers):
        def run():
            for result in answers:
                cmd = driver.next_command(wait=2)
                driver.deliver(cmd["id"], True, result)
        t = threading.Thread(target=run, daemon=True)
        t.start()
        return t

    t = page([{"ok": False, "error": "entrée « Marquer comme lu » introuvable"}])
    assert not driver.mark_read("19:x@thread.v2")
    t.join()
    assert fired == [True]
    t = page([{"ready": True, "results": {}, "marks": {}}])
    assert driver.probe_page()["ready"]
    t.join()
    t = page([{"ok": True}])
    assert driver.mark_read("19:x@thread.v2")
    t.join()
    assert fired == [True]
