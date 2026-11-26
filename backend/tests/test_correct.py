from __future__ import annotations
import subprocess

import pytest

from brain import claude as claude_mod
from brain.claude import ClaudeBrain
from brain.correct import CorrectionError, NBSP, build_correct_prompt, mock_correct, parse_correction
from brain.mock import MockBrain
from conftest import FakeBrain

TEXT = "Salut, tu peux regarder ca demian ? jai mis le lien https://github.com/acme/interop/pull/214 @Lucas 🙂"


# --- prompt ---

def test_prompt_keeps_tone_and_protected_parts():
    prompt = build_correct_prompt(TEXT)
    assert TEXT in prompt
    low = prompt.lower()
    for rule in ("orthographe", "grammaire", "fautes de frappe", "« »", "insécable"):
        assert rule in low
    for keep in ("garde le ton", "tutoiement ou le vouvoiement", "emoji", "mentions", "liens", "code"):
        assert keep in low
    assert "ne réponds pas au message" in low


def test_brain_correct_goes_through_complete_with_the_prompt():
    brain = FakeBrain(completion="Salut, tu peux regarder ça demain ? J’ai mis le lien "
                                 "https://github.com/acme/interop/pull/214 @Lucas 🙂")
    assert brain.correct(TEXT).startswith("Salut, tu peux regarder ça demain")
    assert brain.prompts == [build_correct_prompt(TEXT)]


# --- parsing / garde-fous ---

def test_parse_strips_announce_and_quotes():
    raw = "Voici le message corrigé :\n« Tu peux regarder ça demain ? »"
    assert parse_correction(raw, "tu peux regarder ca demain?") == "Tu peux regarder ça demain ?"


def test_parse_keeps_quotes_the_user_wrote():
    assert parse_correction("« Bien reçu »", "« bien recu »") == "« Bien reçu »"


def test_parse_refuses_an_answer_instead_of_a_correction():
    with pytest.raises(CorrectionError):
        parse_correction("Oui, je regarde la PR cet après-midi et je te fais un retour.", "tu peux regarder la PR stp ?")


def test_parse_refuses_a_changed_link_or_mention():
    with pytest.raises(CorrectionError, match="https://github.com"):
        parse_correction("Regarde https://github.com/acme/interop/pulls @Lucas", "regarde https://github.com/acme/interop/pull/214 @Lucas")
    with pytest.raises(CorrectionError, match="@Lucas"):
        parse_correction("Regarde ça Lucas", "regarde ca @Lucas")


def test_parse_refuses_empty():
    with pytest.raises(CorrectionError):
        parse_correction("  \n", "bonjour")


# --- cerveau hors ligne ---

def test_mock_correction_is_visible_and_preserves_protected_parts():
    out = mock_correct(TEXT)
    assert out != TEXT
    assert "ça demain" + NBSP + "?" in out
    assert "J’ai" in out
    for kept in ("https://github.com/acme/interop/pull/214", "@Lucas", "🙂", "tu peux"):
        assert kept in out
    assert parse_correction(out, TEXT) == out
    assert MockBrain().correct(TEXT) == out


def test_mock_correction_leaves_code_and_times_alone():
    text = "le build casse sur `if (a:b) ca` a 14:30"
    out = mock_correct(text)
    assert "`if (a:b) ca`" in out and "14:30" in out


def test_mock_correction_guillemets():
    assert mock_correct('il a dit "ok" hier') == f"Il a dit «{NBSP}ok{NBSP}» hier"


# --- API ---

def test_api_correct_returns_the_corrected_text(make_client):
    client, _, _ = make_client(brain=MockBrain())
    r = client.post("/api/correct", json={"text": TEXT})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] and body["changed"] and body["text"] == mock_correct(TEXT)


def test_api_correct_unchanged(make_client):
    client, _, _ = make_client(brain=FakeBrain(completion="Bien reçu."))
    assert client.post("/api/correct", json={"text": "Bien reçu."}).json() == {"ok": True, "text": "Bien reçu.", "changed": False}


@pytest.mark.parametrize("text", ["", "   \n "])
def test_api_correct_refuses_empty_text(make_client, text):
    brain = FakeBrain(completion="x")
    client, _, _ = make_client(brain=brain)
    r = client.post("/api/correct", json={"text": text})
    assert r.status_code == 400
    assert "vide" in r.json()["error"]
    assert brain.prompts == []


def test_api_correct_refuses_too_long(make_client):
    client, _, _ = make_client(brain=FakeBrain(completion="x"))
    assert client.post("/api/correct", json={"text": "a" * 10001}).status_code == 413


def test_api_correct_reports_brain_error(make_client):
    client, watcher, _ = make_client(brain=FakeBrain(completion=RuntimeError("claude a échoué: quota atteint")))
    r = client.post("/api/correct", json={"text": "tu peux regarder ?"})
    assert r.status_code == 502
    err = r.json()["error"]
    assert "quota atteint" in err and "n'a pas changé" in err


def test_api_correct_reports_unusable_correction(make_client):
    client, _, _ = make_client(brain=FakeBrain(completion="Oui bien sûr, je m'en occupe tout de suite et je reviens vers toi."))
    r = client.post("/api/correct", json={"text": "tu peux regarder stp ?"})
    assert r.status_code == 502
    assert "Correction inutilisable" in r.json()["error"]


def test_api_correct_never_sends(make_client):
    client, watcher, driver = make_client(brain=MockBrain())
    sent = []
    driver.send = lambda *a, **k: sent.append(a)  # type: ignore[method-assign]
    client.post("/api/correct", json={"text": TEXT})
    assert sent == []


def test_claude_brain_correct_uses_the_chosen_model(monkeypatch):
    seen = {}

    def fake_run(cmd, input=None, **kw):
        seen["cmd"], seen["input"] = cmd, input
        return subprocess.CompletedProcess(cmd, 0, stdout="Tu peux regarder ça ?", stderr="")

    monkeypatch.setattr(claude_mod.subprocess, "run", fake_run)
    out = ClaudeBrain(model="sonnet").correct("tu peux regarder ca?")
    assert out == "Tu peux regarder ça ?"
    assert "--model" in seen["cmd"] and "sonnet" in seen["cmd"]
    assert "<message>\ntu peux regarder ca?\n</message>" in seen["input"]
