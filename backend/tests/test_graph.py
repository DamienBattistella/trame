from __future__ import annotations
import json

import pytest

from drivers.graph import GraphDriver
from drivers.mock import MockTeamsDriver
from models import DELETED_TEXT, Surface, WatchEntity
from msgraph import convert
from msgraph.client import BASE, GraphClient, GraphError

ME = "11111111-1111-1111-1111-111111111111"
ALICE = "22222222-2222-2222-2222-222222222222"
DM = "19:aaa_bbb@unq.gbl.spaces"
GROUP = "19:group@thread.v2"


class FakeGraph:
    """Answers Graph requests from a route table; records every call."""

    def __init__(self, routes: dict):
        self.routes, self.calls = routes, []

    def __call__(self, method, url, headers, body):
        assert url.startswith(BASE + "/") and headers["Authorization"] == "Bearer t0k3n"
        path = url[len(BASE):].split("?")[0]
        self.calls.append((method, path, json.loads(body) if body else None))
        answer = self.routes.get((method, path))
        if answer is None:
            return 404, {}, b'{"error": {"code": "NotFound"}}'
        status, payload = answer if isinstance(answer, tuple) else (200, answer)
        return status, {}, json.dumps(payload).encode()


CHATS = {"value": [
    {"id": DM, "chatType": "oneOnOne", "topic": None,
     "members": [{"userId": ME, "displayName": "Moi"}, {"userId": ALICE, "displayName": "Alice Martin"}],
     "lastMessagePreview": {"createdDateTime": "2026-11-26T09:00:00Z", "from": {"user": {"id": ALICE}},
                            "body": {"contentType": "text", "content": "Tu as vu ?"}},
     "viewpoint": {"lastMessageReadDateTime": "2026-11-26T08:00:00Z"}},
    {"id": GROUP, "chatType": "group", "topic": "Équipe interop",
     "members": [{"userId": ME, "displayName": "Moi"}],
     "lastMessagePreview": {"createdDateTime": "2026-11-26T07:00:00Z", "from": {"user": {"id": ME}},
                            "body": {"contentType": "html", "content": "<p>Je regarde</p>"}}},
]}

MESSAGES = {"value": [  # Graph: newest first
    {"id": "3", "messageType": "message", "createdDateTime": "2026-11-26T09:00:00Z",
     "from": {"user": {"id": ALICE, "displayName": "Alice Martin"}},
     "body": {"contentType": "html",
              "content": '<p>Fiche : <a href="https://example.atlassian.net/browse/ALL-141">[ALL-141] Recherche</a></p>'},
     "attachments": [{"contentType": "reference", "name": "spec.xlsx",
                      "contentUrl": "https://contoso.sharepoint.com/sites/x/spec.xlsx"}],
     "reactions": [{"reactionType": "like"}, {"reactionType": "❤️"}]},
    {"id": "2", "messageType": "systemEventMessage", "createdDateTime": "2026-11-26T08:59:00Z",
     "body": {"contentType": "html", "content": "<systemEventMessage/>"}},
    {"id": "1", "messageType": "message", "createdDateTime": "2026-11-26T08:58:00Z", "deletedDateTime": "2026-11-26T08:59:30Z",
     "from": {"user": {"id": ME, "displayName": "Moi"}}, "body": {"contentType": "html", "content": ""}},
]}


def routes(extra=None):
    base = {
        ("GET", "/me"): {"id": ME},
        ("GET", "/me/chats"): CHATS,
        ("POST", "/communications/getPresencesByUserId"): {"value": [{"id": ALICE, "availability": "Busy",
                                                                      "activity": "InAMeeting"}]},
        ("GET", f"/chats/{DM}/messages"): MESSAGES,
        ("GET", "/me/presence"): {"availability": "DoNotDisturb", "activity": "Presenting",
                                  "statusMessage": {"message": {"contentType": "text", "content": "En atelier"}}},
        ("GET", "/me/people"): {"value": [{"displayName": "Alice Martin"}, {"displayName": " "}]},
    }
    base.update(extra or {})
    return FakeGraph(base)


def driver(fake=None):
    page = MockTeamsDriver(interval=9999)
    client = GraphClient(lambda: "t0k3n", fake) if fake else None
    return GraphDriver(page, lambda: client), page


def test_without_graph_everything_stays_on_the_page():
    d, page = driver()
    assert [c.thread_id for c in d.list_conversations()] == [c.thread_id for c in page.list_conversations()]
    assert d.routes()["list"]["via"] == "page" and d.routes()["list"]["reason"] == "Graph non connecté"
    assert d.supports_reactions == page.supports_reactions  # the rest is the page driver's


def test_list_reads_chats_presence_and_teaches_the_page_their_names():
    fake = routes()
    d, page = driver(fake)
    convs = d.list_conversations()
    assert [(c.thread_id, c.display_name, c.surface) for c in convs] == [
        (DM, "Alice Martin", Surface.dm), (GROUP, "Équipe interop", Surface.group)]
    assert convs[0].unread and not convs[1].unread and convs[1].own_preview == "Je regarde"
    assert convs[0].presence == "in_meeting" and d.presence()[DM] == "in_meeting"
    assert d.routes()["list"]["via"] == "graph" and d.routes()["presence"]["via"] == "graph"
    assert ("POST", "/communications/getPresencesByUserId", {"ids": [ALICE]}) in fake.calls


