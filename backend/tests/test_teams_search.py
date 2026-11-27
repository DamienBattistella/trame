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


# --- deux étapes : conversations récentes sur le service, puis tout l'historique ---

class RecentSearch(MockTeamsDriver):
    """Un pilote avec la recherche des conversations récentes (service de chat)."""

    can_search_recent = True

    def __init__(self, *a, recent=None, fail=None, sharing=False, **kw):
        super().__init__(*a, **kw)
        self.recent_answer = recent if recent is not None else []
        self.recent_fail = fail
        self.sharing = sharing
        self.recent_calls: list[str] = []
        self.deep_calls: list[str] = []

    def search_recent(self, query, limit=25):
        self.recent_calls.append(query)
        if self.recent_fail:
            raise RuntimeError(self.recent_fail)
        return [dict(r) for r in self.recent_answer]

    def search_messages(self, query, limit=25):
        self.deep_calls.append(query)
        return [{"conversation": "", "sender": "Marc", "mine": False, "at": "12/03/2026", "text": "vieux budget 2025"}]

    def is_screen_sharing(self):
        return self.sharing


def test_first_step_searches_recent_conversations_without_teams_window_then_history_on_demand(make_client):
    recent = [{"conversation": "Homonyme", "thread_id": None, "sender": "Ana", "mine": False, "at": "10:00", "text": "budget validé"}]
    driver = RecentSearch(interval=9999, recent=recent)
    client, watcher, _ = make_client(driver=driver)
    target = watcher.state.watchlist[0]
    driver.recent_answer = [{**recent[0], "thread_id": target.thread_id}]
    first = client.post("/api/search/teams", json={"q": "budget"}).json()
    assert first["scope"] == "recent" and driver.deep_calls == []
    # La conversation vient de l'id donné par le service, jamais d'un nom deviné.
    assert first["results"][0]["thread_id"] == target.thread_id
    assert first["results"][0]["conversation"] == target.display_name
    deep = client.post("/api/search/teams", json={"q": "budget", "deep": True}).json()
    assert deep["scope"] == "teams" and driver.deep_calls == ["budget"]


def test_recent_search_runs_during_screen_share_but_history_does_not(make_client):
    driver = RecentSearch(interval=9999, sharing=True)
    client, _w, _ = make_client(driver=driver)
    assert client.post("/api/search/teams", json={"q": "budget"}).json()["scope"] == "recent"
    assert client.post("/api/search/teams", json={"q": "budget", "deep": True}).status_code == 409


def test_recent_search_failure_falls_back_to_teams_search(make_client):
    driver = RecentSearch(interval=9999, fail="service de chat indisponible")
    client, _w, _ = make_client(driver=driver)
    res = client.post("/api/search/teams", json={"q": "budget"}).json()
    assert res["scope"] == "teams" and driver.deep_calls == ["budget"]


def test_words_apart_are_still_highlighted():
    from search import hit
    h = hit(None, "x", "Ana", "10:00", False, "Le budget de la PR 214 est validé", "budget validé")
    assert h["match"] is not None
    assert h["excerpt"][h["match"][0]:h["match"][1]] == "budget"  # longueurs égales : l'ordre de la requête
    h = hit(None, "x", "Ana", "10:00", False, "Le budget de la PR 214 est validé", "pr validé")
    assert h["excerpt"][h["match"][0]:h["match"][1]] == "validé"  # le plus long d'abord
