from __future__ import annotations

from collections import namedtuple
from pathlib import Path

import health as h
from drivers.mock import MockTeamsDriver
from models import QueuedSend

Usage = namedtuple("Usage", "total used free")
GB = 1024**3


class RelayDown(MockTeamsDriver):
    def relay_connected(self) -> bool:
        return False


def _items(r):
    return {i["key"]: i for i in r["items"]}


def test_health_lists_every_point(make_client):
    client, _watcher, _ = make_client()
    r = client.get("/api/health").json()
    assert r["ok"] and r["status"] in ("ok", "warn", "error", "unknown")
    assert set(_items(r)) == {"teams", "page", "outbox", "brain", "pause", "disk"}
    assert _items(r)["teams"]["status"] == "ok" and _items(r)["outbox"]["status"] == "ok"
    assert _items(r)["page"]["status"] == "unknown"  # never checked with the mock driver


def test_relay_down_is_an_error(make_client):
    client, _w, _ = make_client(driver=RelayDown(interval=9999))
    r = client.get("/api/health").json()
    assert _items(r)["teams"]["status"] == "error" and r["status"] == "error"


def test_outbox_and_brain_failures_show(make_client):
    client, watcher, _ = make_client()
    watcher.state.outbox = [QueuedSend(id="a", thread_id="t", conversation="Lucas", text="x", queued_at="10:00",
                                       status="failed"),
                            QueuedSend(id="b", thread_id="t", conversation="Lucas", text="y", queued_at="10:01")]
    watcher._brain_error = "10:02 · délai dépassé"
    items = _items(client.get("/api/health").json())
    assert items["outbox"]["status"] == "warn" and "1 non envoyé" in items["outbox"]["detail"]
    assert items["brain"]["status"] == "warn" and "délai dépassé" in items["brain"]["detail"]


def test_disk_thresholds(monkeypatch):
    for free, want in ((0.5 * GB, "error"), (3 * GB, "warn"), (50 * GB, "ok")):
        monkeypatch.setattr(h.shutil, "disk_usage", lambda p, f=free: Usage(931 * GB, 0, int(f)))
        assert h.disk(Path("C:/")).status == want
    monkeypatch.setattr(h.shutil, "disk_usage", lambda p: (_ for _ in ()).throw(OSError("refusé")))
    assert h.disk(Path("C:/")).status == "unknown"


def test_overall_is_the_worst():
    mk = lambda s: h.HealthItem(key=s, label=s, status=s, detail="")
    assert h.overall([mk("ok"), mk("warn")]) == "warn"
    assert h.overall([mk("ok"), mk("unknown")]) == "unknown"
    assert h.overall([mk("warn"), mk("error")]) == "error"
    assert h.overall([mk("ok")]) == "ok"