def test_read_converts_messages_oldest_first_and_drops_system_events():
    d, _page = driver(routes())
    msgs, top = d.read_history(DM, 30)
    assert top is True and [m.id for m in msgs] == ["1", "3"]
    deleted, last = msgs
    assert deleted.deleted and deleted.text == DELETED_TEXT
    assert last.sender == "Alice Martin" and last.text == "Fiche : [ALL-141] Recherche"
    assert [(l.text, l.url) for l in last.links] == [("[ALL-141] Recherche", "https://example.atlassian.net/browse/ALL-141")]
    assert [(f.name, f.url) for f in last.files] == [("spec.xlsx", "https://contoso.sharepoint.com/sites/x/spec.xlsx")]
    assert last.reactions == ["like", "heart"]
    assert d.routes()["read"]["via"] == "graph"


def test_a_conversation_known_by_name_is_found_in_graph():
    d, _page = driver(routes())
    msgs = d.read_context("name:Alice Martin", 10)
    assert [m.thread_id for m in msgs] == ["name:Alice Martin", "name:Alice Martin"]


def test_graph_refusal_falls_back_to_the_page_with_the_reason():
    fake = routes({("GET", f"/chats/{DM}/messages"): (403, {"error": {"code": "Forbidden", "message": "consent"}})})
    d, page = driver(fake)
    page_msgs = page.read_history(DM, 5)
    assert d.read_history(DM, 5) == page_msgs
    route = d.routes()["read"]
    assert route["via"] == "page" and "403 Forbidden" in route["reason"]


def test_my_status_and_people_search():
    d, _page = driver(routes())
    assert d.my_status(with_message=True) == {"presence": "presenting", "message": "En atelier"}
    assert d.search_people('Ali"ce') == ["Alice Martin"]
    assert d.search_people("  ") == []


def test_writes_stay_on_the_page():
    fake = routes()
    d, page = driver(fake)
    assert d.type_reply.__self__ is page  # not overridden in this step
    assert not any(m == "POST" and p.startswith("/chats") for m, p, _ in fake.calls)


def test_client_only_talks_to_graph_and_reports_errors():
    client = GraphClient(lambda: "t0k3n", routes())
    with pytest.raises(ValueError):
        client.get("https://evil.example/v1.0/me")
    with pytest.raises(GraphError) as e:
        client.get("/nothing")
    assert e.value.status == 404 and not e.value.forbidden


def test_html_body_keeps_lines_and_ignores_unsafe_links():
    text, links = convert.body_text({"contentType": "html",
                                     "content": '<p>Un</p><p>Deux&nbsp;<a href="javascript:alert(1)">x</a></p>'})
    assert text == "Un\n\nDeux x" and links == []


def test_presence_mapping_prefers_activity():
    assert convert.presence({"availability": "Busy", "activity": "InACall"}) == "in_call"
    assert convert.presence({"availability": "Away", "activity": "Away"}) == "away"
    assert convert.presence({"availability": "PresenceUnknown"}) is None


def test_saved_name_entry_follows_the_id_given_by_graph(make_client):
    _client, watcher, _d = make_client()
    watcher.state.watchlist = [WatchEntity(thread_id="name:Alice Martin", display_name="Alice Martin",
                                           surface=Surface.dm, watch=True, mode="auto")]
    merged = watcher._merge([WatchEntity(thread_id=DM, display_name="Alice Martin", surface=Surface.dm)])
    assert [(w.thread_id, w.watch, w.mode) for w in merged] == [(DM, True, "auto")]


def test_graph_api_without_registration(make_client):
    client, _w, _d = make_client()
    g = client.get("/api/graph").json()["graph"]
    assert g["configured"] is False and g["signed_in"] is False
    assert client.post("/api/graph/login").status_code == 409
    assert client.put("/api/graph", json={"client_id": "pas-un-guid", "tenant_id": ""}).status_code == 422


def test_failed_setup_is_not_retried_at_every_poll(monkeypatch, fresh_home):
    import config as cfgmod
    import msgraph.auth as authmod
    from msgraph.service import GraphService
    tries = []

    class Broken:
        def __init__(self, *a, **k):
            tries.append(1)
            raise ValueError("tenant inconnu")

    monkeypatch.setattr(authmod, "GraphAuth", Broken)
    svc = GraphService()
    cfg = cfgmod.load()
    cfg["graph"] = {"client_id": "00000000-0000-0000-0000-000000000001", "tenant_id": "00000000-0000-0000-0000-000000000002"}
    cfgmod.save(cfg)
    for _ in range(3):
        assert svc.status()["error"] == "Microsoft Graph indisponible : tenant inconnu"
    assert len(tries) == 1 and svc.client() is None
    assert svc.auth(retry=True) is None and len(tries) == 2
