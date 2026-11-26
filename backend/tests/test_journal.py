"""Activité kept across restarts: search, level and date filters, paging, export."""
import json

from journal import Journal, local_iso
from models import LogItem


def _item(ts: str, level: str, text: str) -> LogItem:
    return LogItem(ts=ts, at=ts[11:19], level=level, text=text)


def test_search_ignores_case_and_accents_and_filters(tmp_path):
    j = Journal(tmp_path / "journal.jsonl")
    j.append(_item("2026-11-25T09:00:00.000000", "info", "Teams connecté"))
    j.append(_item("2026-11-26T10:00:00.000000", "warn", "Lecture impossible pour Chloé Julenon : délai dépassé"))
    j.append(_item("2026-11-26T11:00:00.000000", "sent", "Envoyé à Chloé Julenon"))
    assert [i.level for i in j.query("CHLOE")["items"]] == ["sent", "warn"]
    assert [i.text for i in j.query("chloe", ["warn"])["items"]] == ["Lecture impossible pour Chloé Julenon : délai dépassé"]
    assert j.query("", None, since="2026-11-26T00:00:00")["total"] == 2
    assert j.query("introuvable")["items"] == []


def test_paging_with_cursor(tmp_path):
    j = Journal(tmp_path / "journal.jsonl")
    for n in range(7):
        j.append(_item(f"2026-11-26T10:00:0{n}.000000", "info", f"ligne {n}"))
    first = j.query(limit=3)
    assert [i.text for i in first["items"]] == ["ligne 6", "ligne 5", "ligne 4"] and first["total"] == 7
    second = j.query(limit=3, before=first["next"])
    assert [i.text for i in second["items"]] == ["ligne 3", "ligne 2", "ligne 1"]
    last = j.query(limit=3, before=second["next"])
    assert [i.text for i in last["items"]] == ["ligne 0"] and last["next"] is None


def test_survives_restart_masks_quotes_on_disk_and_stays_bounded(tmp_path):
    path = tmp_path / "journal.jsonl"
    j = Journal(path, max_entries=5)
    j.append(_item("2026-11-26T10:00:00.000000", "sent", "Envoyé à Lucas : « mot de passe 1234 »"))
    assert "mot de passe" in j.query("lucas")["items"][0].text  # this session: shown in full
    assert "mot de passe" not in path.read_text(encoding="utf-8")
    for n in range(20):
        j.append(_item(f"2026-11-26T11:00:{n:02d}.000000", "info", f"ligne {n}"))
    assert len(path.read_text(encoding="utf-8").splitlines()) <= 10
    again = Journal(path, max_entries=5)
    assert [i.text for i in again.query()["items"]][:2] == ["ligne 19", "ligne 18"]
    assert again.query()["total"] == 5
    path.write_text("pas du json\n" + json.dumps({"ts": "2026-11-26T12:00:00", "level": "warn", "text": "ok"}) + "\n", encoding="utf-8")
    assert [i.text for i in Journal(path).query()["items"]] == ["ok"]


def test_local_iso_reads_utc_and_rejects_garbage():
    assert local_iso("2026-11-26T10:00:00").startswith("2026-11-26T10:00:00")
    assert local_iso("2026-11-26T10:00:00Z") is not None and local_iso("hier") is None and local_iso("") is None


def test_logs_endpoint_and_filtered_export(make_client):
    client, watcher, _driver = make_client()
    watcher.log("warn", "Lecture impossible pour Chloé Julenon : délai dépassé")
    watcher.log("sent", "Envoyé à Lucas : « mot de passe 1234 »")
    r = client.get("/api/logs", params={"q": "chloe"}).json()
    assert r["ok"] and r["total"] == 1 and r["items"][0]["level"] == "warn" and r["items"][0]["ts"]
    r = client.get("/api/logs", params={"levels": "sent,draft"}).json()
    assert [i["text"][:10] for i in r["items"]] == ["Envoyé à L"]
    assert client.get("/api/logs", params={"since": "2999-01-01T00:00:00Z"}).json()["total"] == 0
    exp = client.get("/api/logs/export", params={"levels": "sent"}).json()
    assert exp["filename"].startswith("trame-activite-") and "# Trame : activité filtrée" in exp["text"]
    assert "Envoyé à Lucas" in exp["text"] and "mot de passe" not in exp["text"] and "Chloé" not in exp["text"]
    assert client.get("/api/logs/export").json()["filename"].startswith("trame-journaux-")


def test_factory_reset_forgets_the_journal(make_client, fresh_home):
    client, watcher, _driver = make_client()
    watcher.log("info", "avant la remise à zéro")
    watcher.factory_reset()
    assert client.get("/api/logs", params={"q": "avant la remise"}).json()["total"] == 0
