from __future__ import annotations

import json

import pytest

import settings as settings_mod
import safety
from conftest import FakeBrain
from models import IncomingMessage, Surface

DM_AUTO = "19:aa11@thread.v2"
DM_DRAFT = "19:bb22@thread.v2"


def _msg(thread_id: str, text: str = "Tu es dispo ?", sender: str = "Quelqu'un"):
    return IncomingMessage(thread_id=thread_id, sender=sender, text=text, received_at="10:00", surface=Surface.dm)


def _sent(driver) -> list[str]:
    return [text for _t, text, send in driver.typed if send]


@pytest.mark.parametrize("text, expected", [
    ("Oui, c'est fait.", "Oui, c'est fait. 🤖"),
    ("Oui, c'est fait.  \n", "Oui, c'est fait. 🤖"),
    ("C'est fait 🤖", "C'est fait 🤖"),
    ("🤖 C'est fait", "🤖 C'est fait"),
    ("Merci, c'est parfait !", "Merci, c'est parfait ! 🤖😊"),
    ("", ""),
    ("   ", "   "),
])
def test_mark_automatic(text, expected):
    assert safety.mark_automatic(text) == expected


@pytest.mark.parametrize("text, tone", [
    ("Désolé, je n'ai pas pu finir avant ce soir.", "😔"),
    ("Malheureusement la démo est décalée, merci de ta patience.", "😔"),
    ("Bravo pour la mise en prod !", "🎉"),
    ("Merci, c'est top.", "😊"),
    ("Pas de souci, ça roule.", "😎"),
    ("T’inquiète, je gère.", "😎"),
    ("Je regarde et je te dis.", "🤔"),
    ("Le build passe chez moi.", ""),
    ("Je supervise le déploiement.", ""),
])
def test_tone_of(text, tone):
    assert safety.tone_of(text) == tone


@pytest.mark.parametrize("sent", ["Merci ! 🤖😊", "Merci ! 🤖", "Merci !"])
def test_unmark_drops_marker_and_tone(sent):
    assert safety.unmark(sent) == "Merci !"


def test_auto_send_carries_the_tone(make_client):
    _client, watcher, driver = make_client(brain=FakeBrain(reply="Désolé, je n'ai pas pu relancer le build."))
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert _sent(driver) == ["Désolé, je n'ai pas pu relancer le build."]


def test_auto_send_is_marked(make_client):
    _client, watcher, driver = make_client()
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert _sent(driver) == ["Réponse de test"]


def test_countdown_log_shows_the_original_text(make_client):
    _client, watcher, _driver = make_client()
    watcher._process(_msg(DM_AUTO))
    assert any("tout de suite" in log.text and "Réponse de test" in log.text for log in watcher.state.logs)


def test_manual_send_is_not_marked(make_client):
    client, watcher, driver = make_client()
    watcher._process(_msg(DM_DRAFT))
    draft = next(d for d in watcher.state.drafts if d.thread_id == DM_DRAFT)
    assert draft.proposal == "Réponse de test"
    assert client.post(f"/api/drafts/{draft.id}/send").status_code == 200
    assert _sent(driver) == ["Réponse de test"]


def test_cancelled_countdown_keeps_an_unmarked_draft(make_client):
    _client, watcher, driver = make_client()
    watcher._countdown_ok = lambda _secs: False
    assert watcher._process(_msg(DM_AUTO)) == "draft"
    draft = next(d for d in watcher.state.drafts if d.thread_id == DM_AUTO)
    assert draft.proposal == "Réponse de test" and driver.typed == []


def test_marker_from_the_brain_is_not_doubled(make_client):
    _client, watcher, driver = make_client(brain=FakeBrain(reply="Je m'en occupe 🤖"))
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert _sent(driver) == ["Je m'en occupe 🤖"]


def test_option_off_sends_unmarked(make_client):
    client, watcher, driver = make_client()
    assert client.put("/api/settings", json={"safety": {"mark_auto_replies": False}}).status_code == 200
    assert watcher.cfg["safety"]["mark_auto_replies"] is False
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert _sent(driver) == ["Réponse de test"]


def test_old_config_without_the_key_marks(make_client, fresh_home):
    path = fresh_home / "config.json"
    cfg = json.loads(path.read_text(encoding="utf-8"))
    del cfg["safety"]["mark_auto_replies"]
    path.write_text(json.dumps(cfg), encoding="utf-8")
    client, watcher, driver = make_client()
    assert "mark_auto_replies" not in watcher.cfg["safety"]
    assert settings_mod.from_config(watcher.cfg).safety.mark_auto_replies is True
    assert client.get("/api/settings").json()["settings"]["safety"]["mark_auto_replies"] is True
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert _sent(driver) == ["Réponse de test"]


def test_shipped_config_turns_it_on(make_client):
    client, _watcher, _driver = make_client()
    assert client.get("/api/settings").json()["settings"]["safety"]["mark_auto_replies"] is True


def test_echo_of_a_marked_reply_does_not_trigger_a_reply(make_client):
    _client, watcher, driver = make_client()
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert watcher._process(_msg(DM_AUTO, text="Réponse de test 🤖", sender="")) is None
    assert watcher._process(_msg(DM_AUTO, text="Réponse de test", sender="")) is None
    assert len(_sent(driver)) == 1
