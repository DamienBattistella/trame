"""Transcriptions de réunion : WebVTT, nommage, API, MCP et pilote Teams intégré.
Toutes les données sont fictives."""
from __future__ import annotations
import json
import threading
from datetime import date
from pathlib import Path

import pytest

import transcripts as t
from drivers.web_bridge import WebBridgeDriver
from models import Surface, WatchEntity


@pytest.fixture(autouse=True)
def transcripts_dir(tmp_path, monkeypatch):
    """Jamais le vrai dossier Documents ni l'Explorateur dans les tests."""
    folder = tmp_path / "Transcriptions"
    monkeypatch.setattr(t, "default_dir", lambda: folder)
    import os
    monkeypatch.setattr(os, "startfile", lambda _p: None, raising=False)
    return folder


# --- horodatages ---------------------------------------------------------------
@pytest.mark.parametrize("raw,expected", [
    ("0:16", 16.0), ("1:29", 89.0), ("12:05", 725.0), ("1:02:03", 3723.0), ("01:00:00", 3600.0),
    ("0 minutes 16 secondes", 16.0), ("1 heure 2 minutes 3 secondes", 3723.0), ("1 minute 29 seconds", 89.0),
    ("", None), ("bonjour", None), ("1:75", None), ("1:61:00", None),
])
def test_parse_offset(raw, expected):
    assert t.parse_offset(raw) == expected


@pytest.mark.parametrize("seconds,expected", [
    (0, "00:00:00.000"), (16, "00:00:16.000"), (89.5, "00:01:29.500"), (3723.004, "01:02:03.004"), (-3, "00:00:00.000"),
])
def test_format_timestamp(seconds, expected):
    assert t.format_timestamp(seconds) == expected


# --- entrées -> prises de parole ---------------------------------------------------
def test_cues_merge_continuations_and_skip_empty():
    cues = t.cues_from_entries([
        {"speaker": "Sofia Marino", "time": "0:03", "text": "Bonjour à tous."},
        {"speaker": "", "time": "", "text": "On commence par l'interop."},
        {"speaker": "Lucas Bernard", "time": "0:12", "text": "   "},
        {"speaker": "Lucas Bernard", "time": "0:20", "text": "Ça marche."},
        "pas un dict",
    ])
    assert [(c.speaker, c.start, c.text) for c in cues] == [
        ("Sofia Marino", 3.0, "Bonjour à tous. On commence par l'interop."),
        ("Lucas Bernard", 20.0, "Ça marche."),
    ]
    # Une prise de parole dure jusqu'à la suivante ; la dernière, au débit de parole.
    assert cues[0].end == 20.0
    assert cues[1].end == pytest.approx(21.0)


def test_cues_long_pause_and_disorder():
    cues = t.cues_from_entries([
        {"speaker": "A", "time": "0:10", "text": "un"},
        {"speaker": "B", "time": "5:00", "text": "deux mots"},
        {"speaker": "C", "time": "4:00", "text": "en retard"},
    ])
    assert cues[0].end == 10 + t.MAX_CUE_SECONDS
    # Un horodatage qui recule est ramené au précédent : l'ordre reste croissant.
    assert [c.start for c in cues] == [10.0, 300.0, 300.0]
    assert all(c.end >= c.start for c in cues)


def test_cues_speaker_prefix_removed():
    cues = t.cues_from_entries([{"speaker": "Ana", "time": "0:01", "text": "Ana Bonjour"}])
    assert cues[0].text == "Bonjour"


# --- WebVTT -------------------------------------------------------------------------
def _sample():
    return [t.Cue(3, 12, "Chloé Évrard", "Le contrôle d'accès <admin> & le reste"),
            t.Cue(12, 15.5, "Lucas Bernard", "Ça marche, on déploie jeudi."),
            t.Cue(16, 17, "", "Applaudissements")]


