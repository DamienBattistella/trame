"""Meeting report dialog: a skill applied to a .vtt in several turns. Every skill and
transcript here is made up for the tests."""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

import reflection
import reports
import transcripts as t
from brain.base import Brain
from conftest import FakeBrain

SKILL = """---
name: meeting-report
description: "Compte-rendu fictif pour les tests. À utiliser pour un compte-rendu de réunion."
---

Écris un compte-rendu, puis demande si l'utilisateur veut des issues de suivi.
"""

VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Alice Martin>On livre vendredi.\n\n" \
      "00:00:05.000 --> 00:00:08.000\n<v Thomas Petit>Je prépare la recette.\n"


@pytest.fixture(autouse=True)
def transcripts_dir(tmp_path, monkeypatch):
    folder = tmp_path / "Transcriptions"
    monkeypatch.setattr(t, "default_dir", lambda: folder)
    import os
    monkeypatch.setattr(os, "startfile", lambda _p: None, raising=False)
    return folder


class Scripted(Brain):
    label = "Test"
    model = "scripté"

    def __init__(self, answers):
        self.answers = list(answers)
        self.prompts: list[str] = []
        self.gate: threading.Event | None = None

    def draft(self, *a, **k):
        raise NotImplementedError

    def complete(self, prompt, timeout=None):
        self.prompts.append(prompt)
        if self.gate is not None:
            while not self.gate.wait(0.01):
                reflection.check_cancelled()
        return self.answers.pop(0) if self.answers else "Rien."


