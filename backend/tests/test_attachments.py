from __future__ import annotations
import base64
import threading
import time

import pytest

import attachments as attachmod
from drivers.base import SendUncertain
from drivers.web_bridge import WebBridgeDriver
from conftest import RefusingDriver
from models import IncomingMessage, Surface, WatchEntity

DM = "19:bb22@thread.v2"
DM_AUTO = "19:aa11@thread.v2"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def pdf(name: str = "rapport.pdf", size: int = 2048) -> dict:
    return {"name": name, "type": "application/pdf", "data": b64(b"%PDF" + b"x" * (size - 4))}


# --- validation ---

def test_parse_accepts_allowed_files():
    files = attachmod.parse([attachmod.AttachmentIn(**pdf()), attachmod.AttachmentIn(name="capture.PNG", data=b64(b"\x89PNG"))])
    assert [(f.name, f.size, f.mime) for f in files] == [("rapport.pdf", 2048, "application/pdf"), ("capture.PNG", 4, "application/octet-stream")]


@pytest.mark.parametrize("item,needle", [
    ({"name": "outil.exe", "data": b64(b"MZ")}, "non autorisé"),
    ({"name": "script.ps1", "data": b64(b"x")}, "non autorisé"),
    ({"name": "sans-extension", "data": b64(b"x")}, "non autorisé"),
    ({"name": "vide.txt", "data": ""}, "vide"),
    ({"name": "abime.txt", "data": "pas du base64 !"}, "illisible"),
])
def test_parse_refuses(item, needle):
    with pytest.raises(attachmod.AttachmentError, match=needle):
        attachmod.parse([attachmod.AttachmentIn(**item)])


def test_parse_keeps_only_the_file_name():
    # A path sent by mistake (or on purpose) never reaches Teams: only its last part.
    [f] = attachmod.parse([attachmod.AttachmentIn(name="C:\\Users\\x\\..\\secret\\note.txt", data=b64(b"a"))])
    assert f.name == "note.txt"
    [f] = attachmod.parse([attachmod.AttachmentIn(name="../../etc/plan.md", data=b64(b"a"))])
    assert f.name == "plan.md"


def test_parse_limits(monkeypatch):
    monkeypatch.setattr(attachmod, "MAX_FILE_BYTES", 100)
    monkeypatch.setattr(attachmod, "MAX_TOTAL_BYTES", 150)
    with pytest.raises(attachmod.AttachmentError, match="dépasse"):
        attachmod.parse([attachmod.AttachmentIn(**pdf(size=101))])
    with pytest.raises(attachmod.AttachmentError, match="au total"):
        attachmod.parse([attachmod.AttachmentIn(**pdf("a.pdf", 80)), attachmod.AttachmentIn(**pdf("b.pdf", 80))])
    with pytest.raises(attachmod.AttachmentError, match="3 fichiers au plus"):
        attachmod.parse([attachmod.AttachmentIn(**pdf(f"{i}.pdf", 10)) for i in range(4)])


# --- API ---

def test_attachments_info(make_client):
    client, _, _ = make_client()
    info = client.get("/api/attachments").json()
    assert info["can_attach"] is True and info["unsupported"] is None
    assert info["max_files"] == 3 and info["max_file_bytes"] == 10 * 1024 * 1024 and "pdf" in info["extensions"]


def test_send_with_files(make_client):
    client, watcher, driver = make_client()
    r = client.post(f"/api/threads/{DM}/send", json={"text": "Le rapport", "attachments": [pdf()]})
    assert r.json() == {"ok": True}
    assert driver.sent_files == [(DM, "Le rapport", [("rapport.pdf", 2048)])]
    assert driver.typed == []
    assert any(l.level == "sent" and "rapport.pdf" in l.text for l in watcher.state.logs)


def test_send_file_alone(make_client):
    client, _, driver = make_client()
    assert client.post(f"/api/threads/{DM}/send", json={"text": "  ", "attachments": [pdf()]}).json() == {"ok": True}
    assert driver.sent_files == [(DM, "", [("rapport.pdf", 2048)])]


def test_send_nothing_is_refused(make_client):
    client, _, driver = make_client()
    r = client.post(f"/api/threads/{DM}/send", json={"text": "", "attachments": []})
    assert r.status_code == 422 and driver.sent_files == [] and driver.typed == []


