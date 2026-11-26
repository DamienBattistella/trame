"""Liens et cartes d'aperçu des messages Teams : vérifiés au passage du pont, gardés hors du
texte, rendus au cerveau en « texte (adresse) » et une ligne par carte."""
from __future__ import annotations

from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver
from models import CardRef, IncomingMessage, LinkRef, Surface, brain_text
import search

DM = "19:bb22@thread.v2"
JIRA = "https://example.atlassian.net/browse/ABC-12"
PR = "https://github.com/example/app/pull/42"
TEXT = "Deux fiches :\n[ABC-12] Recherche patient - Jira\n[ABC-13] Création patient - Jira"
LINKS = [LinkRef(text="[ABC-12] Recherche patient - Jira", url=JIRA),
         LinkRef(text="[ABC-13] Création patient - Jira", url="https://example.atlassian.net/browse/ABC-13")]
CARDS = [CardRef(source="Jira", title="ABC-12: Recherche patient", url=JIRA, fields=["Assigned to Alex Martin", "OPEN"]),
         CardRef(source="GitHub", title="Mapping des résultats · Pull Request #42", url=PR)]


def _bridge(monkeypatch, messages):
    driver = WebBridgeDriver()
    monkeypatch.setattr(driver, "_rpc", lambda op, timeout=None, **a: {"messages": messages, "top": True})
    return driver


def test_bridge_keeps_only_web_links_and_checked_cards(monkeypatch):
    driver = _bridge(monkeypatch, [
        {"sender": "Yves", "text": TEXT, "at": "16:59",
         "links": [{"text": "  [ABC-12]   Recherche patient - Jira ", "url": JIRA},
                   {"text": "clique", "url": "javascript:alert(1)"},
                   {"text": "fichier", "url": "file:///C:/secret.txt"},
                   {"text": "", "url": PR},
                   "pas un lien"],
         "cards": [{"source": "Jira", "title": "ABC-12: Recherche patient", "url": JIRA,
                    "fields": ["Assigned to Alex Martin", "", "Medium", "OPEN", "en trop"]},
                   {"source": "Piège", "title": "", "url": "javascript:void(0)"},
                   {"source": "Site", "title": "Sans adresse", "url": "data:text/html,x"}]},
        # Un message fait seulement d'une carte n'est pas vide.
        {"sender": "Yves", "text": "", "at": "17:00", "cards": [{"source": "GitHub", "title": "PR", "url": PR}]},
    ])
    msgs, _top = driver.read_history(DM, 30)
    assert len(msgs) == 2
    assert msgs[0].links == [LinkRef(text="[ABC-12] Recherche patient - Jira", url=JIRA), LinkRef(text=PR, url=PR)]
    assert msgs[0].cards == [
        CardRef(source="Jira", title="ABC-12: Recherche patient", url=JIRA, fields=["Assigned to Alex Martin", "Medium"]),
        CardRef(source="Site", title="Sans adresse", url=""),
    ]
    assert msgs[1].text == "" and msgs[1].cards[0].url == PR


def test_deleted_message_has_no_links_nor_cards(monkeypatch):
    driver = _bridge(monkeypatch, [{"sender": "Yves", "text": "Ce message a été supprimé.", "links": [{"text": "x", "url": PR}],
                                    "cards": [{"source": "GitHub", "title": "PR", "url": PR}]}])
    m = driver.read_history(DM, 30)[0][0]
    assert m.deleted and m.links == [] and m.cards == []


def test_brain_text_puts_the_address_after_the_link_text_and_summarises_cards():
    assert brain_text(TEXT, LINKS, CARDS) == (
        "Deux fiches :\n"
        f"[ABC-12] Recherche patient - Jira ({JIRA})\n"
        "[ABC-13] Création patient - Jira (https://example.atlassian.net/browse/ABC-13)\n"
        f"[aperçu Jira : ABC-12: Recherche patient (Assigned to Alex Martin, OPEN) {JIRA}]\n"
        f"[aperçu GitHub : Mapping des résultats · Pull Request #42 {PR}]"
    )


