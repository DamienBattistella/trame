from __future__ import annotations

from models import IncomingMessage, Surface
import search

DM = "19:bb22@thread.v2"
GROUP = "19:cc33@thread.v2"


def _m(text: str, sender: str = "Lucas Bernard", at: str = "10:00", thread_id: str = DM) -> IncomingMessage:
    return IncomingMessage(thread_id=thread_id, sender=sender, text=text, received_at=at, surface=Surface.dm)


def _search(archive, q, **kw):
    return archive.search(q, {DM: "Lucas Bernard"}, lambda s: s == "Damien", **kw)


def test_fold_ignores_case_accents_and_spaces():
    assert search.fold("  Épinglé   ÇA  ") == "epingle ca"
    folded, origin = search.fold_map("Où ça")
    assert folded == "ou ca" and origin == [0, 1, 2, 3, 4]


def test_match_ignores_case_and_accents_and_points_at_original_text():
    a = search.MessageArchive()
    a.add(DM, [_m("Il faudrait épingler la version de l'image du runner.")])
    [hit] = _search(a, "EPINGLER la")
    s, e = hit["match"]
    assert hit["excerpt"][s:e] == "épingler la"
    assert hit["conversation"] == "Lucas Bernard" and hit["sender"] == "Lucas Bernard" and hit["at"] == "10:00"
    assert hit["thread_id"] == DM and hit["mine"] is False


def test_query_with_accents_finds_text_without():
    a = search.MessageArchive()
    a.add(DM, [_m("on garde le creneau de 14h")])
    assert len(_search(a, "créneau")) == 1


def test_short_or_blank_query_returns_nothing():
    a = search.MessageArchive()
    a.add(DM, [_m("a b c")])
    assert _search(a, " ") == [] and _search(a, "a") == []


def test_newest_seen_first_and_limit():
    a = search.MessageArchive()
    a.add(DM, [_m(f"build numéro {i}") for i in range(5)])
    hits = _search(a, "build", limit=3)
    assert [h["text"] for h in hits] == ["build numéro 4", "build numéro 3", "build numéro 2"]


def test_same_message_read_twice_is_kept_once_with_teams_time():
    a = search.MessageArchive()
    a.add(DM, [_m("PR #214 relue", at="10:41")])
    a.add(DM, [_m("PR #214 relue", at="Hier 10:41")])
    [hit] = _search(a, "#214")
    assert hit["at"] == "Hier 10:41"
    assert a.scope()["messages"] == 1 and a.scope()["conversations"] == 1


def test_long_message_excerpt_is_centered_on_the_match():
    text = ("mot " * 60) + "Le blocage restant, c'est le typage OBX-2." + (" suite" * 60)
    a = search.MessageArchive()
    a.add(DM, [_m(text)])
    [hit] = _search(a, "typage obx")
    s, e = hit["match"]
    assert hit["excerpt"][s:e] == "typage OBX"
    assert hit["excerpt"].startswith("…") and hit["excerpt"].endswith("…")
    assert len(hit["excerpt"]) <= 142


def test_multiline_text_matches_across_line_breaks():
    a = search.MessageArchive()
    a.add(DM, [_m("Bonjour,\n\nle  build\test vert")])
    [hit] = _search(a, "le build est")
    s, e = hit["match"]
    assert hit["excerpt"] == "Bonjour, le build est vert" and hit["excerpt"][s:e] == "le build est"
    assert hit["text"] == "Bonjour,\n\nle  build\test vert"


def test_per_thread_cap_drops_the_oldest():
    a = search.MessageArchive()
    a.PER_THREAD = 3
    a.add(DM, [_m(f"message {i}") for i in range(5)])
    assert [h["text"] for h in _search(a, "message")] == ["message 4", "message 3", "message 2"]


# --- through the engine ---

def test_api_search_covers_what_was_read_and_received(make_client):
    client, watcher, _driver = make_client()
    assert client.get("/api/search", params={"q": "obx"}).json()["results"] == []
    client.get(f"/api/threads/{DM}/messages")
    watcher._process(_m("Le créneau de 14h me va", sender="Sofia Marino", thread_id=GROUP))
    body = client.get("/api/search", params={"q": "OBX-2"}).json()
    assert body["ok"] is True and body["results"]
    assert {r["conversation"] for r in body["results"]} == {"Lucas Bernard"}
    assert all("obx-2" in search.fold(r["text"]) for r in body["results"])
    hits = client.get("/api/search", params={"q": "creneau de 14H"}).json()["results"]
    assert [(h["conversation"], h["sender"]) for h in hits] == [("Équipe Interop", "Sofia Marino")]
    scope = body["scope"]
    assert scope["conversations"] == 2 and scope["messages"] >= 13 and scope["since"]


def test_search_reads_nothing_in_teams(make_client):
    client, _watcher, driver = make_client()
    client.get("/api/search", params={"q": "build"})
    assert driver.opened == [] and driver.typed == []


def test_factory_reset_forgets_the_archive(make_client):
    client, watcher, _driver = make_client()
    client.get(f"/api/threads/{DM}/messages")
    assert watcher.archive.scope()["messages"] > 0
    watcher.factory_reset()
    assert watcher.archive.scope()["messages"] == 0
