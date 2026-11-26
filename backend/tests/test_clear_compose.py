from __future__ import annotations

from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver

USER_VIEW = "19:ee55@thread.v2"
DM = "19:bb22@thread.v2"
URL = "/api/threads/19%3Abb22%40thread.v2/clear-compose"


class StuckDriver(MockTeamsDriver):
    def _clear_active(self, thread_id: str) -> bool:
        self.last_error = "Teams intégré : zone de saisie toujours occupée (pièce jointe)"
        return False


def _looking_at(driver, thread_id=USER_VIEW):
    driver._active = thread_id
    return driver


def test_clear_compose_empties_then_puts_back_the_open_conversation(make_client):
    client, watcher, driver = make_client(driver=_looking_at(MockTeamsDriver(interval=9999)))
    assert client.post(URL).json() == {"ok": True}
    assert driver.cleared == [DM] and driver.active_thread() == USER_VIEW and driver.typed == []
    assert any("vidée dans Teams" in l.text for l in watcher.state.logs)


def test_clear_compose_unknown_conversation_is_404(make_client):
    client, _watcher, driver = make_client()
    assert client.post("/api/threads/19%3Ainconnu%40thread.v2/clear-compose").status_code == 404
    assert driver.cleared == []


def test_clear_compose_refused_says_why(make_client):
    client, watcher, _driver = make_client(driver=_looking_at(StuckDriver(interval=9999)))
    r = client.post(URL)
    assert r.status_code == 409 and "toujours occupée" in r.json()["error"]
    assert any("non vidée" in l.text for l in watcher.state.logs)


def test_driver_without_support_refuses():
    from drivers.base import TeamsDriver

    class Bare(MockTeamsDriver):
        _clear_active = TeamsDriver._clear_active

    d = _looking_at(Bare(interval=9999))
    assert d.clear_compose(DM) is False and "pas pris en charge" in d.last_error


def test_web_bridge_asks_the_page(monkeypatch):
    driver = WebBridgeDriver()
    driver._names = {DM: "Lucas Bernard"}
    calls, answers = [], [{"ok": True}, {"ok": False, "error": "zone de saisie toujours occupée (texte)"}]
    monkeypatch.setattr(driver, "_rpc", lambda op, timeout=None, **a: calls.append((op, a)) or answers.pop(0))
    assert driver._clear_active(DM) and not driver._clear_active(DM)
    assert calls[0] == ("clearcompose", {"name": "Lucas Bernard"}) and "toujours occupée" in driver.last_error