def test_build_vtt_format():
    vtt = t.build_vtt(_sample(), title="Point --> interop", day=date(2026, 11, 24),
                      when="mardi 24 novembre 2026 11:00 - 11:45", organizer="Sofia Marino")
    lines = vtt.split("\n")
    assert lines[0] == "WEBVTT" and lines[1] == ""
    assert lines[2:8] == ["NOTE", "Date: 2026-11-24", "Titre: Point -> interop",
                          "Réunion: mardi 24 novembre 2026 11:00 - 11:45", "Organisateur: Sofia Marino",
                          "Source: transcription Teams relue par Trame (horodatages de début, fins estimées)"]
    assert "00:00:03.000 --> 00:00:12.000\n<v Chloé Évrard>Le contrôle d'accès &lt;admin&gt; &amp; le reste</v>" in vtt
    assert "\n3\n00:00:16.000 --> 00:00:17.000\nApplaudissements\n" in vtt
    assert "\r" not in vtt


def test_vtt_round_trip_keeps_accents_and_speakers():
    vtt = t.build_vtt(_sample(), title="Réunion", day=date(2026, 1, 5))
    back = t.parse_vtt(vtt)
    assert [(c.start, c.end, c.speaker, c.text) for c in back] == [
        (3.0, 12.0, "Chloé Évrard", "Le contrôle d'accès <admin> & le reste"),
        (12.0, 15.5, "Lucas Bernard", "Ça marche, on déploie jeudi."),
        (16.0, 17.0, "", "Applaudissements"),
    ]


def test_parse_vtt_reads_a_teams_export_with_multiline_cues():
    teams = ("\ufeffWEBVTT\r\n\r\n"
             "0b7c-1\r\n00:00:01.120 --> 00:00:04.560\r\n<v Ana Ruiz>Bonjour,\r\non commence ?</v>\r\n\r\n"
             "0b7c-2\r\n00:01:00.000 --> 00:01:02.000\r\nsans orateur\r\n")
    cues = t.parse_vtt(teams)
    assert cues[0] == t.Cue(1.12, 4.56, "Ana Ruiz", "Bonjour,\non commence ?")
    assert cues[1].speaker == "" and cues[1].text == "sans orateur"


def test_parse_vtt_with_no_cue_is_empty():
    assert t.parse_vtt("WEBVTT\n\nNOTE\nvide\n") == []
    assert t.parse_vtt(t.build_vtt([])) == []


@pytest.mark.parametrize("bad", [
    "", "VTT\n\n00:00:01.000 --> 00:00:02.000\nx", "WEBVTT\n\n00:00:01 --> 00:00:02\nx",
    "WEBVTT\n\n00:00:05.000 --> 00:00:02.000\nx", "WEBVTT\n\nun bloc sans horodatage\n",
])
def test_parse_vtt_rejects_invalid(bad):
    with pytest.raises(t.TranscriptError):
        t.parse_vtt(bad)


# --- dates et noms de fichiers -------------------------------------------------------
@pytest.mark.parametrize("when,expected", [
    ("mardi 24 novembre 2026 11:00 - 11:45", date(2026, 11, 24)),
    ("jeudi 1er octobre 2026 11:30", date(2026, 10, 1)),
    ("mercredi 12 août 2026", date(2026, 8, 12)),
    ("Tuesday, November 24, 2026 11:00 AM", date(2026, 11, 24)),
    ("24/11/2026 11:00", date(2026, 11, 24)),
    ("2026-02-03", date(2026, 2, 3)),
    ("vendredi 6 février", date(2026, 2, 6)),
    ("31/02/2026", None), ("hier", None), ("", None),
])
def test_parse_meeting_date(when, expected):
    assert t.parse_meeting_date(when, today=date(2026, 11, 26)) == expected


@pytest.mark.parametrize("title,day,expected", [
    ("Migration weekly", date(2026, 11, 24), "2026-11-24 Migration weekly.vtt"),
    ('Avancement E4M <> H10 : "point"?', date(2026, 11, 25), "2026-11-25 Avancement E4M H10 point.vtt"),
    ("RE: a/b\\c|d*", None, "RE a b c d.vtt"),
    ("Stratégie rendez-vous.", date(2026, 1, 2), "2026-01-02 Stratégie rendez-vous.vtt"),
    ("   ", date(2026, 1, 2), "2026-01-02 Réunion.vtt"),
    ("CON", None, "Réunion.vtt"),
    ("x" * 300, None, "x" * 90 + ".vtt"),
])
def test_file_name(title, day, expected):
    assert t.file_name(title, day) == expected


