from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

import follow_ups as fu
from drivers.mock import MockTeamsDriver
from models import IncomingMessage, Surface
from conftest import FakeBrain

DM = "19:bb22@thread.v2"
SEND = "/api/threads/19%3Abb22%40thread.v2/send"
MONDAY = datetime(2026, 11, 23, 10, 0)  # un lundi, 10 h
RELANCE = "Je reviens vers toi pour la relecture, tu as pu regarder ?"


class Clock:
    def __init__(self, now: datetime):
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def _setup(make_client, completion: str | None = None, at: datetime = MONDAY):
    brain = FakeBrain(completion=completion if completion is not None
                      else json.dumps({"en_attente": True, "relance": RELANCE}))
    client, watcher, driver = make_client(driver=MockTeamsDriver(interval=9999), brain=brain)
    watcher.outbox_auto = False
    watcher.follow_up_auto = False
    clock = Clock(at)
    watcher.follow_ups.clock = clock
    return client, watcher, driver, brain, clock


def _ask(client, text: str = "Tu peux relire la PR #214 ?") -> None:
    assert client.post(SEND, json={"text": text}).json()["ok"]


def _reply(watcher, text: str = "Oui, c'est fait") -> None:
    watcher._on_message(IncomingMessage(thread_id=DM, sender="Bob Martin", text=text, received_at="",
                                        surface=Surface.dm))


# --- détection ---
@pytest.mark.parametrize("text, expected", [
    ("Tu peux relire la PR ?", True),
    ("Peux-tu me dire où en est le build", True),
    ("Est-ce que la démo tient toujours", True),
    ("Tiens-moi au courant pour la livraison.", True),
    ("Je regarde ça demain.", False),
    ("Merci !", False),
    ("ok", False),
])
def test_is_question(text, expected):
    assert fu.is_question(text) is expected


def test_business_hours_skip_the_weekend():
    friday = datetime(2026, 11, 20, 17, 0)
    assert fu.business_hours(friday, datetime(2026, 11, 23, 10, 0)) == pytest.approx(17)
    assert fu.business_hours(MONDAY, MONDAY + timedelta(hours=24)) == pytest.approx(24)


def test_teams_times_are_read():
    now = datetime(2026, 11, 26, 15, 0)
    assert fu.parse_teams_time("14:32", now) == datetime(2026, 11, 26, 14, 32)
    assert fu.parse_teams_time("Hier 09:10", now) == datetime(2026, 11, 25, 9, 10)
    assert fu.parse_teams_time("23/11 16:05", now) == datetime(2026, 11, 23, 16, 5)
    assert fu.parse_teams_time("2026-11-20T08:00:00", now) == datetime(2026, 11, 20, 8, 0)
    assert fu.parse_teams_time("", now) is None
    assert fu.parse_teams_time("bientôt", now) is None


def test_question_is_proposed_after_the_delay_and_never_sent_alone(make_client):
    client, watcher, driver, brain, clock = _setup(make_client)
    _ask(client)
    assert driver.typed == [(DM, "Tu peux relire la PR #214 ?", True)]
    clock.now = MONDAY + timedelta(hours=5)
    assert watcher.scan_follow_ups() == 0 and watcher.state.follow_ups == [] and brain.prompts == []
    clock.now = MONDAY + timedelta(hours=24, minutes=1)
    assert watcher.scan_follow_ups() == 1
    [item] = watcher.state.follow_ups
    assert item.thread_id == DM and item.question == "Tu peux relire la PR #214 ?" and item.proposal == RELANCE
    assert item.asked_at == "2026-11-23T10:00"
    assert fu.MARKER in brain.prompts[0] and "Tu peux relire la PR #214 ?" in brain.prompts[0]
    # Proposée une seule fois, et rien n'a été tapé dans Teams.
    assert watcher.scan_follow_ups() == 0 and len(brain.prompts) == 1
    assert driver.typed == [(DM, "Tu peux relire la PR #214 ?", True)]
    state = client.get("/api/state").json()
    assert state["follow_ups"][0]["proposal"] == RELANCE


