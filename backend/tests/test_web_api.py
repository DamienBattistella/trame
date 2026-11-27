from __future__ import annotations

from drivers.web_api import WebApiDriver, ACTIONS


class FakeInner:
    """Un faux pilote de page : on vérifie que WebApiDriver lui délègue tout."""

    def __init__(self):
        self.last_error = None
        self._page = {"sign_selftest": {"ok": True, "status": 200, "source": "path"}, "rail": True}

    def list_conversations(self, deep=False):
        return ["conv"]

    def open_thread(self, tid):
        return True

    def diagnose(self, thread_id=None):
        return {"driver": "web_bridge", "relay": True, "ready": True, "diagnose": self._page}


def test_webapi_delegates_everything_to_the_page_driver():
    inner = FakeInner()
    d = WebApiDriver(inner)
    assert d.inner is inner
    assert d.list_conversations() == ["conv"]  # méthode déléguée
    assert d.open_thread("x") is True
    # Les attributs écrits sur le wrapper atteignent le pilote de la page.
    d.last_error = "oops"
    assert inner.last_error == "oops"


def test_webapi_routes_lists_every_action_read_on_the_chat_service():
    d = WebApiDriver(FakeInner())
    routes = d.routes()
    assert set(routes) == set(ACTIONS)
    on_api = {"read", "watch", "unread"}
    assert all(routes[a]["via"] == "api" for a in on_api)
    assert all(r["via"] == "page" for a, r in routes.items() if a not in on_api)


class ApiReader(FakeInner):
    def __init__(self, fail=None):
        super().__init__()
        self.fail = fail
        self.calls = []

    def read_history_api(self, thread_id, last_n, since=None):
        self.calls.append((thread_id, last_n, since))
        if self.fail:
            raise RuntimeError(self.fail)
        return (["m1", "m2"], True)


def test_read_history_direct_uses_the_chat_service_and_reports_the_route():
    inner = ApiReader()
    d = WebApiDriver(inner)
    assert d.read_history_direct("19:a@thread.v2", 30) == (["m1", "m2"], True)
    assert inner.calls == [("19:a@thread.v2", 30, None)]
    assert d.routes()["read"]["via"] == "api" and d.routes()["read"]["reason"] is None


def test_read_history_direct_falls_back_to_the_page_with_the_reason():
    d = WebApiDriver(ApiReader(fail="service de chat refusé (HTTP 403)"))
    assert d.read_history_direct("19:a@thread.v2", 30) is None
    route = d.routes()["read"]
    assert route["via"] == "page" and "HTTP 403" in route["reason"]
    # Pilote de page sans lecture API : None, jamais d'exception.
    assert WebApiDriver(FakeInner()).read_history_direct("19:a@thread.v2", 30) is None


def test_webapi_diagnose_adds_signing_health_from_the_bridge_selftest():
    d = WebApiDriver(FakeInner())
    out = d.diagnose()
    assert out["driver"] == "web_bridge"  # le diagnostic du pont est conservé
    tw = out["teams_web"]
    assert tw["signing"] == {"ok": True, "status": 200, "source": "path"}
    assert set(tw["routes"]) == set(ACTIONS)
    # Helper dédié pour l'écran Réglages.
    assert d.signing() == {"ok": True, "status": 200, "source": "path"}


def test_webapi_signing_is_none_when_selftest_absent_or_diagnose_fails():
    class NoSelftest(FakeInner):
        def diagnose(self, thread_id=None):
            return {"driver": "web_bridge", "diagnose": {"rail": True}}

    assert WebApiDriver(NoSelftest()).signing() is None

    class Boom(FakeInner):
        def diagnose(self, thread_id=None):
            raise RuntimeError("relay down")

    assert WebApiDriver(Boom()).signing() is None


def test_api_teams_web_endpoint_exposes_routes_and_signing(make_client):
    from drivers.mock import MockTeamsDriver

    inner = MockTeamsDriver(interval=999)
    inner.diagnose = lambda thread_id=None: {"driver": "web_bridge",
                                             "diagnose": {"sign_selftest": {"ok": True, "status": 200, "source": "path"}}}
    client, _watcher, _driver = make_client(driver=WebApiDriver(inner))
    res = client.get("/api/teams-web").json()
    assert res["ok"] and res["api"]["driver"] == "WebApiDriver"
    assert set(res["api"]["routes"]) == set(ACTIONS)
    assert res["api"]["signing"] == {"ok": True, "status": 200, "source": "path"}


def test_webapi_exposes_chatsvc_session_health_from_the_bridge():
    class WithChat(FakeInner):
        def diagnose(self, thread_id=None):
            page = {**self._page, "chatsvc_selftest": {"ok": True, "status": 200, "stage": "ok", "region": "emea"}}
            return {"driver": "web_bridge", "diagnose": page}

    d = WebApiDriver(WithChat())
    assert d.chatsvc() == {"ok": True, "status": 200, "stage": "ok", "region": "emea"}
    assert d.diagnose()["teams_web"]["chatsvc"]["stage"] == "ok"
    # Pas encore mesurée : None, jamais d'exception.
    assert WebApiDriver(FakeInner()).chatsvc() is None
