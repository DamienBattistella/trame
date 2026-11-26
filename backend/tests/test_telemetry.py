from __future__ import annotations
import json

import pytest

import telemetry
from conftest import FakeBrain
from models import IncomingMessage, Surface


@pytest.fixture(autouse=True)
def _off():
    yield
    telemetry.configure({"enabled": False})


def _lines(path):
    telemetry.flush()
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def test_settings_turn_on_local_file_export_without_message_text(make_client, fresh_home):
    client, watcher, _ = make_client()
    r = client.put("/api/settings", json={"telemetry": {"enabled": True, "endpoint": ""}})
    assert r.status_code == 200 and r.json()["settings"]["telemetry"]["enabled"] is True
    msg = IncomingMessage(thread_id="19:bb22@thread.v2", sender="Lucas Bernard", text="Code secret 1234",
                          received_at="10:00", surface=Surface.dm)
    assert watcher._process(msg) == "draft"
    watcher.log("sent", "Envoyé à Lucas Bernard : « Code secret 1234 »")
    records = _lines(fresh_home / "otel.jsonl")
    names = {r.get("name") for r in records}
    assert {"trame.message", "trame.brain.draft"} <= names
    raw = json.dumps(records, ensure_ascii=False)
    for r in records:
        if "Code secret" in json.dumps(r, ensure_ascii=False):
            print("LEAK", json.dumps(r, ensure_ascii=False)[:700])
    assert "Code secret 1234" not in raw and "«…»" in raw
    span = next(r for r in records if r.get("name") == "trame.message")
    assert span["attributes"]["trame.outcome"] == "draft" and span["resource"]["attributes"]["service.name"] == "trame"


def test_content_only_when_allowed(make_client, fresh_home):
    client, watcher, _ = make_client()
    client.put("/api/settings", json={"telemetry": {"enabled": True, "include_content": True}})
    watcher.log("sent", "Envoyé à Lucas : « bonjour »")
    assert "« bonjour »" in json.dumps(_lines(fresh_home / "otel.jsonl"), ensure_ascii=False)


def test_invalid_endpoint_refused(make_client):
    client, _w, _ = make_client()
    r = client.put("/api/settings", json={"telemetry": {"enabled": True, "endpoint": "pas une url"}})
    assert r.status_code == 422
