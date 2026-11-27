from __future__ import annotations
import threading

from drivers.preview_watch import PreviewWatcher
from drivers.web_bridge import WebBridgeDriver
from models import WatchEntity, Surface

LABELS = [
    {"label": "Quick views", "aria": "expanded=true;level=1"},
    {"label": "Chat Romain CUREAU Away Last message je vais préparer ça 25/11", "aria": "level=2", "id": "r1"},
    {"label": "Group chat Projet FHIR Unread Last message Lucas: on fait un point ? 10:02", "aria": "level=2", "id": "r2"},
]


class FakePage:
    """Plays the Teams web page: answers the commands the Trame UI relays."""

    def __init__(self, client):
        self.client, self.title, self.typed, self.stop = client, "Chat | Autre | Microsoft Teams", [], False
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def answer(self, cmd):
        op, a = cmd["op"], cmd["args"]
        if op == "ping":
            return {"title": self.title, "ready": True}
        if op == "list":
            return LABELS
        if op == "title":
            return self.title
        if op == "open":
            self.title = f"Chat | {a['name']} | Microsoft Teams"
            return {"ok": True, "title": self.title}
        if op == "read":
            return {"messages": [{"sender": "Romain CUREAU", "text": "Tu as vu ?", "at": "10:00"}][-a["last"]:], "top": True}
        if op == "type":
            self.typed.append((a["name"], a["text"], a["send"]))
            return {"ok": True}
        return None

    def loop(self):
        while not self.stop:
            cmd = self.client.get("/api/teams-web/poll").json()["command"]
            if cmd:
                self.client.post("/api/teams-web/reply", json={"id": cmd["id"], "ok": True, "result": self.answer(cmd)})


def test_bridge_end_to_end(make_client, monkeypatch):
    monkeypatch.setattr(WebBridgeDriver, "RPC_TIMEOUT", 3.0)
    monkeypatch.setattr(WebBridgeDriver, "POLL_WAIT", 0.5)
    driver = WebBridgeDriver()
    client, watcher, _ = make_client(driver=driver)
    page = FakePage(client)
    driver._last_poll = __import__("time").monotonic()
    page.thread.start()
    try:
        convs = driver.list_conversations()
        assert [c.display_name for c in convs] == ["Romain CUREAU", "Projet FHIR"]
        assert convs[1].surface == Surface.group and convs[1].unread
        watcher.state.watchlist = convs
        msgs = client.get("/api/threads/name%3ARomain%20CUREAU/messages").json()
        assert msgs["ok"] and msgs["messages"][0]["text"] == "Tu as vu ?" and msgs["top"] is True
        r = client.post("/api/threads/name%3ARomain%20CUREAU/send", json={"text": "Oui je regarde"})
        assert r.json() == {"ok": True}
        assert ("Romain CUREAU", "Oui je regarde", True) in page.typed
        assert client.get("/api/teams-web/status").json()["status"]["ready"] is True
    finally:
        page.stop = True
        page.thread.join(timeout=5)


def test_bridge_without_relay_fails_safe():
    d = WebBridgeDriver()
    assert d.selftest() is False and d.open_thread("name:X") is False


def test_preview_watcher_detects_only_new_messages_from_others():
    w = PreviewWatcher()
    convs = {"a": WatchEntity(thread_id="a", display_name="Romain", surface=Surface.dm)}
    first = [("a", "Chat Romain Away Last message salut 10:00")]
    assert w.diff(first, convs) == []
    assert w.diff(first, convs) == []
    new = w.diff([("a", "Chat Romain Away Last message tu as vu ? 10:05")], convs)
    assert len(new) == 1 and new[0].sender == "Romain" and new[0].text == "tu as vu ?"
    assert w.diff([("a", "Chat Romain Away Last message You: oui 10:06")], convs) == []