def test_save_never_overwrites(tmp_path):
    first = t.save(tmp_path / "a", "2026-11-24 Point.vtt", "WEBVTT\n")
    second = t.save(tmp_path / "a", "2026-11-24 Point.vtt", "WEBVTT\n\nNOTE\nautre\n")
    assert first.name == "2026-11-24 Point.vtt" and second.name == "2026-11-24 Point (2).vtt"
    assert first.read_bytes() == b"WEBVTT\n"


def test_check_dir(tmp_path):
    assert t.check_dir(str(tmp_path)) == tmp_path
    for bad in ["", "relatif\\dossier", "\\\\serveur\\partage"]:
        with pytest.raises(t.TranscriptError):
            t.check_dir(bad)
    f = tmp_path / "fichier.txt"
    f.write_text("x")
    with pytest.raises(t.TranscriptError):
        t.check_dir(str(f))


def test_chosen_dir_is_remembered(tmp_path, transcripts_dir):
    assert t.chosen_dir(tmp_path) == transcripts_dir
    t.remember_dir(tmp_path, tmp_path / "ailleurs")
    assert t.chosen_dir(tmp_path) == tmp_path / "ailleurs"


@pytest.mark.parametrize("segment,expected", [
    ("sofia_marino_exemple_fr", "Sofia Marino"), ("jean-paul_le-goff_exemple_com", "Jean-Paul Le-Goff"),
    ("exemple_fr", ""), ("", ""), ("../../etc", ""),
])
def test_owner_name(segment, expected):
    assert t.owner_name(segment) == expected


def test_meeting_id_round_trip():
    mid = t.meeting_id("19:meeting_abc@thread.v2", "1795518682052")
    assert t.split_meeting_id(mid) == ("19:meeting_abc@thread.v2", "1795518682052")
    for bad in ["", "19:meeting_abc@thread.v2", "#123", "19:x#../../a"]:
        with pytest.raises(t.TranscriptError):
            t.split_meeting_id(bad)


# --- API (pilote de démo) ------------------------------------------------------------
def test_api_lists_meetings_and_saves_vtt(make_client, transcripts_dir):
    client, watcher, _d = make_client()
    r = client.get("/api/meetings").json()
    assert r["ok"] and r["directory"] == str(transcripts_dir)
    first = next(m for m in r["meetings"] if m["title"] == "Point interop HL7")
    assert first["date"] == "2026-11-24" and first["transcript"] is True and first["saved"] is None
    assert (first["start"], first["end"]) == ("10:00", "10:30")
    saved = client.post("/api/meetings/transcript", json={"thread_id": first["thread_id"], "mid": first["mid"]}).json()
    assert saved["ok"] and saved["name"] == "2026-11-24 Point interop HL7.vtt" and saved["complete"] is True
    assert saved["cues"] == 4 and saved["organizer"] == "Sofia Marino"
    assert "vtt" not in saved
    text = Path(saved["path"]).read_text(encoding="utf-8")
    assert text.startswith("WEBVTT\n") and "Organisateur: Sofia Marino" in text
    cues = t.parse_vtt(text)
    assert cues[0].speaker == "Sofia Marino" and cues[0].text.endswith("Les tests OBX passent depuis ce matin.")
    # L'organisateur et le fichier enregistré sont connus des listes suivantes.
    again = next(m for m in client.get("/api/meetings").json()["meetings"] if m["title"] == "Point interop HL7")
    assert again["organizer"] == "Sofia Marino"
    assert again["saved"] == {"path": saved["path"], "name": "2026-11-24 Point interop HL7.vtt"}
    assert any("Transcription de « Point interop HL7 » enregistrée" in j.text for j in watcher.journal.query("Point interop")["items"])


def test_api_errors(make_client, tmp_path):
    client, _w, _d = make_client()
    none = client.post("/api/meetings/transcript", json={"thread_id": "19:meeting_mock3@thread.v2", "mid": "1700000003"})
    assert none.status_code == 404 and "Pas de transcription" in none.json()["error"]
    unknown = client.post("/api/meetings/transcript", json={"thread_id": "19:meeting_x@thread.v2", "mid": "1"})
    assert unknown.status_code == 404
    bad_dir = client.post("/api/meetings/transcript",
                          json={"thread_id": "19:meeting_mock1@thread.v2", "mid": "1700000001", "directory": "relatif"})
    assert bad_dir.status_code == 422
    bad_mid = client.post("/api/meetings/transcript", json={"thread_id": "19:meeting_mock1@thread.v2", "mid": "../x"})
    assert bad_mid.status_code == 422


