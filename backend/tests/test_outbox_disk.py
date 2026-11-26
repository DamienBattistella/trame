"""La file d'envoi survit à un redémarrage du moteur : chaque test recrée le watcher sur
le même dossier de Trame, comme un nouveau lancement."""
from __future__ import annotations

import base64
import json
import time

import config as cfgmod
import outbox_store
from attachments import Attachment
from models import QueuedSend
from tests.test_outbox import DM, SEND, RelayDriver, _client

PDF = b"%PDF-1.4 " + b"x" * 2039


def _pdf(name: str = "rapport.pdf") -> dict:
    return {"name": name, "type": "application/pdf", "data": base64.b64encode(PDF).decode("ascii")}


def _folder():
    return cfgmod.HOME / "outbox"


def _restart(make_client):
    return _client(make_client, RelayDriver(interval=9999))


def test_waiting_messages_survive_a_restart_and_leave_once_in_order(make_client):
    client, watcher, _ = _restart(make_client)
    client.post(SEND, json={"text": "Premier"})
    client.post(SEND, json={"text": "Second"})
    assert [x.text for x in watcher.state.outbox] == ["Premier", "Second"]

    client2, watcher2, driver2 = _restart(make_client)  # Trame relancé
    assert [(x.text, x.status) for x in watcher2.state.outbox] == [("Premier", "waiting"), ("Second", "waiting")]
    assert any("2 messages repris" in l.text for l in watcher2.state.logs)
    driver2.relay = True
    watcher2.flush_outbox()
    watcher2.flush_outbox()
    assert [t[1] for t in driver2.typed] == ["Premier", "Second"] and watcher2.state.outbox == []

    _, watcher3, driver3 = _restart(make_client)  # parti : plus rien à reprendre
    assert watcher3.state.outbox == []


def test_sending_at_stop_comes_back_uncertain_and_is_never_resent(make_client):
    client, watcher, _ = _restart(make_client)
    client.post(SEND, json={"text": "Peut-être parti"})
    client.post(SEND, json={"text": "Derrière"})
    watcher._outbox_update(watcher.state.outbox[0], status="sending", attempts=1)

    _, watcher2, driver2 = _restart(make_client)
    first, second = watcher2.state.outbox
    assert first.status == "uncertain" and "vérifie dans Teams" in first.reason
    driver2.relay = True
    watcher2.flush_outbox()
    # Ni le message incertain ni celui qui le suit dans la conversation ne partent seuls.
    assert driver2.typed == [] and second.status == "waiting"


def test_age_counts_across_restarts(make_client):
    client, watcher, _ = _restart(make_client)
    item = client.post(SEND, json={"text": "Vieux"}).json()["queued"]
    with watcher._lock:
        watcher._outbox_payload[item["id"]]["since"] -= watcher.OUTBOX_MAX_AGE + 60
        watcher._outbox_save()

    _, watcher2, driver2 = _restart(make_client)
    driver2.relay = True
    watcher2.flush_outbox()
    assert driver2.typed == [] and watcher2.state.outbox[0].status == "failed"


def test_attachments_come_back_then_are_deleted_once_sent(make_client):
    client, watcher, _ = _restart(make_client)
    client.post(SEND, json={"text": "Le rapport", "attachments": [_pdf()]})
    blobs = list(_folder().glob("*.bin"))
    assert len(blobs) == 1 and blobs[0].read_bytes() == PDF
    # L'index ne garde que l'empreinte, jamais le contenu du fichier.
    assert "eCB4" not in (_folder() / "outbox.json").read_text(encoding="utf-8")

    _, watcher2, driver2 = _restart(make_client)
    assert watcher2.state.outbox[0].files == ["rapport.pdf"]
    driver2.relay = True
    watcher2.flush_outbox()
    assert driver2.sent_files == [(DM, "Le rapport", [("rapport.pdf", len(PDF))])]
    assert list(_folder().glob("*.bin")) == []


def test_cancel_deletes_the_attachments(make_client):
    client, watcher, _ = _restart(make_client)
    item = client.post(SEND, json={"text": "Annulé", "attachments": [_pdf()]}).json()["queued"]
    client.post(f"/api/outbox/{item['id']}/cancel")
    assert list(_folder().glob("*.bin")) == []
    _, watcher2, _ = _restart(make_client)
    assert watcher2.state.outbox == []


