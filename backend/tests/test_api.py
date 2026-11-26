from __future__ import annotations
import json

import pytest

from conftest import FakeBrain, RefusingDriver
import config as cfgmod
from models import IncomingMessage, Surface, WatchEntity

DM_DRAFT = "19:bb22@thread.v2"
DM_AUTO = "19:aa11@thread.v2"


def _msg(thread_id: str, text: str = "Salut, tu as un moment ?", mentions=None, surface=Surface.dm):
    return IncomingMessage(thread_id=thread_id, sender="Quelqu'un", text=text, received_at="10:00", surface=surface, mentions=mentions or [])


def _queue(watcher, thread_id=DM_DRAFT, text="Salut, tu as un moment ?"):
    assert watcher._process(_msg(thread_id, text), force_draft=True) == "draft"
    return next(d for d in watcher.state.drafts if d.thread_id == thread_id)


def test_one_draft_per_thread(make_client):
    _client, watcher, _driver = make_client()
    watcher._process(_msg(DM_DRAFT, "premier"))
    watcher._process(_msg(DM_DRAFT, "second"))
    drafts = [d for d in watcher.state.drafts if d.thread_id == DM_DRAFT]
    assert len(drafts) == 1 and drafts[0].incoming == "second"


def test_unwatched_and_group_without_mention_ignored(make_client):
    _client, watcher, _driver = make_client()
    assert watcher._process(_msg("19:dd44@thread.v2", surface=Surface.channel)) is None
    assert watcher._process(_msg("19:cc33@thread.v2", surface=Surface.group)) is None
    assert watcher._process(_msg("19:cc33@thread.v2", mentions=["Damien"], surface=Surface.group)) == "draft"


def test_send_uses_edited_text(make_client):
    client, watcher, driver = make_client()
    d = _queue(watcher)
    r = client.post(f"/api/drafts/{d.id}/send", json={"text": "  Texte modifié  "})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert driver.typed == [(DM_DRAFT, "Texte modifié", True)]
    assert all(x.id != d.id for x in watcher.state.drafts)


def test_send_without_body_uses_proposal(make_client):
    client, watcher, driver = make_client()
    d = _queue(watcher)
    assert client.post(f"/api/drafts/{d.id}/send").json() == {"ok": True}
    assert driver.typed == [(DM_DRAFT, "Réponse de test", True)]


def test_send_blank_text_falls_back_to_proposal(make_client):
    client, watcher, driver = make_client()
    d = _queue(watcher)
    assert client.post(f"/api/drafts/{d.id}/send", json={"text": "   "}).status_code == 200
    assert driver.typed[0][1] == "Réponse de test"


def test_send_unknown_draft(make_client):
    client, _watcher, _driver = make_client()
    r = client.post("/api/drafts/nope/send", json={"text": "x"})
    assert r.status_code == 404 and r.json()["ok"] is False and r.json()["error"]


def test_send_refused_when_thread_not_confirmed(make_client):
    client, watcher, driver = make_client(driver=RefusingDriver(interval=9999))
    d = _queue(watcher)
    r = client.post(f"/api/drafts/{d.id}/send", json={"text": "Version éditée"})
    assert r.status_code == 409 and r.json()["ok"] is False
    assert driver.typed == []
    kept = next(x for x in watcher.state.drafts if x.id == d.id)
    assert kept.proposal == "Version éditée"
    assert watcher.state.logs[0].level == "warn"


def test_type_reply_guard_on_mock():
    from drivers.mock import MockTeamsDriver
    driver = MockTeamsDriver(interval=9999)
    assert driver.type_reply("19:inconnu@thread.v2", "x", send=True) is False
    assert driver.typed == []
    driver._active = DM_DRAFT
    assert driver._type_into_active(DM_AUTO, "x", send=True) is False
    assert driver.type_reply(DM_AUTO, "x", send=True) is True
    assert driver.active_thread() == DM_AUTO


