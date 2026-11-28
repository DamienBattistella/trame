from __future__ import annotations

import base64

from drivers.web_bridge import BridgeUnavailable, WebBridgeDriver
from models import Surface, WatchEntity

PHOTO = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 60).decode()
OTHER = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe1" + b"\x01" * 60).decode()
DM = "19:aaa_bbb@unq.gbl.spaces"
GROUP = "19:ccc@thread.v2"


def test_bridge_keeps_only_the_photos_of_people(monkeypatch):
    driver = WebBridgeDriver()
    calls = []

    def rpc(op, timeout=None, **a):
        calls.append((op, a))
        return {"ok": True, "photos": [
            {"id": f"chat-list-item_{DM}", "label": "Chat Ana Martin", "photo": PHOTO},
            {"id": f"chat-list-item_{GROUP}", "label": "Chat Projet", "photo": PHOTO},
            {"id": "menurmh", "label": "Chat Paul", "photo": PHOTO},
            {"id": "19:ddd_eee@unq.gbl.spaces", "label": "Chat Marc", "photo": "javascript:alert(1)"},
            {"id": "19:fff_ggg@unq.gbl.spaces", "label": "Chat Léa", "photo": "data:image/jpeg;base64," + "A" * 50_000},
        ]}

    monkeypatch.setattr(driver, "_rpc", rpc)
    assert driver.people_photos() == {DM: PHOTO}
    driver.people_photos([DM])
    assert calls[-1] == ("photos", {"known": [f"chat-list-item_{DM}"]})

    monkeypatch.setattr(driver, "_rpc", lambda op, timeout=None, **a: {"ok": False, "error": "liste introuvable"})
    try:
        driver.people_photos()
        raise AssertionError("expected BridgeUnavailable")
    except BridgeUnavailable as e:
        assert "liste" in str(e)


def test_watcher_keeps_photos_read_earlier_and_serves_them_by_name(make_client):
    client, watcher, driver = make_client()
    watcher.state.watchlist = [WatchEntity(thread_id=DM, display_name="Ana Martin", surface=Surface.dm),
                               WatchEntity(thread_id="19:x_y@unq.gbl.spaces", display_name="Paul Roux", surface=Surface.dm)]
    asked = []

    def photos(known=()):
        asked.append(tuple(known))
        return {DM: PHOTO}

    driver.people_photos = photos
    watcher.apply_people_photos(force=True)
    rev = watcher.state.photos_rev
    assert rev == 1 and client.get("/api/state").json()["photos_rev"] == rev
    assert client.get("/api/photos").json() == {"rev": rev, "photos": {"Ana Martin": PHOTO}}

    # Within the interval Teams is not asked again; a row no longer drawn keeps its photo.
    watcher.apply_people_photos()
    assert len(asked) == 1
    driver.people_photos = lambda known=(): {}
    watcher.apply_people_photos(force=True)
    assert watcher.state.photos_rev == rev
    assert client.get("/api/photos").json()["photos"] == {"Ana Martin": PHOTO}

    # A new photo replaces the old one and the UI is told to read again.
    driver.people_photos = lambda known=(): {DM: OTHER}
    watcher.apply_people_photos(force=True)
    assert watcher.state.photos_rev == rev + 1
    assert client.get("/api/photos").json()["photos"] == {"Ana Martin": OTHER}

    def down(known=()):
        raise BridgeUnavailable("Teams fermé")

    driver.people_photos = down
    watcher.apply_people_photos(force=True)
    assert client.get("/api/photos").json()["photos"] == {"Ana Martin": OTHER}
