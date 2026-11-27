"""Liste vivante : le non-lu, l'heure et l'ordre de Teams suivent chaque coup d'œil à la liste,
pas seulement la connexion (un message reçu dans Teams restait invisible dans Trame)."""
from __future__ import annotations

from drivers.web_bridge import WebBridgeDriver
from models import Surface, WatchEntity

H10, VICTOR, ISA, OLD = "title-19:h10@thread.v2", "title-19:vd@unq.gbl.spaces", "title-19:ir@unq.gbl.spaces", "title-19:old@thread.v2"


def _row(label: str, tid: str) -> dict:
    return {"label": label, "id": f"title-chat-list-item_{tid.removeprefix('title-')}"}


def test_each_look_at_the_list_reports_unread_and_time():
    d = WebBridgeDriver()
    rail = [_row("Hexagone 10 - Developers 10:43 Isabelle: ok", H10), _row("Isabelle Ravet 10:45 merci", ISA)]
    d._rpc = lambda op, **_: rail
    seen: list[list[WatchEntity]] = []
    d.on_conversations = seen.append
    d.watch_tick(lambda m: None)
    rail[:] = [_row("Non lu Hexagone 10 - Developers 10:54 Isabelle: FYI", H10),
               _row("Non lu Victor Dumont 10:53 c'est les pr de marion", VICTOR),
               _row("Isabelle Ravet 10:45 merci", ISA)]
    d.watch_tick(lambda m: None)
    last = {e.display_name: e for e in seen[-1]}
    h10 = last["Hexagone 10 - Developers"]
    assert (h10.unread, h10.last_activity, h10.rank) == (True, "10:54", 0)
    assert last["Victor Dumont"].unread and not last["Isabelle Ravet"].unread


def test_engine_follows_the_live_list(make_client):
    _c, watcher, _d = make_client()
    watcher.state.watchlist = [
        WatchEntity(thread_id=H10, display_name="Hexagone 10 - Developers", surface=Surface.group, watch=True, mode="auto", rank=0, last_activity="10:43"),
        WatchEntity(thread_id=ISA, display_name="Isabelle Ravet", surface=Surface.dm, rank=1, last_activity="10:45"),
        WatchEntity(thread_id=OLD, display_name="Ancienne", surface=Surface.group, rank=2, last_activity="20/11", unread=True),
    ]
    watcher._apply_live_list([
        WatchEntity(thread_id=H10, display_name="Hexagone 10 - Developers", surface=Surface.group, rank=0, last_activity="10:54", unread=True),
        WatchEntity(thread_id=VICTOR, display_name="Victor Dumont", surface=Surface.dm, rank=1, last_activity="10:53", unread=True),
        WatchEntity(thread_id=ISA, display_name="Isabelle Ravet", surface=Surface.dm, rank=2, last_activity="10:45"),
    ])
    by = {w.thread_id: w for w in watcher.state.watchlist}
    # Non-lu et heure de Teams ; les choix de l'utilisateur restent.
    assert (by[H10].unread, by[H10].last_activity, by[H10].watch, by[H10].mode) == (True, "10:54", True, "auto")
    # Nouvelle conversation dans la liste : ajoutée, non suivie.
    assert by[VICTOR].unread and not by[VICTOR].watch
    # Hors de l'écran : état gardé, rangée après celles qu'on voit.
    assert (by[OLD].unread, by[OLD].rank) == (True, 3)
    assert sorted(watcher.state.watchlist, key=lambda w: w.rank)[:3] == [by[H10], by[VICTOR], by[ISA]]


def test_reading_in_teams_clears_unread(make_client):
    _c, watcher, _d = make_client()
    watcher.state.watchlist = [WatchEntity(thread_id=H10, display_name="H10", surface=Surface.group, rank=0, unread=True)]
    watcher._apply_live_list([WatchEntity(thread_id=H10, display_name="H10", surface=Surface.group, rank=0, last_activity="10:54")])
    assert watcher.state.watchlist[0].unread is False
