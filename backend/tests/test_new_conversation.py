from __future__ import annotations
import json

from conftest import RefusingDriver
from drivers.mock import MockTeamsDriver
from drivers.unavailable import UnavailableDriver
from drivers.web_bridge import WebBridgeDriver
from models import Surface, WatchEntity
from people import Directory, PeopleFile

ENTOURAGE = {
    "version": 1,
    "people": [
        {"name": "Lucas Bernard", "role": "Développeur interop", "team": "Hexagone", "manager": "Sofia Marino"},
        {"name": "Élodie Faure", "aliases": ["Lolo"], "role": "Testeuse", "team": "Qualité"},
        {"name": "Hugo Lannes", "role": "Architecte", "team": "Interop"},
        {"name": "Hugues Lebrun", "role": "Chef de projet", "team": "PMSI"},
    ],
}


def _load(client):
    r = client.post("/api/people", json={"filename": "e.json", "content": json.dumps(ENTOURAGE)})
    assert r.json()["ok"]


def test_directory_search_by_word_prefix_alias_and_team():
    d = Directory(PeopleFile.model_validate(ENTOURAGE))
    assert [p.name for p in d.search("hug")] == ["Hugo Lannes", "Hugues Lebrun"]
    assert [p.name for p in d.search("lannes hu")] == ["Hugo Lannes"]
    assert [p.name for p in d.search("elodie")] == ["Élodie Faure"]
    assert [p.name for p in d.search("lolo")] == ["Élodie Faure"]
    assert [p.name for p in d.search("qualite")] == ["Élodie Faure"]
    assert [p.name for p in d.search("arch")] == ["Hugo Lannes"]
    assert d.search("ali") == []  # no match inside a word ("qualité")
    assert d.search("") == [] and d.search("zzz") == []
    assert len(d.search("hu", limit=1)) == 1 and len(d.search("hu")) == 2


def test_search_gives_entourage_then_teams_and_points_at_existing_chats(make_client):
    client, _w, _d = make_client()
    _load(client)
    res = client.get("/api/people/search", params={"q": "luc"}).json()
    assert res["ok"] and res["can_start"] and res["teams_search"]
    lucas = res["people"][0]
    assert lucas == {"name": "Lucas Bernard", "role": "Développeur interop", "team": "Hexagone",
                     "manager": "Sofia Marino", "source": "entourage", "thread_id": "19:bb22@thread.v2"}
    # Not in the entourage: found by the (mock) Teams people search.
    alice = client.get("/api/people/search", params={"q": "alice"}).json()["people"]
    assert alice == [{"name": "Alice Martin", "role": None, "team": None, "manager": None,
                      "source": "teams", "thread_id": None}]
    # The same person from both sources is listed once, from the entourage.
    both = client.get("/api/people/search", params={"q": "lucas"}).json()["people"]
    assert [(p["name"], p["source"]) for p in both] == [("Lucas Bernard", "entourage")]


def test_start_opens_the_chat_adds_it_unfollowed_and_it_can_be_written_to(make_client, fresh_home):
    client, watcher, driver = make_client()
    _load(client)
    r = client.post("/api/conversations/start", json={"name": "Hugo Lannes"}).json()
    assert r["ok"]
    conv = r["conversation"]
    assert conv["display_name"] == "Hugo Lannes" and conv["surface"] == "dm" and conv["watch"] is False
    assert driver.active_thread() == conv["thread_id"]
    state = client.get("/api/state").json()
    assert state["watchlist"][0]["thread_id"] == conv["thread_id"]
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))["watchlist"]
    assert any(w["thread_id"] == conv["thread_id"] for w in saved)
    assert driver.typed == []  # opening types nothing
    sent = client.post(f"/api/threads/{conv['thread_id']}/send", json={"text": "Salut Hugo"})
    assert sent.json() == {"ok": True}
    assert driver.typed[-1] == (conv["thread_id"], "Salut Hugo", True)
    # Starting again does not create a second conversation.
    again = client.post("/api/conversations/start", json={"name": "hugo  lannes"}).json()
    assert again["conversation"]["thread_id"] == conv["thread_id"]
    assert sum(w.display_name == "Hugo Lannes" for w in watcher.state.watchlist) == 1


def test_start_with_an_existing_chat_returns_it_without_touching_teams(make_client):
    client, _w, driver = make_client()
    r = client.post("/api/conversations/start", json={"name": "Chiara Rossi"}).json()
    assert r["conversation"]["thread_id"] == "19:ee55@thread.v2"
    assert driver.opened == []