def test_no_follow_up_when_the_other_person_answered(make_client):
    client, watcher, _driver, brain, clock = _setup(make_client)
    _ask(client)
    _reply(watcher)
    clock.now = MONDAY + timedelta(days=2)
    assert watcher.scan_follow_ups() == 0 and brain.prompts == []
    # Déjà proposée, puis la réponse arrive : la relance disparaît.
    _ask(client, "Et pour la démo, jeudi ça te va ?")
    clock.now += timedelta(days=1)
    assert watcher.scan_follow_ups() == 1
    _reply(watcher, "Jeudi c'est bon")
    assert watcher.state.follow_ups == []


def test_no_follow_up_for_what_is_not_a_question(make_client):
    client, watcher, _driver, brain, clock = _setup(make_client)
    _ask(client, "Je regarde ça demain matin.")
    clock.now = MONDAY + timedelta(days=3)
    assert watcher.scan_follow_ups() == 0 and brain.prompts == []
    # Une question, puis un message de toi qui ne demande rien : tu es passé à autre chose.
    _ask(client, "Tu as vu mon mail ?")
    _ask(client, "Bon, je m'en occupe.")
    clock.now += timedelta(days=2)
    assert watcher.scan_follow_ups() == 0


def test_brain_saying_no_answer_expected_drops_it(make_client):
    client, watcher, _driver, _brain, clock = _setup(make_client, json.dumps({"en_attente": False, "relance": ""}))
    _ask(client, "Bonne journée ?")
    clock.now = MONDAY + timedelta(days=2)
    assert watcher.scan_follow_ups() == 0 and watcher.state.follow_ups == []
    clock.now += timedelta(days=1)
    assert watcher.scan_follow_ups() == 0


def test_unreadable_brain_answer_proposes_nothing_and_retries_later(make_client):
    client, watcher, _driver, brain, clock = _setup(make_client, "je ne sais pas")
    _ask(client)
    clock.now = MONDAY + timedelta(days=1, hours=1)
    assert watcher.scan_follow_ups() == 0 and len(brain.prompts) == 1
    assert watcher.scan_follow_ups() == 0 and len(brain.prompts) == 1  # pas de nouvel essai tout de suite
    assert any("pas encore proposée" in l.text for l in watcher.state.logs)


def test_weekend_and_night_are_not_counted(make_client):
    friday = datetime(2026, 11, 20, 17, 0)
    client, watcher, _driver, _brain, clock = _setup(make_client, at=friday)
    _ask(client)
    clock.now = datetime(2026, 11, 22, 18, 0)  # dimanche : rien
    assert watcher.scan_follow_ups() == 0
    clock.now = datetime(2026, 11, 23, 10, 0)  # lundi 10 h : 17 h ouvrées
    assert watcher.scan_follow_ups() == 0
    clock.now = datetime(2026, 11, 23, 22, 0)  # lundi soir : délai atteint mais la nuit
    assert watcher.scan_follow_ups() == 0
    clock.now = datetime(2026, 11, 24, 8, 30)
    assert watcher.scan_follow_ups() == 1


def test_snooze_hides_it_until_later(make_client):
    client, watcher, _driver, brain, clock = _setup(make_client)
    _ask(client)
    clock.now = MONDAY + timedelta(days=1, hours=1)
    watcher.scan_follow_ups()
    item_id = watcher.state.follow_ups[0].id
    assert client.post(f"/api/follow-ups/{item_id}/snooze", json={"hours": 24}).json()["ok"]
    assert watcher.state.follow_ups == []
    clock.now += timedelta(hours=3)
    watcher.scan_follow_ups()
    assert watcher.state.follow_ups == []
    clock.now += timedelta(hours=22)
    watcher.scan_follow_ups()
    assert [f.id for f in watcher.state.follow_ups] == [item_id]
    assert watcher.state.follow_ups[0].proposal == RELANCE and len(brain.prompts) == 1