def test_send_refuses_bad_file_and_sends_nothing(make_client):
    client, _, driver = make_client()
    r = client.post(f"/api/threads/{DM}/send", json={"text": "Tiens", "attachments": [pdf(), {"name": "x.exe", "data": b64(b"MZ")}]})
    assert r.status_code == 422 and "Rien n'a été envoyé" in r.json()["error"]
    assert driver.sent_files == [] and driver.typed == [] and driver.opened == []


def test_send_draft_with_files(make_client):
    client, watcher, driver = make_client()
    watcher._process(IncomingMessage(thread_id=DM, sender="Lucas Bernard", text="Tu as le rapport ?",
                                     received_at="10:00", surface=Surface.dm))
    d = watcher.state.drafts[0]
    assert client.post(f"/api/drafts/{d.id}/send", json={"text": "Le voici", "attachments": [pdf()]}).json() == {"ok": True}
    assert driver.sent_files == [(DM, "Le voici", [("rapport.pdf", 2048)])]
    assert watcher.state.drafts == []


def test_send_with_files_refused_when_thread_not_confirmed(make_client):
    client, _, driver = make_client(driver=RefusingDriver(interval=9999))
    r = client.post(f"/api/threads/{DM}/send", json={"text": "x", "attachments": [pdf()]})
    assert r.status_code == 409 and "Rien n'a été envoyé" in r.json()["error"]
    assert driver.sent_files == []


def test_driver_without_attachments(make_client):
    from drivers.mock import MockTeamsDriver

    class TextOnly(MockTeamsDriver):
        can_attach = False
        attach_unsupported = "pilote de test sans pièces jointes"

    client, _, driver = make_client(driver=TextOnly(interval=9999))
    info = client.get("/api/attachments").json()
    assert info["can_attach"] is False and info["unsupported"] == "pilote de test sans pièces jointes"
    r = client.post(f"/api/threads/{DM}/send", json={"text": "x", "attachments": [pdf()]})
    assert r.status_code == 501 and "pilote de test sans pièces jointes" in r.json()["error"]
    assert driver.typed == [] and driver.opened == []


def test_uncertain_send_with_files_is_never_reported_as_sent(make_client):
    from drivers.mock import MockTeamsDriver

    class Unsure(MockTeamsDriver):
        def _send_files_into_active(self, thread_id, text, files, reply_to=None):
            raise SendUncertain("pièce jointe non visible")

    client, watcher, _ = make_client(driver=Unsure(interval=9999))
    r = client.post(f"/api/threads/{DM}/send", json={"text": "x", "attachments": [pdf()]})
    assert r.status_code == 409
    assert "peut-être partis" in r.json()["error"] and "Vérifie dans Teams" in r.json()["error"]
    assert not any(l.level == "sent" for l in watcher.state.logs)


def test_auto_mode_never_attaches(make_client):
    _, watcher, driver = make_client()
    watcher._process(IncomingMessage(thread_id=DM_AUTO, sender="Sofia Marino", text="Le build passe ?",
                                     received_at="10:00", surface=Surface.dm))
    assert driver.sent_files == []
    with pytest.raises(ValueError):
        watcher._deliver(DM_AUTO, "x", send=True, restore=True, auto=True, files=attachmod.parse([attachmod.AttachmentIn(**pdf())]))
    with pytest.raises(ValueError):
        watcher._deliver(DM_AUTO, "x", send=False, restore=False, files=attachmod.parse([attachmod.AttachmentIn(**pdf())]))
    assert driver.sent_files == []


# --- Teams intégré: what reaches the page ---

class FilePage:
    def __init__(self, client, answer_type):
        self.client, self.title, self.cmds, self.stop = client, "Chat | Autre | Microsoft Teams", [], False
        self.answer_type = answer_type
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def answer(self, cmd):
        op, a = cmd["op"], cmd["args"]
        self.cmds.append(cmd)
        if op == "title":
            return self.title
        if op == "open":
            self.title = f"Chat | {a['name']} | Microsoft Teams"
            return {"ok": True, "title": self.title}
        if op == "type":
            return self.answer_type(a)
        return None

    def loop(self):
        while not self.stop:
            cmd = self.client.get("/api/teams-web/poll").json()["command"]
            if cmd:
                self.client.post("/api/teams-web/reply", json={"id": cmd["id"], "ok": True, "result": self.answer(cmd)})