def test_auto_send_and_refusal(make_client):
    _client, watcher, driver = make_client()
    assert watcher._process(_msg(DM_AUTO)) == "sent"
    assert driver.typed == [(DM_AUTO, "Réponse de test 🤖", True)]

    _client2, watcher2, driver2 = make_client(driver=RefusingDriver(interval=9999))
    assert watcher2._process(_msg(DM_AUTO)) == "draft"
    assert driver2.typed == []
    assert any(d.thread_id == DM_AUTO for d in watcher2.state.drafts)


def test_auto_forced_to_draft_by_filter_on_incoming(make_client):
    _client, watcher, driver = make_client()
    assert watcher._process(_msg(DM_AUTO, "Question sur mon salaire")) == "draft"
    assert driver.typed == []


def test_compose_types_without_sending(make_client):
    client, watcher, driver = make_client()
    d = _queue(watcher)
    r = client.post(f"/api/drafts/{d.id}/compose", json={"text": "À finir dans Teams"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert driver.typed == [(DM_DRAFT, "À finir dans Teams", False)]
    assert any(x.id == d.id for x in watcher.state.drafts)


def test_compose_refused(make_client):
    client, watcher, driver = make_client(driver=RefusingDriver(interval=9999))
    d = _queue(watcher)
    r = client.post(f"/api/drafts/{d.id}/compose")
    assert r.status_code == 409 and r.json()["ok"] is False
    assert driver.typed == []


def test_catchup_forces_draft_mode(make_client):
    client, watcher, driver = make_client()
    r = client.post("/api/catchup")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["queued"] == 3
    assert driver.typed == []
    threads = {d.thread_id for d in watcher.state.drafts}
    assert threads == {DM_AUTO, DM_DRAFT, "19:cc33@thread.v2"}
    assert next(d for d in watcher.state.drafts if d.thread_id == DM_AUTO).mode == "auto"


def test_catchup_respects_pause(make_client):
    client, watcher, _driver = make_client()
    client.post("/api/pause", json={"paused": True})
    r = client.post("/api/catchup")
    assert r.status_code == 409 and r.json()["ok"] is False
    assert watcher.state.drafts == []


def test_settings_get(make_client):
    client, _watcher, _driver = make_client()
    r = client.get("/api/settings").json()
    assert r["ok"] is True
    assert r["settings"] == {
        "onboarded": False,
        "brain": "claude",
        "models": {"claude_model": "haiku", "claude_effort": "", "copilot_model": "gpt-6-luna", "copilot_effort": "low"},
        "github": {"enabled": True, "all_repos": True},
        "safety": {
            "auto_pause_on_screen_share": True,
            "selftest_gate": True,
            "countdown_seconds": 0,
            "never_auto_send_if_message_contains": ["mot de passe", "confidentiel", "RH", "salaire"],
            "mark_auto_replies": True,
            "auto_max_per_hour": 5,
            "auto_quiet_hours": False,
            "auto_quiet_from": "19:00",
            "auto_quiet_to": "08:00",
            "auto_weekends": True,
        },
        "brief": {"enabled": True, "last_messages": 30},
        "follow_ups": {"enabled": True, "delay_hours": 24},
        "telemetry": {"enabled": False, "endpoint": "", "include_content": False},
        "mcp": {"enabled": False, "token": "", "allow_send": False},
        "teams_web": {"enabled": True},
        "ui": {"conversation_sort": "watched"},
    }


def test_settings_put_partial_hot_swap_and_persist(make_client, fresh_home):
    client, watcher, _driver = make_client()
    old_brain = watcher.brain
    r = client.put("/api/settings", json={"brain": "copilot", "safety": {"countdown_seconds": 12}, "github": {"all_repos": False}})
    assert r.status_code == 200
    s = r.json()["settings"]
    assert s["brain"] == "copilot" and s["safety"]["countdown_seconds"] == 12
    assert s["safety"]["auto_pause_on_screen_share"] is True
    assert s["github"] == {"enabled": True, "all_repos": False}
    assert watcher.brain is not old_brain and isinstance(watcher.brain, FakeBrain) and watcher.brain.name == "copilot"
    assert watcher.state.brain == "copilot"
    assert watcher.cfg["reply"]["auto_send_countdown_seconds"] == 12
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))
    assert saved["brain"]["provider"] == "copilot"
    assert saved["brain"]["claude"]["command"] == "claude"
    assert saved["reply"]["auto_send_countdown_seconds"] == 12
    assert saved["context"]["github"]["repos"] == "allowlist"
    assert client.get("/api/state").json()["brain"] == "copilot"


