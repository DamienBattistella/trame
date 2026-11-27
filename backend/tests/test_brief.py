from __future__ import annotations
import json

import pytest

from conftest import FakeBrain
from github import context as gh

LUCAS = "19:bb22@thread.v2"
INTEROP = "19:cc33@thread.v2"

DIGEST = {
    "summary": "Lucas a ouvert la PR #214 sur le mapping OBX. Le typage OBX-2 reste à corriger.",
    "open_points": ["Corriger le typage OBX-2", ""],
    "topics": ["HL7", "OBX"],
    "search_queries": ["mapping HL7 OBX", "OBX-2 typage"],
}

SEARCH_PR = [
    {"number": 214, "title": "Mapping HL7 OBX vers FHIR", "state": "open",
     "url": "https://github.com/acme/interop/pull/214", "repository": {"name": "interop", "nameWithOwner": "acme/interop"}},
    {"number": 198, "title": "Parseur ORU^R01", "state": "closed",
     "url": "https://github.com/acme/interop/pull/198", "repository": {"name": "interop", "nameWithOwner": "acme/interop"}},
]
SEARCH_ISSUE = [
    {"number": 220, "title": "OBX-2 forcé à ST", "state": "open",
     "url": "https://github.com/acme/interop/issues/220", "repository": {"name": "interop", "nameWithOwner": "acme/interop"}},
]
SEARCH_COMMIT = [
    {"sha": "abc1234def", "commit": {"message": "fix: typage OBX-2\n\ndétails"},
     "url": "https://github.com/acme/interop/commit/abc1234def", "repository": {"fullName": "acme/interop"}},
]


class FakeGh:
    def __init__(self, repos=("acme/interop", "acme/portail")):
        self.repos = list(repos)
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], timeout: float = 20) -> str:
        self.calls.append(list(args))
        if args[:2] == ["repo", "list"]:
            return "\n".join(self.repos)
        if args[:2] == ["pr", "view"] and args[2] == "214" and args[4] == "acme/interop":
            return json.dumps({"number": 214, "title": "Mapping HL7 OBX vers FHIR", "state": "MERGED",
                               "url": "https://github.com/acme/interop/pull/214"})
        if args[:2] == ["search", "prs"]:
            return json.dumps(SEARCH_PR)
        if args[:2] == ["search", "issues"]:
            return json.dumps(SEARCH_ISSUE)
        if args[:2] == ["search", "commits"]:
            return json.dumps(SEARCH_COMMIT)
        return ""


@pytest.fixture
def fake_gh(monkeypatch):
    stub = FakeGh()
    monkeypatch.setattr(gh, "_gh", stub)
    return stub


def _brain(payload=DIGEST, fenced=True):
    body = json.dumps(payload, ensure_ascii=False)
    return FakeBrain(completion=f"Voici :\n```json\n{body}\n```\n" if fenced else body)


def test_brief_happy_path_with_github(make_client, fake_gh):
    brain = _brain()
    client, watcher, _driver = make_client(brain=brain)
    r = client.post(f"/api/threads/{LUCAS}/brief")
    assert r.status_code == 200, r.json()
    body = r.json()
    assert body["ok"] is True
    b = body["brief"]
    assert set(b) == {"thread_id", "display_name", "generated_at", "summary", "open_points", "topics",
                      "github_enabled", "github", "sources"}
    assert b["thread_id"] == LUCAS and b["display_name"] == "Lucas Bernard"
    assert len(b["generated_at"]) == 5 and b["generated_at"][2] == ":"
    assert b["summary"].startswith("Lucas a ouvert")
    assert b["open_points"] == ["Corriger le typage OBX-2"]
    assert b["topics"] == ["HL7", "OBX"]
    assert b["github_enabled"] is True
    assert b["sources"] == {"messages": 12, "repos_searched": 2, "range": "messages"}
    hits = b["github"]
    assert 0 < len(hits) <= gh.MAX_HITS
    assert len({(h["repo"], h["number"] if h["number"] is not None else h["url"]) for h in hits}) == len(hits)
    assert {h["kind"] for h in hits} == {"pr", "issue", "commit"}
    commit = next(h for h in hits if h["kind"] == "commit")
    assert commit["number"] is None and commit["state"] is None and commit["title"] == "fix: typage OBX-2"
    assert all(h["why"] for h in hits)
    assert len(brain.prompts) == 1
    searches = [c for c in fake_gh.calls if c[0] == "search"]
    assert searches and all("--owner" in c and "acme" in c for c in searches)
    # Only reads: the account and its orgs (search scope), never a write.
    assert not any((c[0] == "api" and c[1] not in ("user", "user/orgs")) or c[1:2] in (["create"], ["comment"], ["edit"])
                   for c in fake_gh.calls)
    assert any("Résumé généré pour Lucas Bernard" in log.text for log in watcher.state.logs)


