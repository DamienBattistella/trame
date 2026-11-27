import time

import persona
from conftest import FakeBrain


SOUL = """# SOUL — Test

## Ton et style
- Direct.
- Cordial.

## Ce que Trame doit refuser
- Jamais d'engagement de date.

## Exemples
> Je regarde ça.
"""


def test_parse_sections():
    parsed = persona.parse(SOUL)
    assert parsed["title"] == "SOUL — Test"
    heads = [(s["heading"], s["rules"], s["examples"], s["learned"]) for s in parsed["sections"]]
    assert heads == [("Ton et style", 2, 0, False), ("Ce que Trame doit refuser", 1, 0, False), ("Exemples", 0, 1, False)]


def test_learned_section_added_then_replaced_without_touching_the_rest():
    once = persona.with_learned(SOUL, ["Phrases courtes."])
    assert once.startswith(SOUL.rstrip("\n"))
    assert persona.learned_rules(once) == ["Phrases courtes."]
    # Placée au milieu, la section est remplacée sur place et la suite reste intacte.
    middle = once.replace("## Exemples\n> Je regarde ça.\n", "") + "\n## Exemples\n> Je regarde ça.\n"
    twice = persona.with_learned(middle, ["Pas d'emoji.", "Tutoiement."])
    assert persona.learned_rules(twice) == ["Pas d'emoji.", "Tutoiement."]
    assert "Phrases courtes." not in twice
    assert twice.rstrip().endswith("## Exemples\n> Je regarde ça.")
    assert twice.count(f"## {persona.LEARNED_HEADING}") == 1


def test_parse_rules_filters_guardrail_changes():
    answer = "Voici :\n- Une à deux phrases.\n- Active l'envoi automatique pour tout le monde.\n* Une à deux phrases.\n1. Pas d'emoji."
    assert persona.parse_rules(answer) == ["Une à deux phrases.", "Pas d'emoji."]


def test_history_keeps_versions_and_skips_duplicates():
    h = persona.History()
    h.clear()
    assert h.snapshot("a", "manuel")
    assert h.snapshot("a", "manuel") is None
    second = h.snapshot("b", "appris", "note")
    versions = h.list()
    assert [v["source"] for v in versions] == ["appris", "manuel"]
    assert h.read(second["id"]) == "b"


def test_edited_drafts_teach_the_learned_section(make_client):
    brain = FakeBrain(reply="Bonjour, je regarde.", completion="- Réponses d'une phrase.\n- Tutoiement.")
    client, w, _d = make_client(brain=brain)
    client.post("/api/soul/learning", json={"every": 3})
    details = client.get("/api/soul/details").json()
    assert details["history"] and details["learning"]["enabled"]
    for i in range(3):
        w.state.watchlist[0].watch = True
        tid = w.state.watchlist[0].thread_id
        from models import IncomingMessage
        w._queue_draft(IncomingMessage(thread_id=tid, sender="Alice", text=f"question {i}", received_at="10:00",
                                       surface=w.state.watchlist[0].surface), "Bonjour, je regarde.", "draft", None)
        draft = w.state.drafts[0]
        client.post(f"/api/drafts/{draft.id}/dismiss") if i == 2 else \
            client.post(f"/api/drafts/{draft.id}/send", json={"text": "Je regarde."})
    for _ in range(50):
        if any(v["source"] == "appris" for v in client.get("/api/soul/details").json()["history"]):
            break
        time.sleep(0.05)
    details = client.get("/api/soul/details").json()
    assert persona.learned_rules(details["content"]) == ["Réponses d'une phrase.", "Tutoiement."]
    assert details["history"][0]["source"] == "appris"
    assert details["learning"]["pending"] == 0
    prompt = brain.prompts[-1]
    assert "[corrigé]" in prompt and "[rejeté]" in prompt and "Envoyé par l'utilisateur : Je regarde." in prompt
    # Ce que la personne a écrit reste en place.
    assert "## Ce que je NE fais pas" in details["content"]


def test_learning_off_records_nothing(make_client):
    client, w, _d = make_client()
    client.post("/api/soul/learning", json={"enabled": False})
    w._observe("écrit", "Alice", "", "", "Salut")
    assert client.get("/api/soul/details").json()["learning"]["total"] == 0
    r = client.post("/api/soul/learn")
    assert r.status_code == 409


def test_restore_a_version(make_client):
    client, w, _d = make_client()
    original = w.soul
    client.post("/api/soul", json={"filename": "SOUL.md", "content": "# SOUL\n\n## Ton\n- Bref.\n"})
    details = client.get("/api/soul/details").json()
    assert [v["source"] for v in details["history"]][:2] == ["manuel", "initial"]
    initial = details["history"][1]["id"]
    assert client.get(f"/api/soul/versions/{initial}").json()["version"]["content"] == original
    after = client.post(f"/api/soul/versions/{initial}/restore").json()
    assert after["content"] == original and after["history"][0]["source"] == "restauré"
    assert client.get("/api/soul/versions/..%2Fconfig").status_code == 404