def test_conversation_sort_defaults_to_watched_and_persists(make_client, fresh_home):
    client, _watcher, _driver = make_client()
    assert client.get("/api/settings").json()["settings"]["ui"] == {"conversation_sort": "watched"}
    r = client.put("/api/settings", json={"ui": {"conversation_sort": "alpha"}})
    assert r.status_code == 200 and r.json()["settings"]["ui"]["conversation_sort"] == "alpha"
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))
    assert saved["ui"]["conversation_sort"] == "alpha"
    assert client.put("/api/settings", json={"ui": {"conversation_sort": "nope"}}).status_code == 422


def test_settings_put_same_brain_keeps_instance(make_client):
    client, watcher, _driver = make_client()
    old_brain = watcher.brain
    client.put("/api/settings", json={"brain": "claude"})
    assert watcher.brain is old_brain


def test_settings_validation_errors(make_client, fresh_home):
    client, watcher, _driver = make_client()
    before = (fresh_home / "config.json").read_text(encoding="utf-8")
    for body in (
        {"safety": {"countdown_seconds": 61}},
        {"safety": {"countdown_seconds": -1}},
        {"brain": "gpt"},
        {"inconnu": True},
        {"safety": {"selftest_gate": "peut-être"}},
    ):
        r = client.put("/api/settings", json=body)
        assert r.status_code == 422, body
        assert r.json()["ok"] is False and r.json()["error"]
    assert (fresh_home / "config.json").read_text(encoding="utf-8") == before
    assert watcher.state.brain == "claude"


def test_safety_settings_apply_live(make_client):
    client, watcher, driver = make_client()
    client.put("/api/settings", json={"safety": {"never_auto_send_if_message_contains": ["build"]}})
    assert watcher._process(_msg(DM_AUTO, "Le build passe ?")) == "draft"
    assert driver.typed == []


def test_onboarded_in_state_and_persisted(make_client):
    client, watcher, _driver = make_client()
    assert client.get("/api/state").json()["onboarded"] is False
    client.put("/api/settings", json={"onboarded": True})
    assert client.get("/api/state").json()["onboarded"] is True
    client2, _w2, _d2 = make_client()
    assert client2.get("/api/state").json()["onboarded"] is True
    assert client2.get("/api/settings").json()["settings"]["onboarded"] is True


def test_state_keeps_alias_serialization(make_client):
    client, watcher, _driver = make_client()
    _queue(watcher)
    state = client.get("/api/state").json()
    assert "from" in state["drafts"][0] and "from_" not in state["drafts"][0]


def test_watchlist_bulk(make_client, fresh_home):
    client, watcher, driver = make_client()
    driver._convs.append(WatchEntity(thread_id="19:ff66@thread.v2", display_name="Nouveau fil", surface=Surface.group))
    r = client.put("/api/watchlist", json=[
        {"thread_id": "19:dd44@thread.v2", "watch": True, "mode": "auto"},
        {"thread_id": "19:ff66@thread.v2", "watch": True, "mode": "draft"},
        {"thread_id": "19:inconnu@thread.v2", "watch": True, "mode": "auto"},
    ])
    assert r.status_code == 200 and r.json() == {"ok": True, "count": 2, "missing": ["19:inconnu@thread.v2"]}
    by_id = {w.thread_id: w for w in watcher.state.watchlist}
    assert by_id["19:dd44@thread.v2"].watch and by_id["19:dd44@thread.v2"].mode == "auto"
    assert by_id["19:ff66@thread.v2"].display_name == "Nouveau fil" and by_id["19:ff66@thread.v2"].watch
    assert "19:inconnu@thread.v2" not in by_id
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))
    assert {w["thread_id"] for w in saved["watchlist"]} >= {"19:dd44@thread.v2", "19:ff66@thread.v2"}


def test_watchlist_bulk_validation(make_client):
    client, _watcher, _driver = make_client()
    r = client.put("/api/watchlist", json=[{"thread_id": "19:aa11@thread.v2", "mode": "turbo"}])
    assert r.status_code == 422 and r.json()["ok"] is False