def test_brief_literal_number_lookup(make_client, fake_gh):
    client, _watcher, _driver = make_client(brain=_brain({**DIGEST, "search_queries": []}))
    b = client.post(f"/api/threads/{LUCAS}/brief").json()["brief"]
    assert b["github"] == [{
        "kind": "pr", "repo": "acme/interop", "number": 214, "title": "Mapping HL7 OBX vers FHIR",
        "state": "merged", "url": "https://github.com/acme/interop/pull/214", "why": "#214 cité dans la conversation",
    }]
    assert ["pr", "view", "214", "--repo", "acme/interop"] == fake_gh.calls[1][:5]


def test_brief_literal_number_not_duplicated_by_search(make_client, fake_gh):
    client, _watcher, _driver = make_client(brain=_brain())
    hits = client.post(f"/api/threads/{LUCAS}/brief").json()["brief"]["github"]
    pr214 = [h for h in hits if h["number"] == 214]
    assert len(pr214) == 1 and pr214[0]["why"] == "#214 cité dans la conversation"


def test_brief_allowlist_scope(make_client, fake_gh):
    client, watcher, _driver = make_client(brain=_brain())
    client.put("/api/settings", json={"github": {"all_repos": False}})
    watcher.cfg["context"]["github"]["repos_allowlist"] = ["acme/interop"]
    b = client.post(f"/api/threads/{LUCAS}/brief").json()["brief"]
    assert b["sources"]["repos_searched"] == 1
    assert not any(c[:2] == ["repo", "list"] for c in fake_gh.calls)
    searches = [c for c in fake_gh.calls if c[0] == "search"]
    assert searches and all(c[c.index("--repo") + 1] == "acme/interop" for c in searches)


def test_brief_github_disabled(make_client, fake_gh):
    client, _watcher, _driver = make_client(brain=_brain())
    client.put("/api/settings", json={"github": {"enabled": False}})
    b = client.post(f"/api/threads/{LUCAS}/brief").json()["brief"]
    assert b["github_enabled"] is False and b["github"] == []
    assert b["sources"]["repos_searched"] == 0
    assert fake_gh.calls == []


def test_brief_feature_disabled(make_client, fake_gh):
    brain = _brain()
    client, _watcher, _driver = make_client(brain=brain)
    client.put("/api/settings", json={"brief": {"enabled": False}})
    r = client.post(f"/api/threads/{LUCAS}/brief")
    assert r.status_code == 409 and r.json()["ok"] is False and r.json()["error"]
    assert brain.prompts == []


def test_brief_unknown_thread(make_client, fake_gh):
    brain = _brain()
    client, _watcher, _driver = make_client(brain=brain)
    r = client.post("/api/threads/19:inconnu@thread.v2/brief")
    assert r.status_code == 404 and r.json()["ok"] is False
    assert brain.prompts == []


@pytest.mark.parametrize("raw", ["Désolé, je ne peux pas.", '```json\n{"summary": ""}\n```', "{pas du json}"])
def test_brief_unparsable_output(make_client, fake_gh, raw):
    client, watcher, _driver = make_client(brain=FakeBrain(completion=raw))
    r = client.post(f"/api/threads/{LUCAS}/brief")
    assert r.status_code == 502 and r.json()["ok"] is False
    assert "Rien n'a été perdu" in r.json()["error"]
    assert client.get(f"/api/threads/{LUCAS}/brief").json() == {"ok": True, "brief": None}
    assert watcher.state.logs[0].level == "warn" and "Résumé impossible" in watcher.state.logs[0].text
    assert fake_gh.calls == []


def test_brief_brain_failure(make_client, fake_gh):
    client, _watcher, _driver = make_client(brain=FakeBrain(completion=RuntimeError("claude a échoué")))
    r = client.post(f"/api/threads/{LUCAS}/brief")
    assert r.status_code == 502 and "Rien n'a été perdu" in r.json()["error"]


def test_brief_cache_and_last_messages(make_client, fake_gh):
    brain = _brain()
    client, _watcher, _driver = make_client(brain=brain)
    empty = client.get(f"/api/threads/{LUCAS}/brief")
    assert empty.status_code == 200 and empty.json() == {"ok": True, "brief": None}
    unknown = client.get("/api/threads/19:inconnu@thread.v2/brief")
    assert unknown.status_code == 404 and unknown.json()["ok"] is False
    posted = client.post(f"/api/threads/{LUCAS}/brief", json={"last_messages": 10}).json()["brief"]
    assert posted["sources"]["messages"] == 10
    got = client.get(f"/api/threads/{LUCAS}/brief").json()
    assert got == {"ok": True, "brief": posted}
    assert len(brain.prompts) == 1
    assert client.post(f"/api/threads/{LUCAS}/brief", json={"last_messages": 5}).status_code == 422


