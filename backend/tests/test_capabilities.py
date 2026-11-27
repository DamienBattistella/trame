"""Trame ne décide d'une action que s'il peut la mener : il n'écrit que des messages. Une demande
d'agir sur un système, ou une réponse qui engage l'utilisateur, ne part jamais seule en mode Auto."""
from __future__ import annotations

import pytest

import safety
from brain.base import build_prompt


@pytest.mark.parametrize("text", [
    "Tu peux regarder les logs sur la recette stp ?",
    "Est-ce que tu pourrais récupérer le fichier de log du serveur ws004 ?",
    "Peux-tu relancer le service sur l'environnement de prod ?",
    "Merci de vérifier la base de données de recette",
    "Can you check the prod logs?",
    "Tu peux me donner les accès au cluster ?",
])
def test_requests_to_act_on_a_system_are_recognised(text):
    assert safety.asks_for_action(text)


@pytest.mark.parametrize("text", [
    "Merci pour ton aide !",
    "On se voit à 15 h pour la revue ?",
    "Tu as passé un bon week-end ?",
    "Bravo pour la mise en prod d'hier",
    "Tu peux me rappeler quand tu es dispo ?",
])
def test_ordinary_messages_are_not_requests_to_act(text):
    assert not safety.asks_for_action(text)


@pytest.mark.parametrize("reply, commits", [
    ("Je regarde et je te dis.", True),
    ("Je te l'envoie dans la journée.", True),
    ("Je relance le job.", True),
    ("Je m'en occupe.", True),
    ("Merci, bonne journée !", False),
    ("Oui, la réunion est à 15 h.", False),
])
def test_replies_that_commit_the_user(reply, commits):
    assert safety.commits_to_action(reply) is commits


def test_beyond_capabilities_says_why():
    assert "système" in safety.beyond_capabilities("Tu peux regarder les logs de la recette ?", "Ok")
    assert "engage" in safety.beyond_capabilities("Merci !", "Je regarde ça.")
    assert safety.beyond_capabilities("Merci !", "Avec plaisir !") is None


def test_the_prompt_says_what_trame_can_and_cannot_do():
    p = build_prompt("Je suis Damien.", "", "Tu peux regarder les logs ?", "")
    assert "uniquement écrire ce message" in p
    assert "N'affirme donc jamais avoir regardé" in p


def test_auto_reply_to_a_request_to_act_stays_a_draft(make_client):
    client, watcher, driver = make_client()
    from models import IncomingMessage
    entity = watcher.state.watchlist[0]
    entity.watch, entity.mode = True, "auto"
    watcher.state.selftest_ok = True
    watcher.cfg.setdefault("reply", {})["fact_check_before_auto_send"] = False
    watcher._screen_sharing = lambda: False
    watcher._draft_reply = lambda *a, **k: "Oui je regarde ça."
    msg = IncomingMessage(thread_id=entity.thread_id, sender="Ana Martin", text="Tu peux regarder les logs de la recette ?",
                          received_at="10:00", surface=entity.surface)
    assert watcher._process(msg) == "draft"
    assert driver.typed == []


def test_auto_reply_to_an_ordinary_message_still_leaves(make_client):
    """Le contrôle du test précédent : même conversation, message anodin, la réponse part."""
    client, watcher, driver = make_client()
    from models import IncomingMessage
    entity = watcher.state.watchlist[0]
    entity.watch, entity.mode = True, "auto"
    watcher.state.selftest_ok = True
    watcher.cfg.setdefault("reply", {})["fact_check_before_auto_send"] = False
    watcher.cfg["reply"]["auto_send_countdown_seconds"] = 0
    watcher._screen_sharing = lambda: False
    watcher._draft_reply = lambda *a, **k: "Avec plaisir !"
    msg = IncomingMessage(thread_id=entity.thread_id, sender="Ana Martin", text="Merci pour ton aide !",
                          received_at="10:00", surface=entity.surface)
    assert watcher._process(msg) == "sent"