def test_per_thread_endpoints_still_work(make_client):
    client, watcher, _driver = make_client()
    assert client.post("/api/watch/19:ee55@thread.v2", json={"watch": True}).json() == {"ok": True}
    assert client.post("/api/mode/19:ee55@thread.v2", json={"mode": "auto"}).json() == {"ok": True}
    e = next(w for w in watcher.state.watchlist if w.thread_id == "19:ee55@thread.v2")
    assert e.watch and e.mode == "auto"


def test_soul_upload(make_client, fresh_home):
    client, watcher, _driver = make_client()
    r = client.post("/api/soul", json={"filename": "moi.md", "content": "# Moi\nTon direct."})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert (fresh_home / "SOUL.md").read_text(encoding="utf-8") == "# Moi\nTon direct."
    assert watcher.soul == "# Moi\nTon direct."


def test_soul_upload_validation(make_client, fresh_home):
    client, watcher, _driver = make_client()
    before = watcher.soul
    cases = [
        ({"filename": "moi.pdf", "content": "x"}, 422),
        ({"filename": "moi.md", "content": "   "}, 422),
        ({"filename": "moi.txt", "content": "é" * (40 * 1024)}, 413),
        ({"filename": "moi.md"}, 422),
    ]
    for body, status in cases:
        r = client.post("/api/soul", json=body)
        assert r.status_code == status, body
        assert r.json()["ok"] is False and r.json()["error"]
    assert watcher.soul == before
    assert (fresh_home / "SOUL.md").read_text(encoding="utf-8") == before


def test_foreign_web_origin_is_refused(make_client):
    client, watcher, driver = make_client()
    draft_id = watcher.state.drafts[0].id if watcher.state.drafts else None
    r = client.post("/api/pause", json={"paused": True}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["ok"] is False and watcher.state.paused is False
    r = client.post("/api/catchup", headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 403
    assert client.get("/api/state", headers={"Origin": "tauri://localhost"}).status_code == 200
    assert client.get("/api/state", headers={"Origin": "http://localhost:5173"}).status_code == 200
    assert client.get("/api/state", headers={"Host": "attacker.example:8731"}).status_code == 403


def test_foreign_origin_websocket_is_closed(make_client):
    from starlette.websockets import WebSocketDisconnect
    client, _watcher, _driver = make_client()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_text()
    with client.websocket_connect("/ws", headers={"Origin": "tauri://localhost"}) as ws:
        assert '"paused"' in ws.receive_text()


def test_unknown_thread_watch_is_404(make_client):
    client, _watcher, _driver = make_client()
    r = client.post("/api/watch/name:Q%26A%20%23prod", json={"watch": True})
    assert r.status_code == 404 and r.json()["ok"] is False


def test_hand_edited_settings_do_not_break_api(make_client, fresh_home):
    client, watcher, _driver = make_client()
    watcher.cfg = {**watcher.cfg, "reply": {"auto_send_countdown_seconds": 120}, "brain": {"provider": "gpt"}}
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json()["settings"]["safety"]["countdown_seconds"] == 60 and r.json()["settings"]["brain"] == "claude"


def test_selftest_reports_result(make_client):
    from conftest import RefusingDriver
    client, watcher, _driver = make_client()
    assert client.post("/api/selftest").json() == {"ok": True, "selftest_ok": True}

    class Broken(RefusingDriver):
        def selftest(self):
            raise RuntimeError("UIA")

    client, watcher, _driver = make_client(driver=Broken(interval=9999))
    assert client.post("/api/selftest").json() == {"ok": True, "selftest_ok": False} and watcher.state.selftest_ok is False


def test_websocket_sends_only_on_change(make_client, monkeypatch):
    import app as appmod
    monkeypatch.setattr(appmod, "WS_POLL", 0.01)
    client, watcher, _driver = make_client()
    with client.websocket_connect("/ws") as ws:
        first = ws.receive_text()
        watcher.set_paused(True)
        second = ws.receive_text()
    assert '"paused":false' in first and '"paused":true' in second


def test_soul_preview_uses_given_persona_without_saving(make_client, fresh_home):
    client, watcher, _driver = make_client()
    before = (fresh_home / "SOUL.md").read_text(encoding="utf-8")
    r = client.post("/api/soul/preview", json={"content": "# Moi\nTon direct."})
    assert r.status_code == 200 and r.json()["reply"] == "Réponse de test" and "PR #214" in r.json()["incoming"]
    assert (fresh_home / "SOUL.md").read_text(encoding="utf-8") == before
    assert client.post("/api/soul/preview", json={"content": ""}).status_code == 422


def test_factory_reset(make_client, fresh_home):
    client, watcher, _driver = make_client()
    client.put("/api/settings", json={"onboarded": True, "safety": {"countdown_seconds": 10}})
    client.post("/api/watch/19:ee55@thread.v2", json={"watch": True})
    client.post("/api/soul", json={"filename": "moi.md", "content": "# Moi"})
    client.post("/api/people", json={"filename": "e.json", "content": '{"people": [{"name": "A B"}]}'})
    assert client.post("/api/reset", json={}).status_code == 422
    assert client.post("/api/reset", json={"confirm": "RESET"}).json() == {"ok": True}
    s = client.get("/api/settings").json()["settings"]
    assert s["onboarded"] is False and s["safety"]["countdown_seconds"] == 5
    assert not any(w.watch for w in watcher.state.watchlist) and watcher.state.drafts == []
    assert watcher.soul != "# Moi"
    shipped = json.loads((cfgmod.ROOT / "ENTOURAGE.json").read_text(encoding="utf-8"))
    assert client.get("/api/people").json()["people"]["count"] == len(shipped["people"]) > 1
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))
    assert saved["watchlist"] == [] and saved["onboarded"] is False