def test_started_chat_survives_a_refresh_until_teams_lists_it(make_client):
    client, watcher, driver = make_client()
    tid = client.post("/api/conversations/start", json={"name": "Alice Martin"}).json()["conversation"]["thread_id"]
    driver._convs = [c for c in driver._convs if c.thread_id != tid]  # Teams does not list it yet
    client.post("/api/conversations/refresh")
    assert any(w.thread_id == tid for w in watcher.state.watchlist)


def test_start_refused_when_the_driver_cannot(make_client):
    client, _w, _d = make_client(driver=UnavailableDriver("test"))
    res = client.get("/api/people/search", params={"q": "x"}).json()
    assert res["can_start"] is False and res["unsupported"]
    r = client.post("/api/conversations/start", json={"name": "Hugo Lannes"})
    assert r.status_code == 501 and "Nouvelle conversation impossible" in r.json()["error"]


def test_start_refused_when_teams_does_not_confirm(make_client):
    class WrongTitle(MockTeamsDriver):
        def start_chat(self, name):
            return WatchEntity(thread_id="19:zz@unq.gbl.spaces", display_name="Quelqu'un d'autre", surface=Surface.dm)

    client, watcher, _d = make_client(driver=WrongTitle(interval=9999))
    before = len(watcher.state.watchlist)
    r = client.post("/api/conversations/start", json={"name": "Hugo Lannes"})
    assert r.status_code == 409 and "non ouverte" in r.json()["error"]
    assert len(watcher.state.watchlist) == before


def test_start_unknown_person_is_refused(make_client):
    driver = MockTeamsDriver(interval=9999)
    driver.allow_anyone = False
    client, _w, _d = make_client(driver=driver)
    r = client.post("/api/conversations/start", json={"name": "Personne Inconnue"})
    assert r.status_code == 409 and "introuvable dans Teams" in r.json()["error"]
    assert client.post("/api/conversations/start", json={"name": "  "}).status_code == 422


def test_start_refused_during_screen_share(make_client):
    class Sharing(RefusingDriver):
        def is_screen_sharing(self):
            return True

    client, _w, driver = make_client(driver=Sharing(interval=9999))
    r = client.post("/api/conversations/start", json={"name": "Alice Martin"})
    assert r.status_code == 409 and "Partage d'écran" in r.json()["error"]
    assert driver.opened == []


def test_web_bridge_start_chat_needs_the_title_and_keeps_the_rail_id():
    d = WebBridgeDriver()
    answers = {"newchat": {"ok": True, "title": "Chat | Hugo Lannes | Microsoft Teams"},
               "list": [{"label": "Hugo Lannes 10:02 salut", "id": "19:abc@unq.gbl.spaces"}]}
    d._rpc = lambda op, **_: answers[op]
    conv = d.start_chat("Hugo Lannes")
    assert (conv.thread_id, conv.display_name, conv.surface) == ("19:abc@unq.gbl.spaces", "Hugo Lannes", Surface.dm)
    # Brand-new chat, not in the list yet: known by its name.
    answers["list"] = []
    d._names.clear()
    assert d.start_chat("Hugo Lannes").thread_id == "name:Hugo Lannes"
    # Another title: refused, with the reason.
    answers["newchat"] = {"ok": True, "title": "Chat | Hugues Lebrun | Microsoft Teams"}
    assert d.start_chat("Hugo Lannes") is None and "Hugues Lebrun" in d.last_error
    answers["newchat"] = {"ok": False, "title": "", "error": "2 personnes nommées « Hugo Lannes » dans Teams"}
    assert d.start_chat("Hugo Lannes") is None and "2 personnes" in d.last_error


def test_web_bridge_start_chat_without_relay_fails_safe():
    d = WebBridgeDriver()
    assert d.start_chat("Hugo Lannes") is None and "pas prête" in d.last_error


def test_chat_started_by_name_takes_its_teams_id_once_listed(make_client):
    _client, watcher, _d = make_client()
    started = WatchEntity(thread_id="name:Hugo Lannes", display_name="Hugo Lannes", surface=Surface.dm, watch=True)
    watcher.state.watchlist = [started]
    watcher._started.add(started.thread_id)
    listed = WatchEntity(thread_id="19:abc@unq.gbl.spaces", display_name="Hugo Lannes", surface=Surface.dm)
    merged = watcher._merge([listed])
    assert [(w.thread_id, w.watch) for w in merged] == [("19:abc@unq.gbl.spaces", True)]
    assert watcher._started == {"19:abc@unq.gbl.spaces"}