def test_api_directory_is_remembered(make_client, tmp_path):
    client, _w, _d = make_client()
    target = tmp_path / "CR"
    r = client.post("/api/meetings/transcript",
                    json={"thread_id": "19:meeting_mock2@thread.v2", "mid": "1700000002", "directory": str(target)}).json()
    assert Path(r["path"]).parent == target
    assert client.get("/api/meetings").json()["directory"] == str(target)
    opened = client.post("/api/meetings/open-folder", json={}).json()
    assert opened["directory"] == str(target)


def test_driver_without_transcripts_is_refused(make_client):
    from drivers.mock import MockTeamsDriver

    class Plain(MockTeamsDriver):
        supports_transcripts = False

        def list_meetings(self, limit=None):
            raise AssertionError("jamais appelé")

    client, _w, _d = make_client(driver=Plain(interval=9999))
    r = client.get("/api/meetings")
    assert r.status_code == 501 and "Transcriptions indisponibles" in r.json()["error"]


# --- pilote Teams intégré (page simulée) ---------------------------------------------
class TranscriptPage:
    """Joue la page Teams : répond aux commandes relayées comme le ferait teams-bridge.js."""

    def __init__(self, driver: WebBridgeDriver, result: dict):
        self.driver, self.result, self.title = driver, result, "Conversation | Autre | Microsoft Teams"
        self.ops: list[tuple[str, dict]] = []
        self.stop = False
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def answer(self, op, a):
        if op == "ping":
            return {"title": self.title, "ready": True}
        if op == "title":
            return self.title
        if op == "list":
            return [{"label": "Group chat Point interop Last message Ana: on commence 10:02", "id": "title-chat-list-item_19:meeting_abc@thread.v2"},
                    {"label": "Chat Autre Last message salut 09:00", "id": "title-chat-list-item_19:autre@thread.v2"}]
        if op == "open":
            self.title = f"Conversation | {a['name']} | Microsoft Teams"
            return {"ok": True, "title": self.title}
        if op == "recaps":
            return {"recaps": [{"mid": "17", "title": "Point interop", "when": "lundi 23 novembre 2026 10:00 - 10:30",
                                "transcript": True}]}
        if op == "transcript":
            return self.result
        return None

    def loop(self):
        while not self.stop:
            cmd = self.driver.next_command(wait=0.2)
            if cmd:
                self.ops.append((cmd["op"], cmd["args"]))
                self.driver.deliver(cmd["id"], True, self.answer(cmd["op"], cmd["args"]))

    def __enter__(self):
        self.driver._last_poll = __import__("time").monotonic()
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop = True
        self.thread.join(2)


def test_web_bridge_lists_meetings_and_puts_back_the_conversation():
    d = WebBridgeDriver()
    with TranscriptPage(d, {}) as page:
        found = d.list_meetings()
    assert found == [{"thread_id": "title-chat-list-item_19:meeting_abc@thread.v2".replace("chat-list-item_", ""),
                      "chat": "Point interop", "mid": "17", "title": "Point interop",
                      "when": "lundi 23 novembre 2026 10:00 - 10:30", "transcript": True}]
    opened = [a["name"] for op, a in page.ops if op == "open"]
    # Seule la conversation de réunion est ouverte, puis celle d'avant revient.
    assert opened == ["Point interop", "Autre"]


def test_web_bridge_transcript_relays_entries():
    d = WebBridgeDriver()
    entries = [{"speaker": "Ana Ruiz", "time": "0:05", "text": "Bonjour."}]
    with TranscriptPage(d, {"ok": True, "entries": entries, "owner": "ana_ruiz_exemple_fr", "complete": True}) as page:
        res = d.meeting_transcript("title-19:meeting_abc@thread.v2", "17")
    assert res["entries"] == entries
    assert ("transcript", {"mid": "17", "probe": False}) in page.ops


