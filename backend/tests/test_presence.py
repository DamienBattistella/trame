from __future__ import annotations
import json

import pytest

import presence
from conftest import FakeBrain
from drivers import base as basemod
from drivers.mock import MockTeamsDriver
from drivers.rail_label import parse
from drivers.web_bridge import WebBridgeDriver
from models import IncomingMessage, Surface

DM = "19:bb22@thread.v2"
GROUP = "19:cc33@thread.v2"


class FixedPresence(MockTeamsDriver):
    def __init__(self, seen=None, fail=False):
        super().__init__(interval=9999)
        self.seen, self.fail = dict(seen or {}), fail

    def presence(self):
        if self.fail:
            raise RuntimeError("Teams fermé")
        return dict(self.seen)


@pytest.mark.parametrize("raw, expected", [
    ("Available", "available"), ("Disponible", "available"), ("In a meeting", "in_meeting"),
    ("En réunion", "in_meeting"), ("Statut : En réunion", "in_meeting"), ("Busy, until 15:00", "busy"),
    ("Do not disturb", "dnd"), ("Be right back", "brb"), ("Absent", "away"), ("Absent du bureau", "ooo"),
    ("Hors connexion", "offline"), ("In a call", "in_call"), ("Presenting", "presenting"),
])
def test_teams_wordings_map_to_one_status(raw, expected):
    assert presence.from_label(raw) == expected


@pytest.mark.parametrize("raw", ["", None, "Status unknown", "Statut inconnu", "Sofia Marino", "photo de profil",
                                 "Available " + "x" * 80])
def test_unknown_wording_is_no_status(raw):
    assert presence.from_label(raw) is None


def test_first_recognised_label_wins():
    assert presence.first_of(["Photo de profil de Sofia", None, 3, "En réunion", "Disponible"]) == "in_meeting"
    assert presence.first_of(None) is None and presence.first_of([]) is None


def test_uia_label_carries_presence_but_never_from_the_preview():
    assert parse("Chat Bertrand GAUTHIER Offline Last message voir ça demain 25/11").presence == "offline"
    assert parse("Chat Celine Leleux Has pinned messages In a meeting Last message ok").presence == "in_meeting"
    assert parse("Conversation Sofia Marino Absent du bureau Dernier message ok 25/11").presence == "ooo"
    # The words are in the preview only: not a status.
    assert parse("Chat Lucas Bernard Last message je suis disponible 10:02").presence is None
    # Groups have no presence; neither has the user's own chat or a Teams web label.
    assert parse("Group chat Projet FHIR Available Last message Lucas: ok 10:02").presence is None
    assert parse("Chat Damien Battistella (You) Available You: test 04:49").presence is None
    assert parse("Romain CUREAU 25/11 Disponible").presence is None


def test_driver_drops_a_stale_status(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(basemod.time, "monotonic", lambda: now[0])
    d = WebBridgeDriver()
    d._note_presence("a", "busy")
    d._note_presence("b", "available")
    d._note_presence("b", None)
    assert d.presence() == {"a": "busy"}
    now[0] += d.PRESENCE_TTL + 1
    assert d.presence() == {}


def test_web_bridge_reads_the_avatar_badge(monkeypatch):
    d = WebBridgeDriver()
    items = [
        {"label": "Romain CUREAU 25/11 je vais préparer ça", "id": "19:r1@unq.gbl.spaces", "presence": ["Romain", "En réunion"]},
        {"label": "Hugo Lannes 24/11", "id": "19:h2@unq.gbl.spaces", "presence": ["Photo de profil"]},
        {"label": "Projet FHIR 10:02 Lucas: ok", "id": "19:p3@thread.v2", "presence": ["Available"]},
        {"label": "Chiara Rossi 09:12", "id": "19:c4@unq.gbl.spaces"},
    ]
    monkeypatch.setattr(d, "_rpc", lambda op, timeout=None, **a: items)
    convs = {c.display_name: c for c in d.list_conversations()}
    assert convs["Romain CUREAU"].presence == "in_meeting"
    assert convs["Hugo Lannes"].presence is None
    assert convs["Projet FHIR"].surface == Surface.group and convs["Projet FHIR"].presence is None
    assert convs["Chiara Rossi"].presence is None
    assert d.presence() == {"19:r1@unq.gbl.spaces": "in_meeting"}


def test_mock_gives_varied_statuses_to_one_to_one_chats_only():
    d = MockTeamsDriver(interval=9999)
    seen = d.presence()
    convs = {c.thread_id: c for c in d.list_conversations()}
    assert set(seen) == {t for t, c in convs.items() if c.surface == Surface.dm}
    assert all(v in presence.LABELS for v in seen.values())
    assert convs[GROUP].presence is None


def test_watcher_applies_presence_and_clears_it_when_teams_stops_saying(make_client):
    driver = FixedPresence({DM: "in_meeting", GROUP: "available"})
    client, watcher, _ = make_client(driver=driver)
    watcher.apply_presence()
    by_id = {w["thread_id"]: w for w in client.get("/api/state").json()["watchlist"]}
    assert by_id[DM]["presence"] == "in_meeting"
    assert by_id[GROUP]["presence"] is None
    driver.fail = True
    watcher.apply_presence()
    assert all(w.presence is None for w in watcher.state.watchlist)


def test_presence_is_never_saved(make_client, fresh_home):
    client, watcher, _ = make_client(driver=FixedPresence({DM: "busy"}))
    watcher.apply_presence()
    client.post(f"/api/watch/{DM}", json={"watch": True})
    watcher._persist_watchlist()
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))["watchlist"]
    assert saved and all("presence" not in w for w in saved)


def test_brain_hears_a_meeting_and_nothing_else_is_sent(make_client):
    brain = FakeBrain()
    driver = FixedPresence({DM: "in_meeting"})
    _client, watcher, _ = make_client(driver=driver, brain=brain)
    watcher.apply_presence()
    msg = IncomingMessage(thread_id=DM, sender="Lucas Bernard", text="Tu regardes ?", received_at="10:00", surface=Surface.dm)
    assert watcher._process(msg) == "draft"
    assert "Présence Teams de Lucas Bernard en ce moment : En réunion" in brain.people[-1]
    assert driver.typed == []

    driver.seen = {DM: "available"}
    watcher.apply_presence()
    assert watcher._process(msg) == "draft"
    assert "Présence" not in brain.people[-1]


def test_brain_hint_only_for_busy_statuses():
    assert presence.brain_hint("Sofia Marino", "available") == ""
    assert presence.brain_hint("Sofia Marino", None) == ""
    assert "Ne pas déranger" in presence.brain_hint("Sofia Marino", "dnd")
