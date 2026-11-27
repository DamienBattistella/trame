from __future__ import annotations

import base64

from drivers.graph import GraphDriver
from drivers.mock import MockTeamsDriver
from drivers.web_bridge import BridgeUnavailable, WebBridgeDriver
from msgraph.client import BASE, GraphClient

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 60
PHOTO = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()


def graph_driver(answer):
    """Graph answers /me/photos/96x96/$value with (status, bytes); the page says it has no photo."""
    calls = []

    def transport(method, url, headers, body):
        calls.append(url[len(BASE):])
        return answer[0], {}, answer[1]

    page = MockTeamsDriver(interval=9999)
    page.my_photo = lambda: "data:image/png;base64,UEFHRQ=="
    client = GraphClient(lambda: "t0k3n", transport)
    return GraphDriver(page, lambda: client), calls


def test_graph_reads_the_profile_photo():
    driver, calls = graph_driver((200, JPEG))
    assert driver.my_photo() == PHOTO
    assert calls == ["/me/photos/96x96/$value"]


def test_no_photo_in_microsoft_365_falls_back_to_the_page():
    driver, _ = graph_driver((404, b'{"error": {"code": "ImageNotFound"}}'))
    assert driver.my_photo() == "data:image/png;base64,UEFHRQ=="


def test_not_an_image_falls_back_to_the_page():
    driver, _ = graph_driver((200, b"<html>"))
    assert driver.my_photo() == "data:image/png;base64,UEFHRQ=="


def test_bridge_returns_only_image_data_urls(monkeypatch):
    driver = WebBridgeDriver()
    answers = [{"ok": True, "photo": PHOTO}, {"ok": True, "photo": None},
               {"ok": True, "photo": "javascript:alert(1)"}, {"ok": False, "error": "bouton du profil introuvable"}]
    monkeypatch.setattr(driver, "_rpc", lambda op, timeout=None, **a: answers.pop(0) if op == "myphoto" else None)
    assert driver.my_photo() == PHOTO
    assert driver.my_photo() is None
    assert driver.my_photo() is None
    try:
        driver.my_photo()
        raise AssertionError("expected BridgeUnavailable")
    except BridgeUnavailable as e:
        assert "profil" in str(e)


def test_watcher_keeps_the_photo_and_reads_it_rarely(make_client):
    _client, watcher, driver = make_client()
    reads = []

    def photo():
        reads.append(1)
        return PHOTO

    driver.my_photo = photo
    watcher.apply_my_photo(force=True)
    assert watcher.state.my_photo == PHOTO
    watcher.apply_my_photo()  # within PHOTO_REFRESH: Teams is not asked again
    assert len(reads) == 1

    def down():
        raise BridgeUnavailable("Teams fermé")

    driver.my_photo = down
    watcher.apply_my_photo(force=True)  # Teams unreachable: the photo shown stays
    assert watcher.state.my_photo == PHOTO


def test_photo_is_in_the_state_sent_to_the_ui(make_client):
    client, watcher, _driver = make_client()
    watcher.state.my_photo = PHOTO
    assert client.get("/api/state").json()["my_photo"] == PHOTO