# --- liste : créneau, tri, fichier déjà enregistré ----------------------------------
@pytest.mark.parametrize("when,expected", [
    ("mardi 24 novembre 2026 11:00 - 11:45", ("11:00", "11:45")),
    ("jeudi 3 septembre 2026 9:05 – 10:30", ("09:05", "10:30")),
    ("Tuesday, November 24, 2026 9:00 AM - 9:30 AM", ("09:00", "09:30")),
    ("Tuesday, November 24, 2026 11:30 AM - 1:00 PM", ("11:30", "13:00")),
    ("24/11/2026 14h00 - 15h15", ("14:00", "15:15")),
    ("2026-11-24", (None, None)), ("mardi 24 novembre 2026", (None, None)), ("", (None, None)),
    ("10:00 - 25:00", (None, None)),
])
def test_parse_meeting_slot(when, expected):
    assert t.parse_meeting_slot(when) == expected


def test_saved_file(tmp_path):
    day = date(2026, 11, 24)
    assert t.saved_file(tmp_path, "Point interop", day) is None
    (tmp_path / "2026-11-24 Point interop.vtt").write_text("WEBVTT\n", encoding="utf-8")
    assert t.saved_file(tmp_path, "Point interop", day) == tmp_path / "2026-11-24 Point interop.vtt"
    assert t.saved_file(tmp_path / "absent", "Point interop", day) is None


def test_api_meetings_sorted_most_recent_first(make_client):
    client, _w, _d = make_client()
    meetings = client.get("/api/meetings").json()["meetings"]
    keys = [(m["date"], m["start"]) for m in meetings]
    assert keys == sorted(keys, reverse=True)
    assert meetings[0]["title"] == "Synchro inter-équipes" and meetings[0]["date"] == "2026-11-26"
    assert sum(m["title"] == "Synchro inter-équipes" for m in meetings) == 4


def test_api_denied_transcript(make_client):
    client, _w, _d = make_client()
    r = client.post("/api/meetings/transcript", json={"thread_id": "19:meeting_mock10@thread.v2", "mid": "1700000010"})
    assert r.status_code == 403 and "Accès refusé" in r.json()["error"]


def test_api_open_and_reveal_file(make_client, transcripts_dir, monkeypatch):
    import os
    import subprocess

    launched, started = [], []
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: launched.append(a[0]))
    monkeypatch.setattr(os, "startfile", lambda p: started.append(p), raising=False)
    client, _w, _d = make_client()
    saved = client.post("/api/meetings/transcript",
                        json={"thread_id": "19:meeting_mock1@thread.v2", "mid": "1700000001"}).json()
    opened = client.post("/api/meetings/file", json={"path": saved["path"]})
    assert opened.status_code == 200 and opened.json()["path"] == saved["path"]
    shown = client.post("/api/meetings/file", json={"path": saved["path"], "reveal": True})
    assert shown.status_code == 200
    if os.name == "nt":
        assert started == [saved["path"]] and launched == [f'explorer.exe /select,"{saved["path"]}"']
    # Rien d'autre qu'un .vtt existant, en chemin complet.
    exe = Path(saved["path"]).parent / "outil.exe"
    exe.write_bytes(b"MZ")
    for bad, code in ((str(exe), 422), ("relatif.vtt", 422), (str(exe.parent / "absent.vtt"), 404),
                      ("\\\\serveur\\partage\\a.vtt", 422)):
        r = client.post("/api/meetings/file", json={"path": bad})
        assert r.status_code == code, bad
    assert len(started) <= 1 and len(launched) <= 1


def test_api_set_folder(make_client, tmp_path, monkeypatch):
    import os

    opened = []
    monkeypatch.setattr(os, "startfile", lambda p: opened.append(p), raising=False)
    client, _w, _d = make_client()
    target = tmp_path / "CR"
    r = client.post("/api/meetings/folder", json={"directory": str(target)})
    assert r.status_code == 200 and r.json()["directory"] == str(target)
    assert client.get("/api/meetings").json()["directory"] == str(target)
    assert client.get("/api/meetings/folder").json() == {"ok": True, "directory": str(target)}
    assert opened == []
    assert client.post("/api/meetings/folder", json={"directory": "relatif"}).status_code == 422
