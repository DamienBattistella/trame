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


# --- step 2: read marks, reactions, deletion, status ---
from datetime import datetime as _dt  # noqa: E402

from drivers.base import DeleteUncertain, ReactUncertain  # noqa: E402
from drivers.graph import WriteUncertain, _expiry, _iso_duration  # noqa: E402
from models import MessageRef  # noqa: E402

TENANT = "33333333-3333-3333-3333-333333333333"


class StatefulGraph(FakeGraph):
    """A message that reactions and deletion really change."""

    def __init__(self, mine=False, react_works=True, fail=None):
        self.msg = {"id": "3", "messageType": "message", "createdDateTime": "2026-11-26T09:00:00Z",
                    "from": {"user": {"id": ME if mine else ALICE, "displayName": "Moi" if mine else "Alice Martin"}},
                    "body": {"contentType": "text", "content": "On se voit à 14h ?"}, "reactions": []}
        self.presence = {"availability": "Available", "activity": "Available"}
        self.react_works, self.fail = react_works, fail
        super().__init__({("GET", "/me"): {"id": ME}, ("GET", "/me/chats"): CHATS,
                          ("POST", "/communications/getPresencesByUserId"): {"value": []},
                          ("GET", "/organization"): {"value": [{"id": TENANT}]}})

    def __call__(self, method, url, headers, body):
        path = url[len(BASE):].split("?")[0]
        if self.fail and self.fail[0] == (method, path):
            self.calls.append((method, path, None))
            return self.fail[1], {}, b'{"error": {"code": "Boom"}}'
        data = json.loads(body) if body else None
        msg_path = f"/chats/{DM}/messages/3"
        if (method, path) == ("GET", msg_path):
            self.calls.append((method, path, None))
            return 200, {}, json.dumps(self.msg).encode()
        if (method, path) == ("POST", msg_path + "/setReaction"):
            self.calls.append((method, path, data))
            if self.react_works:
                self.msg["reactions"].append({"reactionType": data["reactionType"], "user": {"user": {"id": ME}}})
            return 204, {}, b""
        if (method, path) == ("POST", f"/users/{ME}/chats/{DM}/messages/3/softDelete"):
            self.calls.append((method, path, data))
            self.msg["deletedDateTime"] = "2026-11-26T10:00:00Z"
            return 204, {}, b""
        if (method, path) == ("POST", "/me/presence/setUserPreferredPresence"):
            self.calls.append((method, path, data))
            self.presence = {"availability": data["availability"], "activity": data["activity"]}
            return 200, {}, b""
        if (method, path) == ("POST", "/me/presence/setStatusMessage"):
            self.calls.append((method, path, data))
            self.presence["statusMessage"] = data["statusMessage"]
            return 200, {}, b""
        if (method, path) == ("GET", "/me/presence"):
            self.calls.append((method, path, None))
            return 200, {}, json.dumps(self.presence).encode()
        if (method, path) == ("POST", f"/chats/{DM}/markChatReadForUser"):
            self.calls.append((method, path, data))
            return 204, {}, b""
        return super().__call__(method, url, headers, body)


def target(text="On se voit à 14h ?", sender="Alice Martin"):
    return MessageRef(id="3", sender=sender, text=text)


def test_mark_read_names_me_and_my_tenant():
    fake = StatefulGraph()
    d, _page = driver(fake)
    assert d.mark_read(DM) is True
    assert ("POST", f"/chats/{DM}/markChatReadForUser", {"user": {"id": ME, "tenantId": TENANT}}) in fake.calls
    assert d.routes()["mark_read"]["via"] == "graph"


def test_reaction_is_set_once_and_proven():
    fake = StatefulGraph()
    d, _page = driver(fake)
    assert d.react_focused(DM, target(), "like").ok
    assert d.react_focused(DM, target(), "like").ok  # already there: not clicked twice
    assert [c for c in fake.calls if c[1].endswith("/setReaction")] == [
        ("POST", f"/chats/{DM}/messages/3/setReaction", {"reactionType": "👍"})]


def test_reaction_not_shown_afterwards_is_uncertain_not_replayed():
    d, page = driver(StatefulGraph(react_works=False))
    with pytest.raises(ReactUncertain):
        d.react_focused(DM, target(), "heart")
    assert d.routes()["react"]["via"] == "graph"


def test_wrong_message_goes_to_the_page_which_checks_again():
    fake = StatefulGraph()
    d, page = driver(fake)
    page_calls = []
    page.react_focused = lambda *a, **k: page_calls.append(a) or "page"
    assert d.react_focused(DM, target(text="Autre chose"), "like") == "page"
    assert page_calls and not any(c[1].endswith("/setReaction") for c in fake.calls)
    assert "différent" in d.routes()["react"]["reason"]


def test_server_error_on_a_write_is_uncertain_and_never_redone_on_the_page():
    fake = StatefulGraph(fail=(("POST", f"/chats/{DM}/messages/3/setReaction"), 503))
    d, page = driver(fake)
    page.react_focused = lambda *a, **k: pytest.fail("rejoué sur la page")
    with pytest.raises(ReactUncertain):
        d.react_focused(DM, target(), "like")


def test_delete_only_my_own_message_and_prove_it():
    d, _page = driver(StatefulGraph(mine=False))
    page_used = []
    d.inner.delete_focused = lambda *a, **k: page_used.append(1) or "page"
    assert d.delete_focused(DM, target()) == "page" and page_used  # not mine: Graph does nothing
    fake = StatefulGraph(mine=True)
    d, _page = driver(fake)
    assert d.delete_focused(DM, target(sender="Moi")).ok
    assert ("POST", f"/users/{ME}/chats/{DM}/messages/3/softDelete", {}) in fake.calls


def test_status_with_duration_and_message():
    fake = StatefulGraph()
    d, _page = driver(fake)
    assert d.set_my_status("dnd", "1h") == "dnd"
    assert ("POST", "/me/presence/setUserPreferredPresence",
            {"availability": "DoNotDisturb", "activity": "DoNotDisturb", "expirationDuration": "PT1H0M"}) in fake.calls
    assert d.set_status_message("En atelier jusqu'à 15h") == "En atelier jusqu'à 15h"


def test_status_expiry_durations():
    now = _dt(2026, 11, 26, 10, 0)  # a Thursday
    assert _iso_duration(_expiry("30m", None, now)) == "PT30M"
    assert _iso_duration(_expiry("today", None, now)) == "PT13H59M"
    assert _iso_duration(_expiry("week", None, now)) == "PT85H59M"
    assert _iso_duration(_expiry(None, _dt(2026, 11, 26, 12, 30), now)) == "PT2H30M"
    assert _expiry(None, None, now) is None


def test_generic_write_error_type():
    d, _page = driver(StatefulGraph(fail=(("POST", f"/chats/{DM}/markChatReadForUser"), 500)))
    with pytest.raises(WriteUncertain):
        d.mark_read(DM)
