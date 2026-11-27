from __future__ import annotations
import json
from datetime import date, datetime
from types import SimpleNamespace

import archiving
import config as cfgmod
from models import IncomingMessage, Surface
from test_mcp import _call, _enable

SOFIA, LUCAS, INTEROP, PROD, CHIARA, MEETING = (
    "19:aa11@thread.v2", "19:bb22@thread.v2", "19:cc33@thread.v2", "19:dd44@thread.v2", "19:ee55@thread.v2",
    "19:meeting_ff66@thread.v2")
TODAY = date(2026, 11, 26)  # un jeudi
NOW = datetime(2026, 11, 26, 10, 0)


def _saved(home) -> dict:
    return json.loads((home / "config.json").read_text(encoding="utf-8")).get("archived", {})


def _age(watcher, labels: dict[str, str | None]) -> None:
    for w in watcher.state.watchlist:
        if w.thread_id in labels:
            w.last_activity = labels[w.thread_id]


# --- âge d'après la liste Teams ---

def test_label_date_reads_what_teams_shows():
    assert archiving.label_date("09:31", TODAY) == TODAY
    assert archiving.label_date("Hier", TODAY) == date(2026, 11, 25)
    assert archiving.label_date("yesterday", TODAY) == date(2026, 11, 25)
    # Un jour de la semaine : le plus récent avant aujourd'hui (jamais aujourd'hui, qui s'écrit en heure).
    assert archiving.label_date("lun.", TODAY) == date(2026, 11, 23)
    assert archiving.label_date("Thu", TODAY) == date(2026, 11, 19)
    assert archiving.label_date("25/11", TODAY) == date(2026, 11, 25)
    # Sans année, une date à venir est celle de l'an dernier.
    assert archiving.label_date("28/12", TODAY) == date(2025, 12, 28)
    assert archiving.label_date("03/02/25", TODAY) == date(2025, 2, 3)
    assert archiving.label_date("03/02/2024", TODAY) == date(2024, 2, 3)
    for unsure in (None, "", "31/02", "bientôt", "Teams"):
        assert archiving.label_date(unsure, TODAY) is None


def test_stale_only_past_the_threshold_and_never_on_an_unknown_age():
    assert archiving.is_stale(date(2026, 10, 27), 30, TODAY)
    assert not archiving.is_stale(date(2026, 10, 28), 30, TODAY)
    assert not archiving.is_stale(None, 7, TODAY)
    assert not archiving.is_stale(date(2020, 1, 1), 0, TODAY)
    # Ce que Trame a vu passer compte autant que l'heure de la liste.
    assert archiving.last_activity("01/09", datetime(2026, 11, 20, 8, 0), NOW) == date(2026, 11, 20)


# --- à la main ---

def test_manual_archive_and_restore_survive_a_restart(make_client, fresh_home):
    client, watcher, _d = make_client()
    r = client.post(f"/api/archive/{CHIARA}", json={"archived": True}).json()
    assert r["ok"] and set(r["archived"]) == {CHIARA} and r["archived"][CHIARA]["auto"] is False
    assert CHIARA in _saved(fresh_home)
    assert client.get("/api/state").json()["archived"][CHIARA]["hidden"] is False
    # Rien n'est supprimé : la conversation reste connue, avec son suivi et son mode.
    assert any(w.thread_id == CHIARA for w in watcher.state.watchlist)
    assert client.post("/api/archive/19:inconnue@thread.v2", json={"archived": True}).status_code == 404

    _c2, watcher2, driver2 = make_client()
    assert set(watcher2.state.archived) == {CHIARA}
    # Hors de la liste Teams, une conversation archivée reste connue, pour la désarchiver.
    driver2._convs = [c for c in driver2._convs if c.thread_id != CHIARA]
    watcher2.refresh_conversations()
    assert any(w.thread_id == CHIARA for w in watcher2.state.watchlist)

    assert client.post(f"/api/archive/{CHIARA}", json={"archived": False}).json()["archived"] == {}
    assert _saved(fresh_home) == {}


