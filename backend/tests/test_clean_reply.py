import pytest

from brain.base import build_prompt, clean_reply
from models import IncomingMessage, Surface


@pytest.mark.parametrize("raw, expected", [
    ("Réponse à Sébastien (pair, tutoiement, rafales courtes) :\n\nDamien 😉", "Damien 😉"),
    ("**Réponse :**\nOui, je regarde.", "Oui, je regarde."),
    ("Voici la réponse :\n\nOk pour demain.\nJe te confirme l'heure.", "Ok pour demain.\nJe te confirme l'heure."),
    ("Reply:\nSure, on it.", "Sure, on it."),
    ("« Oui, je regarde. »", "Oui, je regarde."),
    ('"Ok pour demain"', "Ok pour demain"),
    # The model reasons first, then labels its answer: only the answer is the message.
    ("Hugo me demande qui est assigné sur la PR. Je ne peux pas consulter GitHub d'ici, donc je ne "
     "propose pas de réponse inventée.\n\nRéponse suggérée :\n\nJe regarde et je reviens vers toi 😉",
     "Je regarde et je reviens vers toi 😉"),
    ("Le ton est familier.\n**Message proposé :**\nOk pour moi.", "Ok pour moi."),
    ("Voici ma proposition :\nV1\n\nVersion finale :\nV2", "V1\n\nVersion finale :\nV2"),
])
def test_announcing_line_and_quotes_are_removed(raw, expected):
    assert clean_reply(raw) == expected


@pytest.mark.parametrize("text", [
    "Damien 😉",
    "Réponse demain matin, promis.",
    "Message reçu : je regarde ça.",
    "Deux points :\n- la MR\n- le déploiement",
    'Il a dit "non" puis "oui"',
    "Réponse :",
    "Hello\nMessage reçu : je regarde ça.",
    "Avant de livrer :\n- la MR\n- le déploiement",
    "Ok.\n\nRéponse :",
])
def test_a_real_message_is_left_alone(text):
    assert clean_reply(text) == text


def test_prompt_forbids_announcing_the_reply():
    assert "ne l'annonce pas" in build_prompt("SOUL", "", "Salut", "")


def test_new_message_and_sent_draft_drop_the_cached_history(make_client):
    _client, watcher, _driver = make_client()
    t = "19:bb22@thread.v2"
    msg = IncomingMessage(thread_id=t, sender="Lucas", text="Salut", surface=Surface.dm, received_at="13:22")
    watcher._thread_cache[t] = (1e12, [])
    watcher._queue_draft(msg, "Hello", "draft", None)
    assert t not in watcher._thread_cache

    watcher._thread_cache[t] = (1e12, [])
    watcher._history[t] = (1e12, "vieux")
    watcher._deliver = lambda *a, **k: True
    watcher.send_draft(watcher.state.drafts[0].id)
    assert t not in watcher._thread_cache and t not in watcher._history
