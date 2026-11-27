from __future__ import annotations

import base64

from drivers.web_bridge import BridgeUnavailable, WebBridgeDriver

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 60
PHOTO = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()


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