def test_preview_time_relabel_is_not_a_new_message():
    w = PreviewWatcher()
    convs = {"a": WatchEntity(thread_id="a", display_name="Alice", surface=Surface.dm)}
    w.diff([("a", "Chat Alice Away Last message on se voit demain ? 23:41")], convs)
    assert w.diff([("a", "Chat Alice Away Last message on se voit demain ? Yesterday")], convs) == []
    assert w.diff([("a", "Chat Alice Away Last message on se voit demain ? 20/11")], convs) == []
    assert w.diff([("a", "Conversation Alice Absent Dernier message Vous : oui 08:00")], convs) == []


def test_own_message_in_french_never_triggers(make_client):
    from models import IncomingMessage
    _c, watcher, driver = make_client()
    msg = IncomingMessage(thread_id="19:aa11@thread.v2", sender="Vous", text="je regarde", received_at="10:00", surface=Surface.dm)
    assert watcher._process(msg) is None and driver.typed == []


def test_teams_ready_marks_checked_and_reads_conversations(make_client):
    _c, watcher, driver = make_client()
    watcher.state.selftest_ok = False
    watcher.state.watchlist = []
    watcher.teams_ready(True)
    assert watcher.state.selftest_ok and watcher.state.watchlist
    assert any(l.text == "Teams connecté" for l in watcher.state.logs)
    watcher.teams_ready(True)
    assert sum(l.text == "Teams connecté" for l in watcher.state.logs) == 1


def test_teams_web_labels_give_clean_names_stable_ids_and_new_messages():
    """Teams web exposes "name time preview", not the desktop "Chat … Last message …"."""
    d = WebBridgeDriver()
    rail = [{"label": "Romain CUREAU 25/11 je vais préparer ça", "id": ""},
            {"label": "Hexagone 10 - Developers 24/11 Chloé: merci", "id": "title-19:95@thread.v2"}]
    d._rpc = lambda op, **_: rail
    convs = d.list_conversations()
    assert [(c.thread_id, c.display_name, c.surface) for c in convs] == [
        ("name:Romain CUREAU", "Romain CUREAU", Surface.dm),
        ("title-19:95@thread.v2", "Hexagone 10 - Developers", Surface.group)]
    w = PreviewWatcher()
    assert w.diff([("name:Romain CUREAU", rail[0]["label"])], {}) == []
    rail[0]["label"] = "Romain CUREAU 10:41 tu as vu ma PR ?"
    assert d.list_conversations()[0].thread_id == "name:Romain CUREAU"
    new = w.diff([("name:Romain CUREAU", rail[0]["label"])], {})
    assert len(new) == 1 and (new[0].sender, new[0].text) == ("Romain CUREAU", "tu as vu ma PR ?")
    assert w.diff([("name:Romain CUREAU", "Romain CUREAU 10:42 Vous : oui")], {}) == []


def test_deep_list_asks_the_page_for_everything_and_drops_duplicates():
    d = WebBridgeDriver()
    calls = []

    def rpc(op, **kw):
        calls.append((op, kw))
        return [{"label": "Romain CUREAU 25/11 ok", "aria": "", "id": ""},
                {"label": "Hugo Lannes 24/11 vu", "aria": "", "id": ""},
                {"label": "Romain CUREAU 25/11 ok !", "aria": "", "id": ""}]

    d._rpc = rpc
    assert [c.display_name for c in d.list_all_conversations()] == ["Romain CUREAU", "Hugo Lannes"]
    assert calls == [("list", {"timeout": 20, "deep": True})]
    d.list_conversations()
    assert calls[-1] == ("list", {})


