from __future__ import annotations

from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver

DM = "19:bb22@thread.v2"
URL = "/api/threads/19%3Abb22%40thread.v2/read"


class RefusingMarkDriver(MockTeamsDriver):
    def mark_read(self, thread_id: str) -> bool:
        self.last_error = "entrée « Marquer comme lu » introuvable"
        return False


def test_mark_read_clears_unread_without_opening(make_client):
    client, watcher, driver = make_client()
    entity = next(w for w in watcher.state.watchlist if w.thread_id == DM)
    entity.unread = True
    assert client.post(URL).json() == {"ok": True}
    assert driver.marked_read == [DM] and not entity.unread
    # Nothing opened or typed in Teams, and the catch-up no longer sees it.
    assert driver.opened == [] and driver.typed == []
    assert all(m.thread_id != DM for m in driver.list_unread())


def test_mark_read_unknown_conversation_is_404(make_client):
    client, _watcher, driver = make_client()
    assert client.post("/api/threads/19%3Ainconnu%40thread.v2/read").status_code == 404
    assert driver.marked_read == []


def test_mark_read_refused_keeps_unread_and_says_why(make_client):
    client, watcher, _driver = make_client(driver=RefusingMarkDriver(interval=9999))
    entity = next(w for w in watcher.state.watchlist if w.thread_id == DM)
    entity.unread = True
    r = client.post(URL)
    assert r.status_code == 409 and entity.unread
    assert any("introuvable" in l.text for l in watcher.state.logs)


def test_drivers_without_support_refuse():
    from drivers.base import TeamsDriver

    class Bare(MockTeamsDriver):
        mark_read = TeamsDriver.mark_read

    d = Bare(interval=9999)
    assert d.mark_read(DM) is False and "pas pris en charge" in d.last_error


def test_web_bridge_reports_the_page_answer(monkeypatch):
    driver = WebBridgeDriver()
    driver._names = {DM: "Lucas Bernard"}
    calls = []

    def rpc(op, timeout=None, **args):
        calls.append((op, args))
        return answers.pop(0)

    monkeypatch.setattr(driver, "_rpc", rpc)
    answers = [{"ok": True}, {"ok": True, "already": True}, {"ok": False, "error": "entrée inattendue « Marquer comme non lu »"}]
    assert driver.mark_read(DM) and driver.mark_read(DM)
    assert not driver.mark_read(DM) and "non lu" in driver.last_error
    assert calls[0] == ("markread", {"name": "Lucas Bernard"})