def test_brief_settings_validation_and_persistence(make_client, fresh_home):
    client, watcher, _driver = make_client()
    r = client.put("/api/settings", json={"brief": {"last_messages": 50}})
    assert r.status_code == 200 and r.json()["settings"]["brief"] == {"enabled": True, "last_messages": 50, "range": "messages"}
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))
    assert saved["brief"] == {"enabled": True, "last_messages": 50, "range": "messages"}
    for body in ({"brief": {"last_messages": 9}}, {"brief": {"last_messages": 101}},
                 {"brief": {"enabled": "oui"}}, {"brief": {"inconnu": 1}}, {"brief": {"range": "1an"}}):
        r = client.put("/api/settings", json=body)
        assert r.status_code == 422, body
        assert r.json()["ok"] is False
    client2, _w2, _d2 = make_client()
    assert client2.get("/api/settings").json()["settings"]["brief"]["last_messages"] == 50


def test_brief_range_setting_persists(make_client, fresh_home):
    client, _watcher, _driver = make_client()
    r = client.put("/api/settings", json={"brief": {"range": "7d"}})
    assert r.status_code == 200 and r.json()["settings"]["brief"]["range"] == "7d"
    client2, _w2, _d2 = make_client()
    assert client2.get("/api/settings").json()["settings"]["brief"]["range"] == "7d"


def test_brief_since_bounds():
    from datetime import datetime
    from watcher import Watcher
    now = datetime(2026, 11, 27, 15, 42, 10)
    assert Watcher.brief_since("messages", now) is None
    assert Watcher.brief_since("today", now) == datetime(2026, 11, 27)
    assert Watcher.brief_since("24h", now) == datetime(2026, 11, 26, 15, 42, 10)
    assert Watcher.brief_since("7d", now) == datetime(2026, 11, 20, 15, 42, 10)
    assert Watcher.brief_since("30d", now) == datetime(2026, 10, 28, 15, 42, 10)


def test_brief_time_range_reads_back_to_the_date(make_client, fake_gh, monkeypatch):
    from datetime import datetime, timedelta
    client, watcher, driver = make_client(brain=_brain())
    calls = []
    original = driver.read_history

    def spy(thread_id, last_n, since=None):
        calls.append((last_n, since))
        return original(thread_id, 4)

    monkeypatch.setattr(driver, "read_history", spy)
    r = client.post(f"/api/threads/{LUCAS}/brief", json={"range": "7d"})
    assert r.status_code == 200, r.json()
    assert r.json()["brief"]["sources"]["range"] == "7d"
    assert r.json()["brief"]["sources"]["messages"] == 4
    (last_n, since), = calls
    assert last_n == watcher.BRIEF_RANGE_CAP
    assert abs((datetime.now() - timedelta(days=7)) - since) < timedelta(minutes=1)
    # Default range from settings: the last N messages, no date sent to the driver.
    calls.clear()
    assert client.post(f"/api/threads/{LUCAS}/brief").status_code == 200
    assert calls == [(30, None)]


def test_brief_time_range_without_messages(make_client, fake_gh, monkeypatch):
    client, _watcher, driver = make_client(brain=_brain())
    monkeypatch.setattr(driver, "read_history", lambda thread_id, last_n, since=None: ([], True))
    r = client.post(f"/api/threads/{LUCAS}/brief", json={"range": "today"})
    assert r.status_code == 502 and "cette période" in r.json()["error"]
    assert client.post(f"/api/threads/{LUCAS}/brief", json={"range": "1an"}).status_code == 422


def test_parse_brief_extraction():
    from brain.brief import BriefParseError, parse_brief

    d = parse_brief('Bien sûr !\n```json\n{"summary": " ok ", "search_queries": ["a", "A", "b", "c", "d", "e", "f"]}\n```')
    assert d.summary == "ok" and d.open_points == [] and d.search_queries == ["a", "b", "c", "d", "e"]
    d = parse_brief('{"x": {"y": 1}} puis {"summary": "deuxième objet"}')
    assert d.summary == "deuxième objet"
    with pytest.raises(BriefParseError):
        parse_brief("")


def test_mock_brain_via_env(monkeypatch, make_client, fake_gh):
    from app import make_brain
    from brain.claude import ClaudeBrain
    from brain.mock import MockBrain

    monkeypatch.delenv("TRAME_BRAIN", raising=False)
    assert isinstance(make_brain({"brain": {"provider": "claude"}}), ClaudeBrain)
    monkeypatch.setenv("TRAME_BRAIN", "mock")
    assert isinstance(make_brain({"brain": {"provider": "claude"}}), MockBrain)
    assert isinstance(make_brain({"brain": {"provider": "copilot"}}), MockBrain)

    from conftest import MockTeamsDriver
    from fastapi.testclient import TestClient
    from app import create_app

    from conftest import offline_auth
    app = create_app(driver=MockTeamsDriver(interval=9999), github_auth=offline_auth())
    with TestClient(app) as client:
        watcher = app.state.watcher
        assert isinstance(watcher.brain, MockBrain)
        b = client.post(f"/api/threads/{INTEROP}/brief").json()["brief"]
        assert "OBX" in b["summary"] and "démo" in b["summary"].lower()
        assert "typage OBX-2" in b["topics"]
        assert any(h["number"] == 214 for h in b["github"])
        client.put("/api/settings", json={"brain": "copilot"})
        assert isinstance(watcher.brain, MockBrain)
        assert watcher.brain.draft("", "", "Le build passe ?")