def test_ignore_is_kept_even_when_the_question_is_read_again(make_client):
    client, watcher, _driver, brain, clock = _setup(make_client)
    _ask(client)
    clock.now = MONDAY + timedelta(days=1, hours=1)
    watcher.scan_follow_ups()
    item_id = watcher.state.follow_ups[0].id
    assert client.post(f"/api/follow-ups/{item_id}/ignore").json()["ok"]
    assert watcher.state.follow_ups == []
    watcher._track(DM, [fu.Seen(sender="moi", text="Tu peux relire la PR #214 ?", mine=True)])
    clock.now += timedelta(days=3)
    assert watcher.scan_follow_ups() == 0 and len(brain.prompts) == 1
    assert client.post(f"/api/follow-ups/{item_id}/send", json={}).status_code == 404


def test_send_uses_the_edited_text_on_click(make_client):
    client, watcher, driver, _brain, clock = _setup(make_client)
    _ask(client)
    clock.now = MONDAY + timedelta(days=1, hours=1)
    watcher.scan_follow_ups()
    item_id = watcher.state.follow_ups[0].id
    r = client.post(f"/api/follow-ups/{item_id}/send", json={"text": "Tu as pu regarder la PR ?"}).json()
    assert r["ok"] and driver.typed[-1] == (DM, "Tu as pu regarder la PR ?", True)
    assert watcher.state.follow_ups == []
    # La relance est elle-même une question : suivie à son tour, avec un nouveau délai.
    clock.now += timedelta(hours=2)
    assert watcher.scan_follow_ups() == 0
    clock.now += timedelta(days=1)
    assert watcher.scan_follow_ups() == 1
    assert watcher.state.follow_ups[0].question == "Tu as pu regarder la PR ?"


def test_disabled_in_settings_proposes_nothing(make_client):
    client, watcher, _driver, brain, clock = _setup(make_client)
    r = client.put("/api/settings", json={"follow_ups": {"enabled": False, "delay_hours": 4}}).json()
    assert r["settings"]["follow_ups"] == {"enabled": False, "delay_hours": 4}
    _ask(client)
    clock.now = MONDAY + timedelta(days=2)
    assert watcher.scan_follow_ups() == 0 and brain.prompts == []
    client.put("/api/settings", json={"follow_ups": {"enabled": True}})
    assert watcher.scan_follow_ups() == 1


def test_shorter_delay_from_settings(make_client):
    client, watcher, _driver, _brain, clock = _setup(make_client)
    client.put("/api/settings", json={"follow_ups": {"delay_hours": 4}})
    _ask(client)
    clock.now = MONDAY + timedelta(hours=3)
    assert watcher.scan_follow_ups() == 0
    clock.now = MONDAY + timedelta(hours=4)
    assert watcher.scan_follow_ups() == 1


def test_question_read_in_history_keeps_its_teams_time(make_client):
    _client, watcher, _driver, _brain, clock = _setup(make_client, at=datetime(2026, 11, 26, 11, 0))
    watcher._track(DM, [
        IncomingMessage(thread_id=DM, sender="Bob Martin", text="Je t'envoie le lien", received_at="23/11 09:00",
                        surface=Surface.dm),
        IncomingMessage(thread_id=DM, sender="Moi", text="Merci, et la recette c'est pour quand ?",
                        received_at="23/11 09:30", surface=Surface.dm),
    ])
    assert watcher.scan_follow_ups() == 1
    assert watcher.state.follow_ups[0].asked_at == "2026-11-23T09:30"


def test_tracking_survives_a_restart(fresh_home):
    clock = Clock(MONDAY)
    tracker = fu.Tracker(fresh_home / "follow_ups.json", clock)
    tracker.observe(DM, "Bob", [fu.Seen(sender="moi", text="Tu peux relire ?", mine=True)])
    again = fu.Tracker(fresh_home / "follow_ups.json", clock)
    clock.now = MONDAY + timedelta(days=1)
    [entry] = again.due(24)
    assert entry.question == "Tu peux relire ?"
