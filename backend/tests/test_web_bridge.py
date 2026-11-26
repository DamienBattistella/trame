from __future__ import annotations
import threading

from drivers.preview_watch import PreviewWatcher
from drivers.web_bridge import WebBridgeDriver
from models import WatchEntity, Surface

LABELS = [
    {"label": "Quick views", "aria": "expanded=true;level=1"},
    {"label": "Chat Romain CUREAU Away Last message je vais préparer ça 25/11", "aria": "level=2", "id": "r1"},
    {"label": "Group chat Projet FHIR Unread Last message Lucas: on fait un point ? 10:02", "aria": "level=2", "id": "r2"},
]


class FakePage:
    """Plays the Teams web page: answers the commands the Trame UI relays."""

    def __init__(self, client):
        self.client, self.title, self.typed, self.stop = client, "Chat | Autre | Microsoft Teams", [], False
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def answer(self, cmd):
        op, a = cmd["op"], cmd["args"]
        if op == "ping":
            return {"title": self.title, "ready": True}
        if op == "list":
            return LABELS
        if op == "title":
            return self.title
        if op == "open":
            self.title = f"Chat | {a['name']} | Microsoft Teams"
            return {"ok": True, "title": self.title}
        if op == "read":
            return [{"sender": "Romain CUREAU", "text": "Tu as vu ?", "at": "10:00"}]
        if op == "type":
            self.typed.append((a["name"], a["text"], a["send"]))
            return {"ok": True}
        return None

    def loop(self):
        while not self.stop:
            cmd = self.client.get("/api/teams-web/poll").json()["command"]
            if cmd:
                self.client.post("/api/teams-web/reply", json={"id": cmd["id"], "ok": True, "result": self.answer(cmd)})


def test_bridge_end_to_end(make_client, monkeypatch):
    monkeypatch.setattr(WebBridgeDriver, "RPC_TIMEOUT", 3.0)
    monkeypatch.setattr(WebBridgeDriver, "POLL_WAIT", 0.5)
    driver = WebBridgeDriver()
    client, watcher, _ = make_client(driver=driver)
    page = FakePage(client)
    driver._last_poll = __import__("time").monotonic()
    page.thread.start()
    try:
        convs = driver.list_conversations()
        assert [c.display_name for c in convs] == ["Romain CUREAU", "Projet FHIR"]
        assert convs[1].surface == Surface.group and convs[1].unread
        watcher.state.watchlist = convs
        msgs = client.get("/api/threads/name%3ARomain%20CUREAU/messages").json()
        assert msgs["ok"] and msgs["messages"][0]["text"] == "Tu as vu ?"
        r = client.post("/api/threads/name%3ARomain%20CUREAU/send", json={"text": "Oui je regarde"})
        assert r.json() == {"ok": True}
        assert ("Romain CUREAU", "Oui je regarde", True) in page.typed
        assert client.get("/api/teams-web/status").json()["status"]["ready"] is True
    finally:
        page.stop = True
        page.thread.join(timeout=5)


def test_bridge_without_relay_fails_safe():
    d = WebBridgeDriver()
    assert d.selftest() is False and d.open_thread("name:X") is False


def test_preview_watcher_detects_only_new_messages_from_others():
    w = PreviewWatcher()
    convs = {"a": WatchEntity(thread_id="a", display_name="Romain", surface=Surface.dm)}
    first = [("a", "Chat Romain Away Last message salut 10:00")]
    assert w.diff(first, convs) == []
    assert w.diff(first, convs) == []
    new = w.diff([("a", "Chat Romain Away Last message tu as vu ? 10:05")], convs)
    assert len(new) == 1 and new[0].sender == "Romain" and new[0].text == "tu as vu ?"
    assert w.diff([("a", "Chat Romain Away Last message You: oui 10:06")], convs) == []


def test_preview_time_relabel_is_not_a_new_message():
    w = PreviewWatcher()
    convs = {"a": WatchEntity(thread_id="a", display_name="Alice", surface=Surface.dm)}
    w.diff([("a", "Chat Alice Away Last message on se voit demain ? 23:41")], convs)
    assert w.diff([("a", "Chat Alice Away Last message on se voit demain ? Yesterday")], convs) == []
    assert w.diff([("a", "Chat Alice Away Last message on se voit demain ? 20/11")], convs) == []
    assert w.diff([("a", "Conversation Alice Absent Dernier message Vous : oui 08:00")], convs) == []


def test_own_message_in_french_never_triggers(make_client):
    from models import IncomingMessage
    _c, watcher, driver = make_client()
    msg = IncomingMessage(thread_id="19:aa11@thread.v2", sender="Vous", text="je regarde", received_at="10:00", surface=Surface.dm)
    assert watcher._process(msg) is None and driver.typed == []


def test_teams_ready_marks_checked_and_reads_conversations(make_client):
    _c, watcher, driver = make_client()
    watcher.state.selftest_ok = False
    watcher.state.watchlist = []
    watcher.teams_ready(True)
    assert watcher.state.selftest_ok and watcher.state.watchlist
    assert any(l.text == "Teams connecté" for l in watcher.state.logs)
    watcher.teams_ready(True)
    assert sum(l.text == "Teams connecté" for l in watcher.state.logs) == 1
