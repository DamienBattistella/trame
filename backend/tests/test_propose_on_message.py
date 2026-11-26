"""« Proposer une réponse à ce message » (barre de survol d'un message) : la proposition
porte sur le message choisi, pas sur le dernier du fil, et n'est jamais envoyée."""
import json

from conftest import FakeBrain
from models import FileRef, ImageRef, IncomingMessage, Surface

DM = "19:aa11@thread.v2"
DM_URL = "/api/threads/19%3Aaa11%40thread.v2"
TARGET = {"id": "m2", "sender": "Sofia Marino", "text": "Oui, le test du parseur OBX tombe en timeout sur le runner Windows."}
ENTOURAGE = {"version": 1, "people": [{"name": "Sofia Marino", "role": "Cheffe de projet", "team": "Interop",
                                       "relation": "N+1", "tone": "vouvoiement"}]}
OWN = {"id": "m5", "sender": "Damien Battistella", "text": "Je le relance avec le cache réchauffé, je te dis."}


class SummaryBrain(FakeBrain):
    """Retient aussi le contexte du fil donné au cerveau."""

    def __init__(self):
        super().__init__()
        self.summaries: list[str] = []

    def draft(self, soul, thread_summary, incoming, github_context="", people_context=""):
        self.summaries.append(thread_summary)
        return super().draft(soul, thread_summary, incoming, github_context, people_context)


def test_prompt_is_centred_on_the_chosen_message(make_client):
    brain = SummaryBrain()
    client, _watcher, _driver = make_client(brain=brain)
    client.post("/api/people", json={"filename": "entourage.json", "content": json.dumps(ENTOURAGE)})
    r = client.post(f"{DM_URL}/suggest", json={"message": TARGET})
    assert r.status_code == 200 and r.json()["text"] == "Réponse de test"
    # Le message choisi est celui auquel répondre, pas « Le build passe de ton côté ? ».
    assert brain.calls == [TARGET["text"]]
    summary = brain.summaries[0]
    head, _, tail = summary.partition("(Messages arrivés après le message ciblé, pour contexte seulement :)")
    assert "la CI est rouge sur main" in head and TARGET["text"] not in head
    assert "Le build passe de ton côté ?" in tail
    assert summary.endswith("(La réponse cite et répond précisément au message suivant de Sofia Marino, pas au dernier du fil.)")
    # Fiche de l'auteur du message choisi.
    assert "Sofia Marino : Cheffe de projet" in brain.people[0]


def test_own_message_asks_for_a_follow_up(make_client):
    brain = SummaryBrain()
    client, _watcher, _driver = make_client(brain=brain)
    assert client.post(f"{DM_URL}/suggest", json={"message": OWN}).status_code == 200
    assert brain.calls == [OWN["text"]]
    assert "est le tien : propose une relance ou un complément" in brain.summaries[0]
    assert "répond précisément au message suivant" not in brain.summaries[0]


def test_attachments_of_the_chosen_message_are_named(make_client):
    brain = SummaryBrain()
    client, _watcher, driver = make_client(brain=brain)
    seen = IncomingMessage(thread_id=DM, sender="Sofia Marino", text="bah bravo", received_at="16:47", surface=Surface.dm,
                           id="m99", images=[ImageRef(data="data:image/png;base64,AAAA", width=10, height=10)],
                           files=[FileRef(name="trace.log")])
    only_image = IncomingMessage(thread_id=DM, sender="Sofia Marino", text="", received_at="16:48", surface=Surface.dm,
                                 id="m100", images=[ImageRef()])
    base = driver.read_history
    driver.read_history = lambda tid, n: (base(tid, n)[0] + [seen, only_image], False)

    # Le texte vu dans Trame (sans les pièces jointes) suffit à retrouver le message.
    r = client.post(f"{DM_URL}/suggest", json={"message": {"id": "m99", "sender": "Sofia Marino", "text": "bah bravo"}})
    assert r.status_code == 200
    assert brain.calls[-1] == "bah bravo\n[fichier joint : trace.log]\n[image]"
    assert "Le build passe de ton côté ?" in brain.summaries[-1]

    # Une image seule : l'UI la désigne par « [image] ».
    r = client.post(f"{DM_URL}/suggest", json={"message": {"id": "m100", "sender": "Sofia Marino", "text": "[image]"}})
    assert r.status_code == 200 and brain.calls[-1] == "[image]"
    assert "bah bravo" in brain.summaries[-1] and "pour contexte seulement" not in brain.summaries[-1]


def test_message_not_found_answers_the_text_seen(make_client):
    brain = SummaryBrain()
    client, watcher, _driver = make_client(brain=brain)
    # Même identifiant, autre texte : ce n'est pas le message vu, on ne le prend pas pour lui.
    changed = {**TARGET, "text": "Un texte qui n'est plus celui du message m2."}
    assert client.post(f"{DM_URL}/suggest", json={"message": changed}).status_code == 200
    assert brain.calls == [changed["text"]]
    summary = brain.summaries[0]
    assert TARGET["text"] in summary and "pour contexte seulement" not in summary
    steps = [s["text"] for run in watcher.reflections.snapshot() for s in run["steps"]]
    assert any("hors des derniers messages lus" in s for s in steps)


def test_never_sent_even_in_auto_mode(make_client):
    brain = FakeBrain()
    client, watcher, driver = make_client(brain=brain)
    conv = next(w for w in watcher.state.watchlist if w.thread_id == DM)
    assert conv.mode == "auto"
    drafts = [d.id for d in watcher.state.drafts]
    for target in (TARGET, OWN):
        assert client.post(f"{DM_URL}/suggest", json={"message": target}).status_code == 200
    assert driver.typed == []
    assert [d.id for d in watcher.state.drafts] == drafts
    assert client.get("/api/state").json()["outbox"] == []


def test_brain_failure_is_reported(make_client):
    class Broken(FakeBrain):
        def draft(self, *a, **k):
            raise RuntimeError("cerveau injoignable")

    client, _watcher, driver = make_client(brain=Broken())
    r = client.post(f"{DM_URL}/suggest", json={"message": TARGET})
    assert r.status_code == 502 and "cerveau injoignable" in r.json()["error"]
    assert driver.typed == []
