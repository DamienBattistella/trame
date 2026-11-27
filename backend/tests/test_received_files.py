from __future__ import annotations

import pytest

from drivers.base import NeedsView
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import BridgeUnavailable, WebBridgeDriver
from models import FileRef, ImageRef, IncomingMessage, Surface

DM = "19:bb22@thread.v2"
JPEG = "data:image/jpeg;base64," + "A" * 40
SP = "https://dedalusspa-my.sharepoint.com/:b:/g/personal/x/IQD"


def _bridge(monkeypatch, messages):
    driver = WebBridgeDriver()
    monkeypatch.setattr(driver, "_rpc", lambda op, timeout=None, **a: {"messages": messages, "top": True})
    return driver


def test_bridge_keeps_files_and_images_and_checks_them(monkeypatch):
    driver = _bridge(monkeypatch, [
        {"sender": "Yves", "text": "Le parcours", "at": "10:00", "files": [
            {"name": "  WebAgenda   v3.pdf ", "url": SP},
            {"name": "piège.pdf", "url": "https://evil.example.com/x.pdf"},
            {"name": "", "url": SP},
        ]},
        {"sender": "Yves", "text": "", "at": "10:01", "images": [
            {"data": JPEG, "width": 800, "height": 262},
            {"data": "data:text/html;base64,PHNjcmlwdD4=", "width": 10, "height": 10},
            {"data": None},
        ]},
        {"sender": "Yves", "text": "", "at": "10:02"},
    ])
    msgs, top = driver.read_history(DM, 30)
    assert top and len(msgs) == 2  # the empty one is dropped
    assert msgs[0].files == [FileRef(name="WebAgenda v3.pdf", url=SP), FileRef(name="piège.pdf", url="")]
    assert msgs[1].text == "" and msgs[1].images == [
        ImageRef(data=JPEG, width=800, height=262), ImageRef(), ImageRef()]


def test_oversized_image_is_dropped(monkeypatch):
    big = "data:image/png;base64," + "A" * 1_600_000
    driver = _bridge(monkeypatch, [{"sender": "Yves", "text": "x", "images": [{"data": big, "width": 1, "height": 1}]}])
    assert driver.read_history(DM, 30)[0][0].images == [ImageRef()]


class AttachDriver(MockTeamsDriver):
    def read_context(self, thread_id, last_n):
        return [
            IncomingMessage(thread_id=thread_id, sender="Lucas Bernard", text="Voici le rapport", received_at="10:00",
                            surface=Surface.dm, files=[FileRef(name="rapport.pdf", url=SP)]),
            IncomingMessage(thread_id=thread_id, sender="Lucas Bernard", text="", received_at="10:01",
                            surface=Surface.dm, images=[ImageRef(data=JPEG, width=800, height=262)]),
        ]


def test_thread_api_returns_files_and_images(make_client):
    client, _watcher, _driver = make_client(driver=AttachDriver(interval=9999))
    msgs = client.get("/api/threads/19%3Abb22%40thread.v2/messages").json()["messages"]
    assert msgs[0]["files"] == [{"name": "rapport.pdf", "url": SP, "kind": ""}] and msgs[0]["images"] == []
    assert msgs[1]["text"] == "" and msgs[1]["images"] == [{"data": JPEG, "width": 800, "height": 262}]


def test_brain_gets_words_not_image_data(make_client):
    _client, watcher, _driver = make_client(driver=AttachDriver(interval=9999))
    msgs = watcher._read_focused(DM, "Lucas Bernard", 30)
    assert msgs[0].text == "Voici le rapport\n[fichier joint : rapport.pdf]"
    assert msgs[1].text == "[image]" and msgs[1].images == []


VIDEO = "https://dedalusspa-my.sharepoint.com/:v:/g/personal/x/IQAx"
DOWNLOAD = "https://dedalusspa-my.sharepoint.com/personal/x/_layouts/15/download.aspx?UniqueId=abc&tempauth=t"