def wait_for(client, rid, statuses=("waiting", "done", "error", "cancelled"), timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        r = client.get(f"/api/reports/{rid}").json()["report"]
        if r["status"] in statuses:
            return r
        time.sleep(0.02)
    raise AssertionError(f"statut {r['status']}")


def setup(make_client, fresh_home, transcripts_dir, brain, skill=True, vtt=True):
    if skill:
        d = fresh_home / "skills" / "meeting-report"
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(SKILL, encoding="utf-8")
        (d / "reference").mkdir(exist_ok=True)
        (d / "reference" / "modele.md").write_text("# Modèle fictif", encoding="utf-8")
    if vtt:
        transcripts_dir.mkdir(parents=True, exist_ok=True)
        (transcripts_dir / "2026-11-24 Point interop HL7.vtt").write_text(VTT, encoding="utf-8")
    client, watcher, driver = make_client(brain=brain)
    return client, watcher, driver


START = {"thread_id": "19:meeting_demo1@thread.v2", "mid": "1", "title": "Point interop HL7", "date": "2026-11-24"}


def test_multi_turn_question_answer_then_report(make_client, fresh_home, transcripts_dir):
    brain = Scripted([
        "[[skill:meeting-report/reference/modele.md]]",
        "Voici.\n<compte-rendu>\n# CR\n- Livraison vendredi\n</compte-rendu>\n"
        "<question>Des issues de suivi ?<options>Oui | Non</options></question>",
        "<compte-rendu>\n# CR\n- Livraison vendredi\n\n## Issues proposées\n- Recette\n</compte-rendu>",
    ])
    client, watcher, _ = setup(make_client, fresh_home, transcripts_dir, brain)
    r = client.post("/api/reports", json=START).json()
    assert r["ok"], r
    rid = r["report"]["id"]
    r = wait_for(client, rid)
    assert r["status"] == "waiting"
    turn = r["turns"][-1]
    assert turn["question"] == "Des issues de suivi ?" and turn["options"] == ["Oui", "Non"]
    assert turn["text"] == "Voici." and r["report"].startswith("# CR")
    # The prompt shown is the prompt sent (the one after the reference file was read).
    assert turn["prompt"] == brain.prompts[1]
    assert "Écris un compte-rendu" in turn["prompt"] and "<v Alice Martin>On livre vendredi." in turn["prompt"]
    assert "# Modèle fictif" in turn["prompt"] and "# Modèle fictif" not in brain.prompts[0]
    assert r["references"] == ["reference/modele.md"]
    run = next(x for x in watcher.reflections.snapshot() if x["id"] == turn["runId"])
    assert run["action"] == "report" and "meeting-report" in run["skills"]
    assert client.post(f"/api/reports/{rid}/answer", json={"text": "  "}).status_code == 422
    r = client.post(f"/api/reports/{rid}/answer", json={"text": "Oui"}).json()["report"]
    r = wait_for(client, rid, ("done", "error"))
    assert r["status"] == "done" and "Issues proposées" in r["report"]
    assert "[Utilisateur] Oui" in brain.prompts[2] and "<question>Des issues de suivi ?" in brain.prompts[2]
    assert r["turns"][-1]["prompt"] == brain.prompts[2]
    assert [x["role"] for x in r["turns"]] == ["assistant", "user", "assistant"]
    assert client.post(f"/api/reports/{rid}/answer", json={"text": "encore"}).status_code == 409
    # Saved next to the .vtt, never overwriting.
    r = client.post(f"/api/reports/{rid}/save").json()["report"]
    assert r["savedPath"].endswith("2026-11-24 Point interop HL7.md")
    assert Path(r["savedPath"]).read_text(encoding="utf-8").startswith("# CR")
    r = client.post(f"/api/reports/{rid}/save").json()["report"]
    assert r["savedPath"].endswith("2026-11-24 Point interop HL7 (2).md")


def test_vtt_is_fetched_when_absent(make_client, fresh_home, transcripts_dir):
    brain = Scripted(["<compte-rendu>\n# CR\n</compte-rendu>"])
    client, _w, _d = setup(make_client, fresh_home, transcripts_dir, brain, vtt=False)
    meeting = client.get("/api/meetings").json()["meetings"][0]
    r = client.post("/api/reports", json={"thread_id": meeting["thread_id"], "mid": meeting["mid"],
                                          "title": meeting["title"], "date": meeting["date"]}).json()
    assert r["ok"], r
    assert Path(r["report"]["vttPath"]).is_file() and Path(r["report"]["vttPath"]).parent == transcripts_dir
    r = wait_for(client, r["report"]["id"])
    assert r["status"] == "done" and r["report"] == "# CR"
    assert "Sofia Marino" in brain.prompts[0]


def test_missing_skill_is_a_clear_error(make_client, fresh_home, transcripts_dir):
    client, _w, _d = setup(make_client, fresh_home, transcripts_dir, Scripted([]), skill=False)
    res = client.post("/api/reports", json=START)
    assert res.status_code == 404
    assert "Skill « meeting-report » introuvable" in res.json()["error"]


def test_cancel_stops_the_running_turn(make_client, fresh_home, transcripts_dir):
    brain = Scripted(["<compte-rendu>trop tard</compte-rendu>"])
    brain.gate = threading.Event()
    client, _w, _d = setup(make_client, fresh_home, transcripts_dir, brain)
    rid = client.post("/api/reports", json=START).json()["report"]["id"]
    end = time.monotonic() + 3
    while not brain.prompts and time.monotonic() < end:
        time.sleep(0.01)
    live = client.get(f"/api/reports/{rid}").json()["report"]
    assert live["status"] == "running" and live["pendingPrompt"] == brain.prompts[0]
    client.post(f"/api/reports/{rid}/cancel")
    r = wait_for(client, rid, ("cancelled", "done", "error"))
    assert r["status"] == "cancelled" and r["report"] == ""
    assert client.post(f"/api/reports/{rid}/cancel").status_code == 409


def test_path_must_be_a_vtt_of_the_transcripts_folder(make_client, fresh_home, transcripts_dir, tmp_path):
    client, _w, _d = setup(make_client, fresh_home, transcripts_dir, Scripted([]))
    (tmp_path / "ailleurs.vtt").write_text(VTT, encoding="utf-8")
    assert client.post("/api/reports", json={"path": str(tmp_path / "ailleurs.vtt")}).status_code == 422
    ok = client.post("/api/reports", json={"path": str(transcripts_dir / "2026-11-24 Point interop HL7.vtt")})
    assert ok.status_code == 200


def test_no_script_run_and_copilot_budget(make_client, fresh_home, transcripts_dir, monkeypatch):
    import subprocess
    calls = []
    brain = Scripted([])
    brain.max_prompt_chars = 100
    client, _w, _d = setup(make_client, fresh_home, transcripts_dir, brain)
    (fresh_home / "skills" / "meeting-report" / "scripts").mkdir()
    (fresh_home / "skills" / "meeting-report" / "scripts" / "x.py").write_text("raise SystemExit", encoding="utf-8")
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a))
    rid = client.post("/api/reports", json=START).json()["report"]["id"]
    r = wait_for(client, rid)
    assert r["status"] == "error" and "trop longue" in r["error"] and brain.prompts == []
    assert calls == []


def test_parse_answer_and_untagged_report():
    msg, q, opts, rep = reports.parse_answer("Salut\n<question>Laquelle ?</question>")
    assert (msg, q, opts, rep) == ("Salut", "Laquelle ?", [], "")
    assert reports.parse_answer("# Juste un CR")[3] == ""


def test_mcp_latest_report_and_mock_brain_flow(make_client, fresh_home, transcripts_dir):
    from brain.mock import MockBrain
    client, watcher, _d = setup(make_client, fresh_home, transcripts_dir, MockBrain())
    rid = client.post("/api/reports", json=START).json()["report"]["id"]
    r = wait_for(client, rid)
    assert r["status"] == "waiting" and r["turns"][-1]["options"] == ["Oui", "Non"]
    assert "Alice Martin" in r["report"]
    client.post(f"/api/reports/{rid}/answer", json={"text": "Oui"})
    r = wait_for(client, rid, ("done", "error"))
    assert r["status"] == "done" and "Brouillons d'issues" in r["report"]
    watcher.cfg.setdefault("mcp", {}).update(enabled=True, token="t")
    res = client.post("/mcp", headers={"Authorization": "Bearer t"},
                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": "get_meeting_report", "arguments": {}}})
    assert "Brouillons d'issues" in res.json()["result"]["content"][0]["text"]
