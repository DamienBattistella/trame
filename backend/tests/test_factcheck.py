from __future__ import annotations
import json

import pytest

from conftest import FakeBrain
from github import context as gh
from models import IncomingMessage, Surface

SOFIA = "19:aa11@thread.v2"  # mode auto ; fil : « Pour la recette de jeudi… » à 10:12
LUCAS = "19:bb22@thread.v2"
ENTOURAGE = {
    "version": 1,
    "people": [
        {"name": "Lucas Bernard", "role": "Développeur interop", "team": "Hexagone", "manager": "Sofia Marino"},
        {"name": "Sofia Marino", "role": "Cheffe de projet", "team": "Interop"},
        {"name": "Chiara Rossi", "role": "Testeuse", "team": "Qualité"},
    ],
}
CONTRADICTED = {
    "claims": [
        {"excerpt": "jeudi", "verdict": "ok", "source": "Sofia Marino, 10:12 : « recette de jeudi »", "fix": "x"},
        {"excerpt": "vendredi", "verdict": "contredit",
         "source": "Sofia Marino, 10:12 : « Pour la recette de jeudi, on part bien sur le build d'aujourd'hui ? »",
         "fix": "jeudi"},
    ]
}


def _brain(payload=CONTRADICTED):
    return FakeBrain(completion="Voici :\n```json\n" + json.dumps(payload, ensure_ascii=False) + "\n```")


def _check(client, thread=SOFIA, text="On part sur la recette de vendredi, ok ?", **extra):
    return client.post(f"/api/threads/{thread}/check", json={"text": text, **extra})


def test_contradicted_date_from_the_thread(make_client):
    brain = _brain()
    client, watcher, driver = make_client(brain=brain)
    r = _check(client)
    assert r.status_code == 200, r.json()
    check = r.json()["check"]
    assert check["thread_id"] == SOFIA and check["sources"]["messages"] == 12
    first = check["claims"][0]
    assert first == {"excerpt": "vendredi", "verdict": "contredit", "fix": "jeudi",
                     "source": "Sofia Marino, 10:12 : « Pour la recette de jeudi, on part bien sur le build d'aujourd'hui ? »"}
    assert check["claims"][1]["verdict"] == "ok" and check["claims"][1]["fix"] is None
    prompt = brain.prompts[-1]
    assert "[10:12] Sofia Marino: Pour la recette de jeudi" in prompt
    assert prompt.rstrip().endswith("<<<\nOn part sur la recette de vendredi, ok ?\n>>>")
    # Vérifier n'envoie et ne saisit jamais rien.
    assert driver.typed == [] and watcher.state.drafts == []
    assert any("1 affirmation(s) contredite(s)" in log.text for log in watcher.state.logs)


def test_mock_brain_catches_the_date_offline(make_client):
    from brain.mock import MockBrain
    client, _watcher, _driver = make_client(brain=MockBrain())
    claims = _check(client).json()["check"]["claims"]
    assert claims[0]["verdict"] == "contredit" and claims[0]["excerpt"] == "vendredi" and claims[0]["fix"] == "jeudi"
    assert claims[0]["source"].startswith("Sofia Marino, 10:12 : « Pour la recette de jeudi")
    ok = _check(client, text="Oui, pour la recette de jeudi.").json()["check"]["claims"]
    assert [c["verdict"] for c in ok] == ["ok"]
    assert _check(client, text="Bien reçu, merci.").json()["check"]["claims"] == []


@pytest.mark.parametrize("raw", ["Je ne peux pas vérifier.", "{pas du json}", '```json\n{"verdicts": []}\n```',
                                 '{"claims": [{"excerpt": "", "verdict": "contredit"}]}',
                                 '{"claims": [{"excerpt": "x", "verdict": "faux"}]}'])
def test_malformed_brain_output(make_client, raw):
    client, watcher, driver = make_client(brain=FakeBrain(completion=raw))
    r = _check(client)
    assert r.status_code == 502 and r.json()["ok"] is False
    assert "Ton message est intact" in r.json()["error"]
    assert watcher.state.logs[0].level == "warn" and "Vérification impossible" in watcher.state.logs[0].text
    assert driver.typed == []


def test_one_bad_claim_does_not_hide_the_others(make_client):
    payload = {"claims": [{"verdict": "contredit"}, {"excerpt": "vendredi", "verdict": "contredit", "source": None, "fix": None}]}
    client, _w, _d = make_client(brain=_brain(payload))
    claims = _check(client).json()["check"]["claims"]
    assert claims == [{"excerpt": "vendredi", "verdict": "contredit", "source": "", "fix": None}]


