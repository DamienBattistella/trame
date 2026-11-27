"""Favoris synchronisés avec Teams : la section « Favoris » de Teams web est la source."""
from __future__ import annotations
import json

from drivers.mock import MockTeamsDriver
from drivers.web_bridge import WebBridgeDriver

SOFIA, LUCAS, PROD, CHIARA = "19:aa11@thread.v2", "19:bb22@thread.v2", "19:dd44@thread.v2", "19:ee55@thread.v2"


def _rail(expanded: bool = True) -> list[dict]:
    # Ce que rend l'opération « list » du pont : en-têtes de dossiers puis leurs lignes.
    return [
        {"label": "Vues rapides Mentions", "aria": "expanded=true", "id": ""},
        {"label": "Favoris Foundation 24/11", "aria": "expanded=true" if expanded else "", "id": "", "folder": "favorites"},
        *([{"label": "Foundation 24/11 Vous : ok", "id": "title-chat-list-item_19:f00@thread.v2", "fav": True},
           {"label": "Hexaflux 26/11 Santiago: bonjour", "id": "title-chat-list-item_19:4e@thread.v2", "fav": True}]
          if expanded else []),
        # Une section perso repliée : son nom seul, jamais une conversation.
        {"label": "Projets", "aria": "", "id": "", "folder": "section"},
        {"label": "Conversations Marion", "aria": "expanded=true", "id": "", "folder": "section"},
        {"label": "Marion Guernoté 09:38", "id": "title-chat-list-item_19:a1@thread.v2"},
    ]


def test_bridge_reads_the_favorites_section_in_teams_order():
    d = WebBridgeDriver()
    seen: list[list[str]] = []
    d.on_favorites = seen.append
    d._rpc = lambda op, **_: _rail()
    names = [c.display_name for c in d.list_conversations()]
    assert names == ["Foundation", "Hexaflux", "Marion Guernoté"]
    assert d.teams_favorites() == ["title-19:f00@thread.v2", "title-19:4e@thread.v2"]
    assert seen == [["title-19:f00@thread.v2", "title-19:4e@thread.v2"]]
    d.list_conversations()
    assert len(seen) == 1, "même section : pas de nouvel appel"


def test_collapsed_favorites_section_says_nothing():
    d = WebBridgeDriver()
    seen: list[list[str]] = []
    d.on_favorites = seen.append
    d._rpc = lambda op, **_: _rail(expanded=False)
    d.list_conversations()
    assert d.teams_favorites() is None and seen == []


def test_empty_favorites_section_is_an_answer():
    d = WebBridgeDriver()
    seen: list[list[str]] = []
    d.on_favorites = seen.append
    d._rpc = lambda op, **_: [r for r in _rail() if not r.get("fav")]
    d.list_conversations()
    assert d.teams_favorites() == [] and seen == [[]]


def test_trame_favorites_follow_teams(make_client, fresh_home):
    _c, watcher, _d = make_client()
    watcher.state.favorites = [LUCAS, SOFIA, CHIARA]
    watcher._sync_teams_favorites([PROD, SOFIA, LUCAS])
    # Ceux que Teams n'a plus partent ; l'ordre de Trame reste pour les autres ; les
    # nouveaux suivent, dans l'ordre de Teams.
    assert watcher.state.favorites == [LUCAS, SOFIA, PROD]
    saved = json.loads((fresh_home / "config.json").read_text(encoding="utf-8"))["favorites"]
    assert saved == [LUCAS, SOFIA, PROD]


class TeamsFavoritesDriver(MockTeamsDriver):
    supports_teams_favorites = True

    def __init__(self, *a, accept: bool = True, **kw):
        super().__init__(*a, **kw)
        self.accept, self.calls = accept, []

    def set_teams_favorite(self, thread_id: str, favorite: bool) -> bool:
        self.calls.append((thread_id, favorite))
        if not self.accept:
            self.last_error = "Teams intégré : entrée « Supprimer de la section » introuvable"
        return self.accept


def test_star_in_trame_sets_the_favorite_in_teams(make_client, fresh_home):
    driver = TeamsFavoritesDriver(interval=9999)
    client, watcher, _ = make_client(driver=driver)
    assert client.post(f"/api/favorite/{SOFIA}", json={"favorite": True}).json()["favorites"] == [SOFIA]
    assert client.post(f"/api/favorite/{SOFIA}", json={"favorite": False}).json()["favorites"] == []
    assert driver.calls == [(SOFIA, True), (SOFIA, False)]


def test_teams_refusal_changes_nothing(make_client, fresh_home):
    driver = TeamsFavoritesDriver(interval=9999, accept=False)
    client, watcher, _ = make_client(driver=driver)
    watcher.state.favorites = [SOFIA]
    r = client.post(f"/api/favorite/{SOFIA}", json={"favorite": False})
    assert r.status_code == 502 and "Supprimer de la section" in str(r.json())
    assert watcher.state.favorites == [SOFIA]
