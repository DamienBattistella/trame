from __future__ import annotations

from datetime import datetime

from brain.status_note import FALLBACK, MARKER, build_status_prompt, parse_status_note
from conftest import FakeBrain

URL = "/api/me/status-message/suggest"


class NoteBrain(FakeBrain):
    def __init__(self, answer):
        super().__init__()
        self.answer, self.prompts = answer, []

    def complete(self, prompt, timeout=None):
        self.prompts.append(prompt)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def test_prompt_carries_voice_status_moment_angle_and_previous():
    p = build_status_prompt("Je tutoie mon équipe.", "Ne pas déranger", "Ancien message",
                            now=datetime(2026, 11, 27, 9, 5), angle="une formule courte et sobre")
    assert MARKER in p and "Je tutoie mon équipe." in p and "Ne pas déranger" in p
    assert "vendredi 09:05" in p and "une formule courte et sobre" in p and "Ancien message" in p


def test_parse_keeps_one_clean_line():
    assert parse_status_note('Message de statut : « 🎧 En plein refacto »\nautre ligne') == "🎧 En plein refacto"
    assert parse_status_note("**Statut :** Concentré") == "Concentré"
    assert parse_status_note("\n\n") == ""
    assert len(parse_status_note("x" * 400, limit=280)) == 280


def test_suggest_uses_the_brain_and_sends_nothing_to_teams(make_client):
    brain = NoteBrain("Message : 🚀 On livre la recette aujourd'hui")
    client, watcher, driver = make_client(brain=brain)
    r = client.post(URL, json={"text": "Ancien"}).json()
    assert r == {"ok": True, "text": "🚀 On livre la recette aujourd'hui", "source": "brain"}
    assert "Ancien" in brain.prompts[0] and driver.typed == []


def test_suggest_falls_back_when_the_brain_fails_or_repeats(make_client):
    client, watcher, _ = make_client(brain=NoteBrain(RuntimeError("hors ligne")))
    r = client.post(URL, json={"text": ""}).json()
    assert r["ok"] and r["source"] == "fallback" and r["text"] in FALLBACK
    assert any("message tout prêt" in l.text for l in watcher.state.logs)
    client, _, _ = make_client(brain=NoteBrain("Pareil"))
    r = client.post(URL, json={"text": "Pareil"}).json()
    assert r["source"] == "fallback" and r["text"] != "Pareil"