def test_page_fetch_sends_webfetch_and_returns_only_the_body():
    """L'appel API est une commande envoyée à la page ; le moteur ne récupère que le corps
    métier parsé, jamais d'en-tête de réponse."""
    d = WebBridgeDriver()
    calls = []

    def rpc(op, **kw):
        calls.append((op, kw))
        return {"ok": True, "status": 200, "contentType": "application/json",
                "json": {"conversations": [{"id": "19:x@thread.v2"}]}}

    d._rpc = rpc
    out = d.page_fetch("https://teams.microsoft.com/api/csa/v1/conversations")
    assert out == {"status": 200, "contentType": "application/json",
                   "json": {"conversations": [{"id": "19:x@thread.v2"}]}, "text": None}
    assert calls[0][0] == "webfetch"
    assert calls[0][1]["url"].endswith("/conversations") and calls[0][1]["method"] == "GET"


def test_page_fetch_never_forwards_auth_headers_to_the_page():
    """Le jeton reste dans la page : tout en-tête d'auth passé au moteur est retiré avant
    d'atteindre la commande webfetch."""
    d = WebBridgeDriver()
    sent = {}
    d._rpc = lambda op, **kw: sent.update(kw) or {"ok": True, "status": 204, "contentType": "", "text": ""}
    d.page_fetch("https://teams.microsoft.com/api/csa/v1/x", method="POST", body={"a": 1},
                 headers={"Authorization": "Bearer SECRET", "x-skypetoken": "SECRET2",
                          "X-Trame-Request": "ok", "Content-Type": "application/json"})
    # Seuls les en-têtes métier survivent ; aucun en-tête d'auth n'est transmis.
    assert sent["headers"] == {"X-Trame-Request": "ok", "Content-Type": "application/json"}
    assert "Authorization" not in sent["headers"] and "x-skypetoken" not in sent["headers"]


def test_page_fetch_passes_sign_flag_and_never_a_credential():
    """La signature se fait DANS la page (rejeu de l'auth de Teams) ; le moteur ne transmet
    qu'un booléen `sign`, jamais un credential."""
    d = WebBridgeDriver()
    sent = {}
    d._rpc = lambda op, **kw: sent.update(kw) or {"ok": True, "status": 200, "contentType": "", "text": ""}
    d.page_fetch("https://teams.cloud.microsoft/api/mt/x")
    assert sent["sign"] is True  # signé par défaut
    d.page_fetch("https://teams.cloud.microsoft/api/mt/x", sign=False)
    assert sent["sign"] is False
    # Le moteur n'envoie jamais de valeur d'auth à la page.
    assert sent.get("headers") in (None, {}) or all(
        not k.lower().startswith(("authorization", "x-skypetoken", "cookie")) for k in sent["headers"])


def test_page_fetch_refuses_non_teams_hosts_without_calling_the_page():
    d = WebBridgeDriver()
    calls = []
    d._rpc = lambda op, **kw: calls.append(op)
    for bad in ("https://evil.example.com/steal", "https://teams.microsoft.com.evil.com/x",
                "http://teams.microsoft.com/api/x"):
        try:
            d.page_fetch(bad)
            assert False, f"hôte accepté à tort : {bad}"
        except WebBridgeDriver.ApiError:
            pass
    assert calls == []  # la page n'est jamais sollicitée pour un hôte refusé


def test_page_fetch_raises_on_http_error_so_caller_can_fall_back_to_dom():
    d = WebBridgeDriver()
    d._rpc = lambda op, **kw: {"ok": False, "status": 401, "error": "appel API refusé (HTTP 401)"}
    try:
        d.page_fetch("https://teams.microsoft.com/api/csa/v1/x")
        assert False, "une réponse non 2xx doit lever ApiError"
    except WebBridgeDriver.ApiError as e:
        assert e.status == 401


def test_api_capture_returns_only_structure_from_diagnose():
    d = WebBridgeDriver()
    d._rpc = lambda op, **kw: {"api_capture": {"count": 1, "byService": {"chatsvc": 1},
                                               "endpoints": [{"method": "GET", "service": "chatsvc",
                                                              "host": "teams.microsoft.com",
                                                              "path": "/api/csa/v1/conversations",
                                                              "type": "application/json", "status": 200,
                                                              "count": 3, "auth": ["authorization"]}]}}
    cap = d.api_capture()
    assert cap["count"] == 1 and cap["byService"] == {"chatsvc": 1}
    ep = cap["endpoints"][0]
    # Noms d'en-têtes d'auth seulement, jamais de valeur.
    assert ep["auth"] == ["authorization"] and ep["path"] == "/api/csa/v1/conversations"


