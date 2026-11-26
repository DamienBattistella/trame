from __future__ import annotations

from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver
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
    assert msgs[0]["files"] == [{"name": "rapport.pdf", "url": SP}] and msgs[0]["images"] == []
    assert msgs[1]["text"] == "" and msgs[1]["images"] == [{"data": JPEG, "width": 800, "height": 262}]


def test_brain_gets_words_not_image_data(make_client):
    _client, watcher, _driver = make_client(driver=AttachDriver(interval=9999))
    msgs = watcher._read_focused(DM, "Lucas Bernard", 30)
    assert msgs[0].text == "Voici le rapport\n[fichier joint : rapport.pdf]"
    assert msgs[1].text == "[image]" and msgs[1].images == []