def test_get_soul_returns_custom_persona_only(make_client, fresh_home):
    client, _w, _d = make_client()
    assert client.get("/api/soul").json()["soul"] == {"custom": False, "filename": "SOUL.md", "content": ""}
    client.post("/api/soul", json={"filename": "moi.md", "content": "# Moi\nDirect."})
    assert client.get("/api/soul").json()["soul"] == {"custom": True, "filename": "SOUL.md", "content": "# Moi\nDirect."}


def test_diagnostics_endpoint(make_client):
    client, _w, _d = make_client()
    r = client.post("/api/diagnostics/teams", json={})
    assert r.status_code == 200 and r.json()["report"]["driver"] == "MockTeamsDriver"


def test_logs_export(make_client, fresh_home):
    client, watcher, _driver = make_client()
    watcher.log("sent", "Envoyé à Lucas : « mot de passe 1234 »")
    (fresh_home / "backend.log").write_text("Traceback: boom\n", encoding="utf-8")
    r = client.get("/api/logs/export").json()
    assert r["ok"] and r["filename"].startswith("trame-journaux-") and r["filename"].endswith(".txt")
    text = r["text"]
    assert "## Journal" in text and "Envoyé à Lucas" in text and "mot de passe 1234" not in text
    assert "Traceback: boom" in text and "## OpenTelemetry" in text


def test_model_and_effort_reach_the_cli(make_client):
    from app import make_brain
    from brain.claude import ClaudeBrain
    from brain.copilot import CopilotBrain
    client, watcher, _d = make_client()
    r = client.put("/api/settings", json={"models": {"claude_model": "opus", "claude_effort": "high"}})
    assert r.status_code == 200 and r.json()["settings"]["models"]["claude_effort"] == "high"
    b = make_brain(watcher.cfg)
    assert isinstance(b, ClaudeBrain)
    assert b.args[b.args.index("--model") + 1] == "opus" and b.args[b.args.index("--effort") + 1] == "high"
    assert b.timeout == 90.0 and "--tools" in b.args
    r = client.put("/api/settings", json={"brain": "copilot", "models": {"copilot_model": "gpt-5"}})
    c = make_brain(watcher.cfg)
    assert isinstance(c, CopilotBrain) and c.args[c.args.index("--model") + 1] == "gpt-5"
    assert c.args.index("--model") < c.args.index("-p")