def test_corrupt_attachment_fails_the_message_and_keeps_nothing(make_client):
    client, watcher, _ = _restart(make_client)
    item = client.post(SEND, json={"text": "Le rapport", "attachments": [_pdf()]}).json()["queued"]
    next(_folder().glob("*.bin")).write_bytes(b"abime")

    client2, watcher2, driver2 = _restart(make_client)
    restored = watcher2.state.outbox[0]
    assert restored.status == "failed" and "« rapport.pdf » illisible" in restored.reason
    assert list(_folder().glob("*.bin")) == []
    # Renvoyer le texte seul perdrait le fichier : refusé, l'utilisateur renvoie lui-même.
    assert client2.post(f"/api/outbox/{item['id']}/retry").status_code == 409
    driver2.relay = True
    watcher2.flush_outbox()
    assert driver2.typed == [] and driver2.sent_files == []
    _, watcher3, _ = _restart(make_client)
    assert watcher3.state.outbox[0].status == "failed"


def test_missing_attachment_also_fails(make_client):
    client, _, _ = _restart(make_client)
    client.post(SEND, json={"text": "Le rapport", "attachments": [_pdf()]})
    next(_folder().glob("*.bin")).unlink()
    _, watcher2, _ = _restart(make_client)
    assert watcher2.state.outbox[0].status == "failed"


def test_corrupt_index_is_ignored_cleanly(make_client):
    client, _, _ = _restart(make_client)
    client.post(SEND, json={"text": "Le rapport", "attachments": [_pdf()]})
    (_folder() / "outbox.json").write_text("{pas du json", encoding="utf-8")

    client2, watcher2, driver2 = _restart(make_client)
    assert watcher2.state.outbox == []
    assert any("illisible" in l.text for l in watcher2.state.logs)
    assert list(_folder().iterdir()) == []  # ni index abîmé ni pièce jointe orpheline
    # La file repart normalement.
    client2.post(SEND, json={"text": "Nouveau"})
    driver2.relay = True
    watcher2.flush_outbox()
    assert [t[1] for t in driver2.typed] == ["Nouveau"]


def test_invalid_entry_is_skipped_others_kept(make_client):
    client, _, _ = _restart(make_client)
    client.post(SEND, json={"text": "Bon"})
    index = _folder() / "outbox.json"
    raw = json.loads(index.read_text(encoding="utf-8"))
    raw["items"].insert(0, {"item": {"id": "../../x", "text": 3}})
    index.write_text(json.dumps(raw), encoding="utf-8")
    _, watcher2, _ = _restart(make_client)
    assert [x.text for x in watcher2.state.outbox] == ["Bon"]


def test_total_attachment_size_is_limited(make_client, monkeypatch):
    client, watcher, driver = _restart(make_client)
    monkeypatch.setattr(watcher._outbox_store, "max_bytes", len(PDF) + 10)
    assert client.post(SEND, json={"text": "Un", "attachments": [_pdf()]}).json()["ok"]
    r = client.post(SEND, json={"text": "Deux", "attachments": [_pdf("autre.pdf")]})
    assert r.status_code == 413 and "pleine" in r.json()["error"]
    assert len(watcher.state.outbox) == 1 and len(list(_folder().glob("*.bin"))) == 1


def test_atomic_write_keeps_the_previous_index_when_interrupted(tmp_path, monkeypatch):
    store = outbox_store.OutboxStore(tmp_path)
    item = QueuedSend(id="abc123", thread_id=DM, conversation="Lucas", text="Avant", queued_at="10:00")
    payload = {"abc123": {"mentions": [], "since": time.monotonic()}}
    store.save([item], payload)
    before = store.index.read_bytes()

    def crash(_src, _dst):
        raise OSError("arrêt brutal")

    monkeypatch.setattr(outbox_store.os, "replace", crash)
    try:
        store.save([item.model_copy(update={"text": "Après"})], payload)
    except OSError:
        pass
    assert store.index.read_bytes() == before
    monkeypatch.undo()
    # Le temporaire abandonné ne fait pas obstacle et ne survit pas à la relecture.
    restored = store.load()
    assert [x.text for x in restored.items] == ["Avant"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["outbox.json"]


def test_store_roundtrip_with_files(tmp_path):
    store = outbox_store.OutboxStore(tmp_path)
    files = [Attachment(name="a.png", mime="image/png", data=b"\x89PNG"), Attachment(name="b.txt", mime="text/plain", data=b"hi")]
    meta = store.add_files("abc123", files, used=0)
    item = QueuedSend(id="abc123", thread_id=DM, conversation="Lucas", text="", files=["a.png", "b.txt"],
                      queued_at="10:00")
    store.save([item], {"abc123": {"mentions": [], "meta": meta, "since": time.monotonic()}})
    restored = store.load()
    assert restored.payload["abc123"]["files"] == files
    store.remove_files("abc123")
    assert [p.name for p in tmp_path.iterdir()] == ["outbox.json"]
