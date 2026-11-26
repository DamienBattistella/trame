from __future__ import annotations
import json

import pytest

from conftest import FakeBrain, RefusingDriver
from drivers.mock import MockTeamsDriver
from models import IncomingMessage, Surface

USER_VIEW = "19:ee55@thread.v2"
DM_DRAFT = "19:bb22@thread.v2"
DM_AUTO = "19:aa11@thread.v2"

DIGEST = json.dumps({"summary": "Résumé.", "open_points": [], "topics": [], "search_queries": []})


def _msg(thread_id: str, text: str = "Salut, tu as un moment ?"):
    return IncomingMessage(thread_id=thread_id, sender="Quelqu'un", text=text, received_at="10:00", surface=Surface.dm)


def _looking_at(driver: MockTeamsDriver, thread_id: str = USER_VIEW) -> MockTeamsDriver:
    driver._active = thread_id
    return driver


class NoReturnDriver(MockTeamsDriver):
    """The user's previous conversation can no longer be reopened."""

    def open_thread(self, thread_id: str) -> bool:
        return False if thread_id == USER_VIEW else super().open_thread(thread_id)


class ScreenShareDriver(MockTeamsDriver):
    def is_screen_sharing(self) -> bool:
        return True


def test_focused_restores_previous_even_on_error():
    driver = _looking_at(MockTeamsDriver(interval=9999))
    with pytest.raises(RuntimeError):
        with driver.focused(DM_DRAFT) as focus:
            assert focus.ok and focus.previous == USER_VIEW and driver.active_thread() == DM_DRAFT
            raise RuntimeError("boom")
    assert driver.active_thread() == USER_VIEW and focus.restored is True


def test_focused_without_restore_and_unknown_target():
    driver = _looking_at(MockTeamsDriver(interval=9999))
    with driver.focused(DM_DRAFT, restore=False) as focus:
        pass
    assert focus.ok and focus.restored is None and driver.active_thread() == DM_DRAFT
    with driver.focused("19:inconnu@thread.v2") as focus:
        assert not focus.ok
    assert driver.active_thread() == DM_DRAFT and focus.restored is None


def test_auto_send_restores_user_view(make_client):
    _client, watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999)))
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert driver.typed == [(DM_AUTO, "Réponse de test", True)]
    assert driver.opened == [DM_AUTO, USER_VIEW, DM_AUTO, USER_VIEW]
    assert driver.active_thread() == USER_VIEW


def test_auto_send_warns_when_view_cannot_be_restored(make_client):
    _client, watcher, driver = make_client(driver=_looking_at(NoReturnDriver(interval=9999)))
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert driver.typed == [(DM_AUTO, "Réponse de test", True)]
    assert any(log.level == "warn" and "rouvrir" in log.text for log in watcher.state.logs)


def test_auto_send_refused_never_types(make_client):
    _client, watcher, driver = make_client(driver=_looking_at(RefusingDriver(interval=9999)))
    assert watcher._process(_msg(DM_AUTO)) == "draft"
    assert driver.typed == [] and driver.active_thread() == USER_VIEW


def test_send_restores_but_compose_leaves_target_open(make_client):
    client, watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999)))
    assert watcher._process(_msg(DM_DRAFT), force_draft=True) == "draft"
    d = watcher.state.drafts[0]
    assert client.post(f"/api/drafts/{d.id}/compose").status_code == 200
    assert driver.active_thread() == DM_DRAFT

    driver._active = USER_VIEW
    assert client.post(f"/api/drafts/{d.id}/send").status_code == 200
    assert driver.active_thread() == USER_VIEW
    assert driver.typed == [(DM_DRAFT, "Réponse de test", False), (DM_DRAFT, "Réponse de test", True)]


def test_brief_reads_target_then_restores(make_client):
    brain = FakeBrain(completion=DIGEST)
    client, _watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999)), brain=brain)
    r = client.post(f"/api/threads/{DM_DRAFT}/brief")
    assert r.status_code == 200, r.json()
    assert driver.opened == [DM_DRAFT, USER_VIEW]
    assert driver.active_thread() == USER_VIEW
    assert "Lucas Bernard" in brain.prompts[0]


def test_brief_on_already_open_thread_does_not_switch(make_client):
    client, _watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999), DM_DRAFT),
                                           brain=FakeBrain(completion=DIGEST))
    assert client.post(f"/api/threads/{DM_DRAFT}/brief").status_code == 200
    assert driver.active_thread() == DM_DRAFT and driver.opened == [DM_DRAFT]