def test_model_cannot_inject_options(make_client):
    client, _w, _d = make_client()
    for bad in ["--dangerously-skip-permissions", "opus --tools Bash", "-x"]:
        r = client.put("/api/settings", json={"models": {"claude_model": bad}})
        assert r.status_code == 422, bad
    assert client.put("/api/settings", json={"models": {"claude_effort": "turbo"}}).status_code == 422


def test_claude_defaults_to_haiku():
    from app import make_brain
    b = make_brain({"brain": {"provider": "claude"}})
    assert b.args[b.args.index("--model") + 1] == "haiku" and "--effort" not in b.args
    b = make_brain({"brain": {"provider": "claude", "claude": {"model": ""}}})
    assert "--model" not in b.args


def test_copilot_defaults_to_gpt_6_luna_low():
    from app import make_brain
    c = make_brain({"brain": {"provider": "copilot"}})
    assert c.args[c.args.index("--model") + 1] == "gpt-6-luna"
    assert c.args[c.args.index("--reasoning-effort") + 1] == "low"
    assert c.args.index("--reasoning-effort") < c.args.index("-p") and c.timeout == 45.0


def test_refresh_conversations_adds_new_ones_and_keeps_choices(make_client):
    from models import Surface, WatchEntity
    client, watcher, driver = make_client()
    first = watcher.state.watchlist[0]
    first.watch, first.mode = True, "auto"
    before = len(watcher.state.watchlist)
    driver._convs.append(WatchEntity(thread_id="name:Nouvelle", display_name="Nouvelle", surface=Surface.dm))
    r = client.post("/api/conversations/refresh")
    assert r.status_code == 200 and r.json()["count"] == before + 1
    by = {w.thread_id: w for w in watcher.state.watchlist}
    assert "name:Nouvelle" in by and by[first.thread_id].watch and by[first.thread_id].mode == "auto"


def test_refresh_conversations_keeps_the_list_when_teams_gives_nothing(make_client):
    client, watcher, driver = make_client()
    before = list(watcher.state.watchlist)
    driver._convs = []
    assert client.post("/api/conversations/refresh").status_code == 409
    assert watcher.state.watchlist == before


def _incoming(thread_id="19:bb22@thread.v2", sender="Lucas", text="Salut"):
    from models import IncomingMessage, Surface
    return IncomingMessage(thread_id=thread_id, sender=sender, text=text, surface=Surface.dm, received_at="13:22")


def test_received_message_is_announced_even_when_not_followed(make_client):
    client, watcher, _driver = make_client()
    for w in watcher.state.watchlist:
        w.watch = False
    watcher._on_message(_incoming(thread_id="name:Inconnue", sender="Chiara", text="Tu as 5 min ?"))
    notice = client.get("/api/state").json()["notices"][0]
    assert (notice["from"], notice["text"], notice["conversation"]) == ("Chiara", "Tu as 5 min ?", "Chiara")
    assert watcher.state.drafts == []


def test_own_messages_and_sent_replies_are_not_announced(make_client):
    _client, watcher, _driver = make_client()
    watcher._on_message(_incoming(sender="Vous"))
    watcher._sent_recent["19:bb22@thread.v2"] = [(__import__("time").monotonic(), "Je regarde")]
    watcher._on_message(_incoming(text="Je regarde"))
    assert watcher.state.notices == []


def test_notices_are_capped_and_newest_first(make_client):
    _client, watcher, _driver = make_client()
    for i in range(25):
        watcher._notice(_incoming(text=f"m{i}"))
    assert len(watcher.state.notices) == 20 and watcher.state.notices[0].text == "m24"


def test_countdown_zero_is_kept(make_client, fresh_home):
    client, watcher, _d = make_client()
    r = client.put("/api/settings", json={"safety": {"countdown_seconds": 0}})
    assert r.status_code == 200 and r.json()["settings"]["safety"]["countdown_seconds"] == 0
    assert watcher.cfg["reply"]["auto_send_countdown_seconds"] == 0
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))
    assert saved["reply"]["auto_send_countdown_seconds"] == 0
    assert client.get("/api/settings").json()["settings"]["safety"]["countdown_seconds"] == 0
