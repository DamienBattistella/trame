from __future__ import annotations
import json

from conftest import FakeBrain
from brain.base import build_prompt
from models import IncomingMessage, Surface
from people import Directory

DM = "19:bb22@thread.v2"
ENTOURAGE = {
    "version": 1,
    "source": "Orbite",
    "generated_at": "2026-11-26T08:00:00Z",
    "people": [
        {"name": "Lucas Bernard", "role": "Développeur interop", "team": "Hexagone", "relation": "collègue",
         "tone": "tutoiement, court et technique"},
        {"name": "Sofia Marino", "aliases": ["S. Marino"], "email": "sofia.marino@exemple.fr", "role": "Cheffe de projet",
         "team": "Interop", "relation": "N+1", "tone": "vouvoiement"},
    ],
}


def _post(client, content, filename="entourage.json"):
    return client.post("/api/people", json={"filename": filename, "content": content})


def test_list_gives_each_person_without_email(make_client, fresh_home):
    client, _w, _d = make_client()
    assert client.get("/api/people/list").json() == {"ok": True, "people": []}
    _post(client, json.dumps(ENTOURAGE))
    people = client.get("/api/people/list").json()["people"]
    assert [p["name"] for p in people] == ["Lucas Bernard", "Sofia Marino"]
    assert people[1] == {"name": "Sofia Marino", "aliases": ["S. Marino"], "role": "Cheffe de projet", "team": "Interop",
                         "relation": "N+1", "tone": "vouvoiement", "note": None}


def test_matching_ignores_order_case_accents_and_email():
    d = Directory(Directory.parse(json.dumps(ENTOURAGE)))
    assert d.find("BERNARD Lucas").name == "Lucas Bernard"
    assert d.find("lucas bernard (Externe)").name == "Lucas Bernard"
    assert d.find("Sofia MARINO").relation == "N+1"
    assert d.find("S. Marino").name == "Sofia Marino"
    assert d.find("Inconnu Total") is None
    assert Directory.label(d.find("Lucas Bernard")) == "Développeur interop · Hexagone"


def test_import_feeds_prompt_and_draft_label(make_client, fresh_home):
    brain = FakeBrain()
    client, watcher, _ = make_client(brain=brain)
    r = _post(client, json.dumps(ENTOURAGE))
    assert r.status_code == 200 and r.json()["people"] == {
        "loaded": True, "count": 2, "source": "Orbite", "generated_at": "2026-11-26T08:00:00Z"}
    assert (fresh_home / "ENTOURAGE.json").exists()
    msg = IncomingMessage(thread_id=DM, sender="Lucas Bernard", text="Tu regardes ?", received_at="10:00", surface=Surface.dm)
    assert watcher._process(msg) == "draft"
    assert "Lucas Bernard : Développeur interop, équipe Hexagone, collègue. Ton : tutoiement" in brain.people[-1]
    d = next(x for x in watcher.state.drafts if x.thread_id == DM)
    assert d.sender_label == "Développeur interop · Hexagone"
    assert '"sender_label":"Développeur interop · Hexagone"' in watcher.state.model_dump_json(by_alias=True)


def test_invalid_files_are_refused_and_nothing_replaced(make_client, fresh_home):
    client, watcher, _ = make_client()
    assert _post(client, json.dumps(ENTOURAGE)).status_code == 200
    assert _post(client, "{pas du json").status_code == 422
    assert _post(client, json.dumps({"people": [{"role": "sans nom"}]})).status_code == 422
    assert _post(client, json.dumps(ENTOURAGE), filename="entourage.txt").status_code == 422
    assert watcher.people_summary().count == 2


def test_remove(make_client, fresh_home):
    client, watcher, _ = make_client()
    _post(client, json.dumps(ENTOURAGE))
    assert client.delete("/api/people").json() == {"ok": True}
    assert client.get("/api/people").json()["people"]["loaded"] is False
    assert not (fresh_home / "ENTOURAGE.json").exists()


def test_prompt_section_only_when_known():
    assert "interlocuteurs" not in build_prompt("soul", "", "salut", "")
    assert "- Lucas" in build_prompt("soul", "", "salut", "", "- Lucas Bernard : dev")