def test_bridge_marks_videos_only_when_the_page_says_so(monkeypatch):
    driver = _bridge(monkeypatch, [{"sender": "Yves", "text": "", "at": "10:00", "files": [
        {"name": "demo.mp4", "url": VIDEO, "kind": "video"},
        {"name": "notes.pdf", "url": SP, "kind": "<script>"},
    ]}])
    msgs, _ = driver.read_history(DM, 30)
    assert msgs[0].files == [FileRef(name="demo.mp4", url=VIDEO, kind="video"), FileRef(name="notes.pdf", url=SP)]


def _linker(monkeypatch, reply):
    driver = WebBridgeDriver()
    calls = []
    monkeypatch.setattr(driver, "_rpc", lambda op, timeout=None, **a: calls.append((op, a)) or reply)
    return driver, calls


def test_file_link_resolves_in_the_page_and_keeps_sharepoint_links_only(monkeypatch):
    driver, calls = _linker(monkeypatch, {"ok": True, "name": "demo.mp4", "size": 2048, "mime": "video/mp4", "url": DOWNLOAD})
    assert driver.file_link(VIDEO) == {"name": "demo.mp4", "size": 2048, "mime": "video/mp4", "url": DOWNLOAD}
    assert calls == [("filelink", {"url": VIDEO})]  # no gesture: the conversation is not opened

    driver, _ = _linker(monkeypatch, {"ok": True, "name": "x", "url": "https://evil.example.com/x.mp4"})
    with pytest.raises(BridgeUnavailable):
        driver.file_link(VIDEO)
    driver, _ = _linker(monkeypatch, {"ok": False, "error": "accès au fichier refusé"})
    with pytest.raises(BridgeUnavailable, match="accès au fichier refusé"):
        driver.file_link(VIDEO)


def test_file_link_refuses_a_link_outside_sharepoint_without_asking_the_page(monkeypatch):
    driver, calls = _linker(monkeypatch, {"ok": True})
    with pytest.raises(ValueError):
        driver.file_link("https://evil.example.com/x.mp4")
    assert calls == []


def test_file_link_api(make_client):
    client, _watcher, _driver = make_client(driver=AttachDriver(interval=9999))
    res = client.post("/api/files/link", json={"url": VIDEO}).json()
    assert res["ok"] and res["link"]["mime"] == "video/mp4" and res["link"]["url"].startswith("https://")
    bad = client.post("/api/files/link", json={"url": "https://evil.example.com/x.mp4"})
    assert bad.status_code == 422 and bad.json()["ok"] is False


def test_file_link_without_graph_auth_asks_for_the_conversation(monkeypatch):
    driver, _ = _linker(monkeypatch, {"ok": False, "reason": "no_auth", "error": "pas encore"})
    with pytest.raises(NeedsView):
        driver.file_link(VIDEO, DM)


class NeedsViewDriver(AttachDriver):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.link_calls = []

    def file_link(self, url, thread_id=None, show=False):
        self.link_calls.append((thread_id, show))
        if not show:
            raise NeedsView("Teams n'a pas encore ouvert de fichier")
        return {"name": "demo.mp4", "size": 1, "mime": "video/mp4", "url": DOWNLOAD}


def test_file_link_api_opens_the_conversation_only_when_the_page_needs_it(make_client):
    client, _watcher, driver = make_client(driver=NeedsViewDriver(interval=9999))
    res = client.post("/api/files/link", json={"url": VIDEO, "thread_id": DM}).json()
    assert res["ok"] and res["link"]["url"] == DOWNLOAD
    assert driver.link_calls == [(DM, False), (DM, True)]
    # Without its conversation, the file cannot be shown: a clear error, no gesture.
    driver.link_calls.clear()
    bad = client.post("/api/files/link", json={"url": VIDEO})
    assert bad.status_code == 502 and driver.link_calls == [(None, False)]