def test_connection_reads_the_whole_list_and_keeps_known_conversations(make_client, monkeypatch):
    """After a restart Teams draws only the top of its list: the conversations known
    from before must not vanish while the full read is on its way."""
    import threading as th
    from models import WatchEntity
    _c, watcher, driver = make_client()
    known = [WatchEntity(thread_id=f"name:C{i}", display_name=f"C{i}", surface=Surface.dm) for i in range(5)]
    watcher.state.watchlist = list(known)
    watcher.state.selftest_ok = False
    calls = []
    driver.list_conversations = lambda: calls.append("short") or known[:2]
    driver.list_all_conversations = lambda: calls.append("full") or known + [
        WatchEntity(thread_id="name:Nouvelle", display_name="Nouvelle", surface=Surface.dm)]
    started = []
    monkeypatch.setattr(th.Thread, "start", lambda self: started.append(self))
    watcher.teams_ready(True)
    assert calls == [] and len(watcher.state.watchlist) == 5
    started[0].run()
    assert calls == ["full"] and len(watcher.state.watchlist) == 6


# --- Service de chat (chatsvc) : session ouverte dans la page --------------------------

def test_chat_get_sends_only_an_allowed_path_and_query_and_returns_the_body():
    d = WebBridgeDriver()
    calls = []

    def rpc(op, **kw):
        calls.append((op, kw))
        return {"ok": True, "status": 200, "region": "emea", "json": {"conversations": [{"id": "19:a@thread.v2"}]}}

    d._rpc = rpc
    out = d.chat_get("/v1/users/ME/conversations", {"view": "msnp24Equivalent", "pageSize": 5, "evil": "x"})
    assert out == {"conversations": [{"id": "19:a@thread.v2"}]}
    op, kw = calls[0]
    assert op == "chatsvc" and kw["path"] == "/v1/users/ME/conversations"
    # Paramètre inconnu retiré ; aucun en-tête, aucun credential ne part vers la page.
    assert kw["query"] == {"view": "msnp24Equivalent", "pageSize": 5}
    assert set(kw) == {"path", "query", "timeout"}


def test_chat_get_refuses_paths_outside_the_allowlist_without_calling_the_page():
    d = WebBridgeDriver()
    calls = []
    d._rpc = lambda op, **kw: calls.append(op)
    for bad in ("/v1/users/ME/endpoints", "/v1/users/ME/conversations/19:x/properties",
                "/v1/users/ME/conversations/../../x", "https://evil.example.com/v1/users/ME/conversations",
                "/v1/users/ME/conversations/a/messages/abc", "/v1/users/ME/conversations/..",
                "/v1/users/ME/conversations/a%2F..%2Fb", "/v1/users/ME/conversations\n", ""):
        try:
            d.chat_get(bad)
            assert False, f"chemin accepté à tort : {bad}"
        except WebBridgeDriver.ApiError:
            pass
    assert calls == []


def test_chat_conversation_path_encodes_the_thread_id():
    p = WebBridgeDriver.chat_conversation_path("19:abc_def@thread.v2", messages=True)
    assert p == "/v1/users/ME/conversations/19%3Aabc_def%40thread.v2/messages"
    # Le chemin encodé passe la liste blanche.
    from drivers.web_bridge import CHAT_PATHS
    assert CHAT_PATHS.fullmatch(p)
    assert CHAT_PATHS.fullmatch(WebBridgeDriver.chat_conversation_path("8:orgid:0f1e-aa"))