@pytest.fixture
def bridge(make_client, monkeypatch):
    monkeypatch.setattr(WebBridgeDriver, "RPC_TIMEOUT", 3.0)
    monkeypatch.setattr(WebBridgeDriver, "POLL_WAIT", 0.5)
    pages = []

    def _make(answer_type):
        driver = WebBridgeDriver()
        client, watcher, _ = make_client(driver=driver)
        page = FilePage(client, answer_type)
        driver._last_poll = time.monotonic()
        driver._names["name:Romain CUREAU"] = "Romain CUREAU"
        watcher.state.watchlist = [WatchEntity(thread_id="name:Romain CUREAU", display_name="Romain CUREAU", surface=Surface.dm)]
        page.thread.start()
        pages.append(page)
        return client, watcher, page

    yield _make
    for p in pages:
        p.stop = True
    for p in pages:
        p.thread.join(3)


def test_bridge_sends_file_bytes_only(bridge):
    client, _, page = bridge(lambda a: {"ok": True})
    r = client.post("/api/threads/name%3ARomain%20CUREAU/send", json={"text": "Voici", "attachments": [pdf(size=16)]})
    assert r.json() == {"ok": True}
    [typed] = [c for c in page.cmds if c["op"] == "type"]
    assert typed["args"]["send"] is True and typed["args"]["text"] == "Voici"
    [f] = typed["args"]["files"]
    # Name, type and content travel; never a path to read.
    assert set(f) == {"name", "type", "data"} and f["name"] == "rapport.pdf"
    assert base64.b64decode(f["data"]) == b"%PDF" + b"x" * 12
    assert typed["deadline"] - time.time() > 30


def test_bridge_uncertain_attachment(bridge):
    client, watcher, _ = bridge(lambda a: {"ok": False, "uncertain": True, "error": "pièce jointe non visible"})
    r = client.post("/api/threads/name%3ARomain%20CUREAU/send", json={"text": "Voici", "attachments": [pdf()]})
    assert r.status_code == 409 and "peut-être partis" in r.json()["error"]


def test_bridge_attachment_refused_by_teams(bridge):
    client, _, _ = bridge(lambda a: {"ok": False, "error": "Teams n'a pas pris la pièce jointe"})
    r = client.post("/api/threads/name%3ARomain%20CUREAU/send", json={"text": "Voici", "attachments": [pdf()]})
    assert r.status_code == 409
    assert "Rien n'a été envoyé" in r.json()["error"] and "Teams n'a pas pris la pièce jointe" in r.json()["error"]


def test_bridge_text_only_send_carries_no_files(bridge):
    client, _, page = bridge(lambda a: {"ok": True})
    assert client.post("/api/threads/name%3ARomain%20CUREAU/send", json={"text": "Salut"}).json() == {"ok": True}
    [typed] = [c for c in page.cmds if c["op"] == "type"]
    assert "files" not in typed["args"]


def test_bridge_file_in_reply_to_a_message(bridge):
    client, _, page = bridge(lambda a: {"ok": True})
    ref = {"id": "content-1", "sender": "Romain CUREAU", "text": "Tu as le rapport ?"}
    r = client.post("/api/threads/name%3ARomain%20CUREAU/send",
                    json={"text": "Le voici", "reply_to": ref, "attachments": [pdf()]})
    assert r.json() == {"ok": True}
    [typed] = [c for c in page.cmds if c["op"] == "type"]
    assert typed["args"]["quote"]["text"] == "Tu as le rapport ?"
    assert [f["name"] for f in typed["args"]["files"]] == ["rapport.pdf"]


def test_files_with_mentions_refused_and_nothing_sent(make_client):
    client, _, driver = make_client()
    r = client.post(f"/api/threads/{DM}/send",
                    json={"text": "@Lucas Bernard voici", "mentions": ["Lucas Bernard"], "attachments": [pdf()]})
    assert r.status_code == 422 and "mention" in r.json()["error"]
    assert driver.sent_files == [] and driver.typed == [] and driver.opened == []
