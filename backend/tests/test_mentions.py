from __future__ import annotations

from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver

GROUP = "19:cc33@thread.v2"
SEND = "/api/threads/19%3Acc33%40thread.v2/send"


class NoMentionDriver(MockTeamsDriver):
    supports_mentions = False


def test_send_with_mentions_reaches_the_driver(make_client):
    client, _watcher, driver = make_client()
    text = "@Sofia Marino tu vois avec @Lucas Bernard ?"
    r = client.post(SEND, json={"text": text, "mentions": ["Sofia Marino", "Lucas Bernard", "sofia marino"]})
    assert r.json() == {"ok": True}
    # Duplicates dropped, order kept, the text unchanged.
    assert driver.mentioned == [(GROUP, text, ["Sofia Marino", "Lucas Bernard"], True)]


def test_plain_send_does_not_go_through_mentions(make_client):
    client, _watcher, driver = make_client()
    assert client.post(SEND, json={"text": "Salut à tous"}).json() == {"ok": True}
    assert driver.mentioned == [] and driver.typed[-1] == (GROUP, "Salut à tous", True)


def test_mention_missing_from_text_is_refused_before_typing(make_client):
    client, _watcher, driver = make_client()
    r = client.post(SEND, json={"text": "Salut Sofia", "mentions": ["Sofia Marino"]})
    assert r.status_code == 422 and "@Sofia Marino" in r.json()["error"]
    assert driver.typed == [] and driver.opened == []


def test_too_many_mentions_refused(make_client):
    client, _watcher, driver = make_client()
    names = [f"Personne {i}" for i in range(11)]
    r = client.post(SEND, json={"text": " ".join("@" + n for n in names), "mentions": names})
    assert r.status_code == 422 and driver.typed == []


def test_driver_without_mentions_refuses_up_front(make_client):
    client, watcher, driver = make_client(driver=NoMentionDriver(interval=9999))
    assert watcher.state.capabilities.mentions is False
    r = client.post(SEND, json={"text": "@Sofia Marino ok ?", "mentions": ["Sofia Marino"]})
    assert r.status_code == 501 and driver.typed == []


def test_draft_send_with_mentions(make_client):
    from models import IncomingMessage, Surface

    client, watcher, driver = make_client()
    watcher._process(IncomingMessage(thread_id=GROUP, sender="Sofia Marino", text="@Damien on garde 14h ?",
                                     received_at="10:00", surface=Surface.group, mentions=["Damien"]), force_draft=True)
    draft = next(d for d in watcher.state.drafts if d.thread_id == GROUP)
    text = "@Sofia Marino oui, 14h me va."
    r = client.post(f"/api/drafts/{draft.id}/send", json={"text": text, "mentions": ["Sofia Marino"]})
    assert r.json() == {"ok": True} and driver.mentioned[-1] == (GROUP, text, ["Sofia Marino"], True)


def test_web_bridge_sends_mentions_with_more_time(monkeypatch):
    driver = WebBridgeDriver()
    driver._names = {GROUP: "Démo interop"}
    calls = []

    def rpc(op, timeout=None, **args):
        calls.append((op, timeout, args))
        return {"ok": True}

    monkeypatch.setattr(driver, "_rpc", rpc)
    assert driver._type_with_mentions(GROUP, "@Ana Lopez et @Marc ?", True, ["Ana Lopez", "Marc"])
    op, timeout, args = calls[0]
    assert op == "type" and args["mentions"] == ["Ana Lopez", "Marc"] and timeout == 15 + 12