def test_nothing_to_report(make_client):
    client, _w, _d = make_client(brain=_brain({"claims": []}))
    assert _check(client).json()["check"]["claims"] == []


def test_brain_failure(make_client):
    client, _w, _d = make_client(brain=FakeBrain(completion=RuntimeError("claude a échoué")))
    r = _check(client)
    assert r.status_code == 502 and "Ton message est intact" in r.json()["error"]


@pytest.mark.parametrize("text", ["", "   \n "])
def test_empty_text_refused(make_client, text):
    brain = _brain()
    client, _w, _d = make_client(brain=brain)
    r = _check(client, text=text)
    assert r.status_code == 422 and r.json()["ok"] is False
    assert brain.prompts == []


def test_too_long_and_unknown_thread(make_client):
    brain = _brain()
    client, _w, _d = make_client(brain=brain)
    assert _check(client, text="x" * 4001).status_code == 422
    assert _check(client, thread="19:inconnu@thread.v2").status_code == 404
    assert brain.prompts == []


def test_entourage_and_github_and_target_reach_the_prompt(make_client, monkeypatch):
    monkeypatch.setattr(gh, "fetch", lambda text, repos, enabled: "PR #214 acme/interop : Mapping HL7 OBX, mergée")
    monkeypatch.setattr(gh, "scope", lambda all_repos, allowlist: ["acme/interop"])
    brain = _brain({"claims": []})
    client, _w, _d = make_client(brain=brain)
    r = client.post("/api/people", json={"filename": "entourage.json", "content": json.dumps(ENTOURAGE)})
    assert r.status_code == 200
    target = {"sender": "Lucas Bernard", "text": "Tu peux relire la PR #214 ?", "at": "16:50"}
    r = _check(client, thread=LUCAS, text="Chiara Rossi la relit, la PR #214 est encore ouverte.", message=target)
    assert r.status_code == 200
    assert r.json()["check"]["sources"] == {"messages": 12, "people": 2, "github": 1}
    prompt = brain.prompts[-1]
    assert "Lucas Bernard : Développeur interop, équipe Hexagone, rattaché à Sofia Marino" in prompt
    assert "Chiara Rossi : Testeuse, équipe Qualité" in prompt  # nommée dans le message
    assert "GitHub (lu à l'instant, fait foi" in prompt and "mergée" in prompt
    assert "répond à Lucas Bernard (16:50) : « Tu peux relire la PR #214 ? »" in prompt


def test_github_off_is_not_consulted(make_client, monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("GitHub désactivé : aucune lecture")
    monkeypatch.setattr(gh, "fetch", boom)
    client, _w, _d = make_client(brain=_brain({"claims": []}))
    assert client.put("/api/settings", json={"github": {"enabled": False}}).status_code == 200
    r = _check(client, text="La PR #214 est mergée.")
    assert r.status_code == 200 and r.json()["check"]["sources"]["github"] == 0


def _incoming(text="Pour la recette, on part sur quel build ?"):
    return IncomingMessage(thread_id=SOFIA, sender="Sofia Marino", text=text, received_at="10:50", surface=Surface.dm)


def test_auto_send_held_back_when_contradicted(make_client):
    brain = _brain()
    brain.reply = "On part sur la recette de vendredi."
    _client, watcher, driver = make_client(brain=brain)
    assert watcher._process(_incoming()) == "draft"
    assert driver.typed == []
    assert any(d.thread_id == SOFIA and d.proposal == brain.reply for d in watcher.state.drafts)
    assert any("suspendu" in log.text and "vendredi" in log.text for log in watcher.state.logs)


def test_auto_send_goes_on_when_check_fails_or_is_clean(make_client):
    _client, watcher, driver = make_client(brain=FakeBrain(completion="pas de JSON"))
    assert watcher._process(_incoming()) == "sent"
    assert driver.typed == [(SOFIA, "Réponse de test", True)]

    _client2, watcher2, driver2 = make_client(brain=_brain({"claims": []}))
    assert watcher2._process(_incoming()) == "sent"


def test_auto_check_can_be_turned_off(make_client):
    brain = _brain()
    _client, watcher, driver = make_client(brain=brain)
    watcher.cfg["reply"]["fact_check_before_auto_send"] = False
    assert watcher._process(_incoming()) == "sent"
    assert brain.prompts == []