def test_a_new_message_brings_it_back(make_client, fresh_home):
    client, watcher, _d = make_client()
    client.post(f"/api/archive/{CHIARA}", json={"archived": True})
    watcher._on_message(IncomingMessage(thread_id=CHIARA, sender="Chiara Rossi", text="Tu as deux minutes ?",
                                        received_at="", surface=Surface.dm))
    assert CHIARA not in watcher.state.archived and _saved(fresh_home) == {}
    assert any("désarchivée (nouveau message)" in log.text for log in watcher.state.logs)


def test_new_activity_in_the_teams_list_brings_it_back(make_client, fresh_home):
    client, watcher, driver = make_client()
    for c in driver._convs:
        if c.thread_id in (CHIARA, PROD):
            c.last_activity = "20/11"
    watcher.refresh_conversations()
    client.post(f"/api/archive/{CHIARA}", json={"archived": True})
    client.post(f"/api/archive/{PROD}", json={"archived": True})
    assert watcher.state.archived[CHIARA].label == "20/11"
    # Teams montre une autre heure pour Chiara, et un non-lu pour #prod-incidents.
    for c in driver._convs:
        if c.thread_id == CHIARA:
            c.last_activity = "09:12"
        if c.thread_id == PROD:
            c.unread = True
    watcher.refresh_conversations()
    assert watcher.state.archived == {}


# --- automatique ---

def test_auto_archive_is_off_by_default(make_client, fresh_home):
    _client, watcher, _d = make_client()
    _age(watcher, {t: "01/09" for t in (SOFIA, LUCAS, INTEROP, PROD, CHIARA, MEETING)})
    assert watcher.auto_archive(NOW) == []


def test_auto_archive_spares_what_still_matters(make_client, fresh_home):
    client, watcher, _d = make_client()
    s = client.put("/api/settings", json={"archive": {"after_days": 30}}).json()["settings"]["archive"]
    assert s == {"after_days": 30, "hide_in_teams": False}
    _age(watcher, {SOFIA: "01/09", LUCAS: "01/09", INTEROP: "01/09", PROD: "01/09", CHIARA: "01/09", MEETING: None})
    client.post(f"/api/favorite/{CHIARA}", json={"favorite": True})
    watcher.state.drafts = [SimpleNamespace(thread_id=LUCAS)]
    watcher.state.follow_ups = [SimpleNamespace(thread_id=INTEROP)]
    # Sofia est en mode Auto : jamais coupée en silence. Point interop : âge inconnu.
    assert watcher.auto_archive(NOW) == [PROD]
    assert watcher.state.archived[PROD].auto is True
    assert any("archivée (sans activité depuis longtemps)" in log.text for log in watcher.state.logs)
    # Récent : rien de plus.
    _age(watcher, {LUCAS: "Hier"})
    watcher.state.drafts = []
    assert watcher.auto_archive(NOW) == []


def test_factory_reset_clears_archives(make_client, fresh_home):
    client, watcher, _d = make_client()
    client.post(f"/api/archive/{CHIARA}", json={"archived": True})
    assert client.post("/api/reset", json={"confirm": "RESET"}).json() == {"ok": True}
    assert watcher.state.archived == {} and cfgmod.load()["archived"] == {}


def test_mcp_lists_archived_read_only(make_client, fresh_home):
    client, _w, _d = make_client()
    client.post(f"/api/archive/{CHIARA}", json={"archived": True})
    token = _enable(client)
    convs = json.loads(_call(client, token, "tools/call", {"name": "list_conversations", "arguments": {}}).json()["result"]["content"][0]["text"])
    by_id = {c["thread_id"]: c for c in convs}
    assert by_id[CHIARA]["archived"] is True and by_id[SOFIA]["archived"] is False


# --- masquer dans Teams : indisponible sans Microsoft Graph (retiré) ---

def test_hiding_in_teams_is_unavailable_and_archive_stays_local(make_client):
    """Le masquage dans Teams passait par Microsoft Graph, retiré : il n'est plus proposé et
    l'archivage reste local à Trame, même avec l'option activée."""
    client, watcher, _d = make_client()
    assert client.get("/api/archive").json()["can_hide_in_teams"] is False
    client.put("/api/settings", json={"archive": {"hide_in_teams": True}})
    client.post(f"/api/archive/{SOFIA}", json={"archived": True})
    assert watcher.state.archived[SOFIA].hidden is False