def test_chat_get_raises_with_status_so_caller_falls_back_to_dom():
    d = WebBridgeDriver()
    d._rpc = lambda op, **kw: {"ok": False, "stage": "authz", "status": 401, "error": "authsvc refusé (HTTP 401)"}
    try:
        d.chat_get("/v1/users/ME/conversations")
        assert False, "un échec doit lever ApiError"
    except WebBridgeDriver.ApiError as e:
        assert e.status == 401 and "authsvc" in str(e)


# --- Lecture d'un fil sur le service de chat (sans ouvrir la conversation) ------------

def test_read_history_api_asks_the_page_and_converts_like_the_dom_read():
    from datetime import datetime
    d = WebBridgeDriver()
    calls = []

    def rpc(op, **kw):
        calls.append((op, kw))
        return {"ok": True, "top": True, "messages": [
            {"sender": "Ana", "text": "Bonjour", "at": "10:02", "id": "1700000000001", "reactions": ["like", "inconnue"],
             "files": [{"name": "plan.pdf", "url": "https://dedalus.sharepoint.com/x"}], "images": [], "links": [], "cards": []},
            {"sender": "Ana", "text": "Ce message a été supprimé.", "at": "10:03", "id": "1700000000002",
             "reactions": [], "files": [], "images": [], "links": [], "cards": []},
            {"sender": "Ana", "text": "", "at": "10:04", "id": "1700000000003", "reactions": [], "files": [],
             "images": [], "links": [], "cards": []},
        ]}

    d._rpc = rpc
    msgs, top = d.read_history_api("19:abc@thread.v2", 20, since=datetime(2026, 11, 27, 9, 0))
    assert top is True and [m.id for m in msgs] == ["1700000000001", "1700000000002"]  # vide ignoré
    assert msgs[0].reactions == ["like"] and msgs[0].files[0].name == "plan.pdf"
    assert msgs[1].deleted and msgs[1].text == "Ce message a été supprimé."
    op, kw = calls[0]
    assert op == "chatread" and kw["thread"] == "19:abc@thread.v2" and kw["last"] == 20
    assert kw["since"] == int(datetime(2026, 11, 27, 9, 0).timestamp() * 1000)


def test_read_history_api_refuses_a_conversation_without_teams_id_without_calling_the_page():
    d = WebBridgeDriver()
    calls = []
    d._rpc = lambda op, **kw: calls.append(op)
    try:
        d.read_history_api("name:Ana Martin", 20)
        assert False, "une conversation sans id Teams doit être lue par la page"
    except WebBridgeDriver.ApiError:
        pass
    assert calls == []


def test_read_history_api_raises_on_refusal_so_the_page_is_read():
    d = WebBridgeDriver()
    d._rpc = lambda op, **kw: {"ok": False, "status": 403, "error": "service de chat refusé (HTTP 403)"}
    try:
        d.read_history_api("19:abc@thread.v2", 20)
        assert False
    except WebBridgeDriver.ApiError as e:
        assert e.status == 403


def test_chat_id_strips_the_list_prefix_and_refuses_name_only_conversations():
    cid = WebBridgeDriver.chat_id
    assert cid("title-19:abc123@thread.v2") == "19:abc123@thread.v2"
    assert cid("19:abc123@thread.v2") == "19:abc123@thread.v2"
    assert cid("19:aaa_bbb@unq.gbl.spaces") == "19:aaa_bbb@unq.gbl.spaces"
    for bad in ("name:Ana Martin", "", "title-", "19:x@thread.v2/../y", "8:orgid:abc", "19:x@evil.com"):
        assert cid(bad) is None, bad


def test_read_history_api_sends_the_teams_id_without_the_list_prefix():
    d = WebBridgeDriver()
    sent = {}
    d._rpc = lambda op, **kw: sent.update(kw) or {"ok": True, "messages": [], "top": True}
    d.read_history_api("title-19:abc123@thread.v2", 10)
    assert sent["thread"] == "19:abc123@thread.v2"