def test_brain_text_does_not_repeat_an_address_already_in_the_text():
    assert brain_text(f"Relis {PR} stp", [LinkRef(text=PR, url=PR)], []) == f"Relis {PR} stp"
    # Texte du lien introuvable (Teams l'a reformulé) : le lien est ajouté à la fin.
    assert brain_text("Voici", [LinkRef(text="la doc", url="https://example.com/doc")], []) == "Voici\nla doc (https://example.com/doc)"
    assert brain_text("Rien", [], []) == "Rien"


class RichDriver(MockTeamsDriver):
    def read_context(self, thread_id, last_n):
        return [IncomingMessage(thread_id=thread_id, sender="Lucas Bernard", text=TEXT, received_at="16:59",
                                surface=Surface.dm, links=LINKS, cards=CARDS)]


def test_thread_api_returns_links_and_cards_apart_from_the_text(make_client):
    client, _watcher, _driver = make_client(driver=RichDriver(interval=9999))
    m = client.get("/api/threads/19%3Abb22%40thread.v2/messages").json()["messages"][0]
    assert m["text"] == TEXT
    assert m["links"][0] == {"text": "[ABC-12] Recherche patient - Jira", "url": JIRA}
    assert m["cards"][0] == {"source": "Jira", "title": "ABC-12: Recherche patient", "url": JIRA,
                             "fields": ["Assigned to Alex Martin", "OPEN"]}


def test_brain_reads_link_addresses_and_card_summaries(make_client):
    _client, watcher, _driver = make_client(driver=RichDriver(interval=9999))
    text = watcher._read_focused(DM, "Lucas Bernard", 30)[0].text
    assert f"Recherche patient - Jira ({JIRA})" in text
    assert "[aperçu GitHub" in text and PR in text
    # Le contexte GitHub repère la PR de la carte dans ce que lit le cerveau.
    from github import context as gh
    assert gh.linked_refs(text)
    # Résumé du fil (réponse automatique) : même texte.
    assert JIRA in watcher._summary(DM, 15)


def test_fact_check_context_includes_links(make_client):
    _client, watcher, _driver = make_client(driver=RichDriver(interval=9999))
    msgs, _top = watcher.thread_history(DM, 10)
    said = brain_text(msgs[0]["text"], [LinkRef(**x) for x in msgs[0]["links"]], [CardRef(**x) for x in msgs[0]["cards"]])
    assert JIRA in said and "[aperçu Jira" in said


def test_search_results_carry_links_and_cards():
    archive = search.MessageArchive()
    archive.add(DM, [IncomingMessage(thread_id=DM, sender="Lucas", text=TEXT, received_at="16:59", surface=Surface.dm,
                                     links=LINKS, cards=CARDS)])
    hit = archive.search("recherche patient", {DM: "Lucas"}, lambda s: False)[0]
    assert hit["links"][0]["url"] == JIRA and hit["cards"][1]["url"] == PR
    # Relu plus tard avec ses liens : le résultat les prend.
    archive2 = search.MessageArchive()
    archive2.add(DM, [IncomingMessage(thread_id=DM, sender="Lucas", text=TEXT, received_at="", surface=Surface.dm)])
    archive2.add(DM, [IncomingMessage(thread_id=DM, sender="Lucas", text=TEXT, received_at="", surface=Surface.dm, links=LINKS)])
    assert archive2.search("fiches", {}, lambda s: False)[0]["links"][1]["text"] == "[ABC-13] Création patient - Jira"


def test_mock_demo_message_has_a_text_link_a_jira_card_and_a_github_card():
    msgs = MockTeamsDriver(interval=9999).read_context("19:ee55@thread.v2", 30)
    rich = next(m for m in msgs if m.cards)
    assert rich.links and {c.source for c in rich.cards} == {"Jira", "GitHub"}
    assert all(link.url not in rich.text for link in rich.links)