def test_brief_unconfirmed_thread_is_409_and_not_cached(make_client):
    brain = FakeBrain(completion=DIGEST)
    client, watcher, driver = make_client(driver=_looking_at(RefusingDriver(interval=9999)), brain=brain)
    r = client.post(f"/api/threads/{DM_DRAFT}/brief")
    assert r.status_code == 409 and r.json()["ok"] is False
    assert "Lucas Bernard" in r.json()["error"]
    assert brain.prompts == []
    assert client.get(f"/api/threads/{DM_DRAFT}/brief").json() == {"ok": True, "brief": None}
    assert driver.active_thread() == USER_VIEW
    assert watcher.state.logs[0].level == "warn"


def test_brief_never_switches_conversation_during_screen_share(make_client):
    brain = FakeBrain(completion=DIGEST)
    client, _watcher, driver = make_client(driver=_looking_at(ScreenShareDriver(interval=9999)), brain=brain)
    r = client.post(f"/api/threads/{DM_DRAFT}/brief")
    assert r.status_code == 409 and "Partage d'écran" in r.json()["error"]
    assert driver.opened == [] and brain.prompts == []
    driver._active = DM_DRAFT
    assert client.post(f"/api/threads/{DM_DRAFT}/brief").status_code == 200


class SummaryBrain(FakeBrain):
    def __init__(self):
        super().__init__()
        self.summaries: list[str] = []

    def draft(self, soul, thread_summary, incoming, github_context="", people_context=""):
        self.summaries.append(thread_summary)
        return super().draft(soul, thread_summary, incoming, github_context)


def test_background_draft_reads_history_then_restores(make_client):
    brain = SummaryBrain()
    _client, watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999)), brain=brain)
    assert watcher._process(_msg(DM_DRAFT)) == "draft"
    assert driver.opened == [DM_DRAFT, USER_VIEW] and driver.active_thread() == USER_VIEW
    assert "Lucas Bernard:" in brain.summaries[0]


def test_history_cache_avoids_reopening_within_ttl(make_client, monkeypatch):
    brain = SummaryBrain()
    _client, watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999)), brain=brain)
    watcher._process(_msg(DM_DRAFT))
    watcher._process(_msg(DM_DRAFT, "Et sinon ?"))
    assert driver.opened == [DM_DRAFT, USER_VIEW]
    assert brain.summaries[0] == brain.summaries[1] != ""
    real = watcher._history[DM_DRAFT]
    watcher._history[DM_DRAFT] = (real[0] - watcher.HISTORY_TTL - 1, real[1])
    watcher._process(_msg(DM_DRAFT, "Toujours là ?"))
    assert driver.opened == [DM_DRAFT, USER_VIEW, DM_DRAFT, USER_VIEW]


def test_history_on_open_thread_does_not_switch(make_client):
    brain = SummaryBrain()
    _client, watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999), DM_DRAFT), brain=brain)
    watcher._process(_msg(DM_DRAFT))
    assert driver.opened == [] and brain.summaries[0]


def test_history_never_switches_during_screen_share(make_client):
    _client, watcher, driver = make_client(driver=_looking_at(ScreenShareDriver(interval=9999)))
    assert watcher._summary(DM_DRAFT, 15) == ""
    assert driver.opened == [] and DM_DRAFT not in watcher._history


def test_engine_starts_when_teams_driver_cannot_load(monkeypatch, make_client):
    import builtins
    import app as appmod
    from drivers.unavailable import UnavailableDriver
    real_import = builtins.__import__

    def no_uia(name, *args, **kwargs):
        if name == "drivers.windows_uia":
            raise ImportError("No module named 'uiautomation'")
        return real_import(name, *args, **kwargs)

    monkeypatch.delenv("TRAME_DRIVER", raising=False)
    monkeypatch.setattr(appmod.os, "name", "nt")
    monkeypatch.setattr(builtins, "__import__", no_uia)
    driver = appmod.make_driver()
    monkeypatch.setattr(builtins, "__import__", real_import)
    assert isinstance(driver, UnavailableDriver)
    client, watcher, _ = make_client(driver=driver)
    assert client.get("/api/state").status_code == 200 and watcher.state.selftest_ok is False
    assert driver.type_focused("19:x@thread.v2", "hello", True, True).ok is False
