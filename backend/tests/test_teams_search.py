from __future__ import annotations

import pytest

from drivers.mock import MockTeamsDriver
from drivers.web_bridge import BridgeUnavailable, WebBridgeDriver
import search

DM = "19:bb22@thread.v2"


def test_teams_search_finds_older_messages_and_reads_nothing_else(make_client):
    client, watcher, driver = make_client()
    r = client.post("/api/search/teams", json={"q": "correspondance ucum"})
    assert r.status_code == 200
    hits = r.json()["results"]
    older = next(h for h in hits if h["at"] == "03/09 16:20")
    assert (older["thread_id"], older["conversation"], older["sender"], older["mine"]) == (DM, "Lucas Bernard", "Lucas Bernard", False)
    s, e = older["match"]
    assert older["excerpt"][s:e] == "correspondance UCUM"
    assert driver.opened == [] and driver.typed == []
    # Nothing Teams' search returned is mixed into what Trame has read.
    assert watcher.archive.scope()["messages"] == 0


def test_own_message_in_a_private_chat_has_no_conversation_name(make_client):
    client, _w, _d = make_client()
    hits = client.post("/api/search/teams", json={"q": "garde le code local"}).json()["results"]
    mine = next(h for h in hits if h["at"] == "03/09 16:24")
    assert mine["mine"] is True and mine["thread_id"] is None and mine["conversation"] == "Conversation privée"


def test_own_message_already_read_by_trame_finds_its_conversation(make_client):
    client, _w, _d = make_client()
    client.get(f"/api/threads/{DM}/messages")
    hits = client.post("/api/search/teams", json={"q": "OBX-5"}).json()["results"]
    [mine] = [h for h in hits if h["mine"]]
    assert (mine["thread_id"], mine["conversation"]) == (DM, "Lucas Bernard")


def test_teams_search_refusals(make_client):
    client, _w, _d = make_client()
    r = client.post("/api/search/teams", json={"q": " a "})
    assert r.status_code == 422 and "deux caractères" in r.json()["error"]

    class NoSearch(MockTeamsDriver):
        can_search_messages = False
        search_messages_unsupported = "pilote de test sans recherche"

    client, _w, _d = make_client(driver=NoSearch(interval=9999))
    r = client.post("/api/search/teams", json={"q": "ucum"})
    assert r.status_code == 501 and "pilote de test sans recherche" in r.json()["error"]

    class Sharing(MockTeamsDriver):
        def is_screen_sharing(self):
            return True

        def search_messages(self, query, limit=25):
            raise AssertionError("Teams ne doit pas être touché pendant un partage d'écran")

    client, _w, _d = make_client(driver=Sharing(interval=9999))
    r = client.post("/api/search/teams", json={"q": "ucum"})
    assert r.status_code == 409 and "Partage d'écran" in r.json()["error"]


def test_teams_search_failure_is_reported(make_client):
    class Broken(MockTeamsDriver):
        def search_messages(self, query, limit=25):
            raise BridgeUnavailable("Teams intégré : page de résultats de Teams non affichée")

    client, watcher, _d = make_client(driver=Broken(interval=9999))
    r = client.post("/api/search/teams", json={"q": "ucum"})
    assert r.status_code == 502 and "page de résultats" in r.json()["error"]
    assert any("Recherche dans Teams impossible" in l.text for l in watcher.state.logs)


def test_web_bridge_search_cleans_what_the_page_returns():
    d = WebBridgeDriver()
    seen = {}

    def rpc(op, **args):
        seen.update(op=op, **args)
        return {"ok": True, "results": [
            {"conversation": "Hexaflux", "sender": "Hugo Lannes", "mine": False, "at": "02/01 11:04", "text": " build sur mon pc "},
            {"conversation": "", "sender": "Damien Battistella", "mine": True, "at": "", "text": "   "},
        ]}

    d._rpc = rpc
    assert d.search_messages("  build   pc ", 10) == [
        {"conversation": "Hexaflux", "sender": "Hugo Lannes", "mine": False, "at": "02/01 11:04", "text": "build sur mon pc"},
    ]
    assert (seen["op"], seen["query"], seen["limit"]) == ("search", "build pc", 10)

    d._rpc = lambda op, **_: {"ok": False, "error": "champ de recherche de Teams introuvable"}
    with pytest.raises(BridgeUnavailable, match="champ de recherche"):
        d.search_messages("build")


def test_web_bridge_search_without_relay_fails_safe():
    with pytest.raises(BridgeUnavailable, match="pas prête"):
        WebBridgeDriver().search_messages("build")


def test_hit_without_the_words_shows_the_beginning():
    h = search.hit(None, "Hexaflux", "Hugo", "02/01", False, "Les builds de la pipeline sont lents", "build")
    assert h["match"] == [4, 9]
    h = search.hit(None, "Hexaflux", "Hugo", "02/01", False, "On a compilé hier soir", "compilation")
    assert h["match"] is None and h["excerpt"] == "On a compilé hier soir"
