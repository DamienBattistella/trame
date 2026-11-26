"""Les repères que le pont cherche dans Teams web, confrontés à un fragment de la vraie page.

fixtures/teams/page.html a été relevé sur teams.cloud.microsoft par fixtures/teams/record.js
(structure seule : ni texte ni nom). Si un sélecteur du pont change et ne trouve plus ce
que Teams affiche, ces tests cassent ; si Teams change, on relève un nouveau fragment."""
from __future__ import annotations
import re
from pathlib import Path

import pytest
from bs4 import BeautifulSoup

import teams_check

BRIDGE = Path(__file__).resolve().parents[2] / "ui" / "src-tauri" / "teams-bridge.js"
PAGE = Path(__file__).resolve().parent / "fixtures" / "teams" / "page.html"
NEW_CHAT = Path(__file__).resolve().parent / "fixtures" / "teams" / "newchat.html"
SOURCE = BRIDGE.read_text(encoding="utf-8")

_BLOCK = SOURCE[SOURCE.index("const LANDMARKS = ["):SOURCE.index("];", SOURCE.index("const LANDMARKS = ["))]
TABLE = re.findall(r'\[\s*"(\w+)",\s*"(\w+)",\s*\'([^\']*)\'\s*\]', _BLOCK)
SCOPES = {"page", "chat", "thread", "hover", "unread", "menu"}

# Repères que Teams a changés et que le pont ne retrouve pas encore (vide : tous retrouvés).
# Un repère ajouté ici doit manquer à la page relevée ; retrouvé, le test demande de l'ôter.
KNOWN_ABSENT: dict[str, str] = {}

# data-tid cités dans le pont sans être des repères contrôlés, et pourquoi.
NOT_WATCHED = {
    "message-compose": "repli de l'éditeur et de la zone de citation",
    "quoted-reply-card": "constat de la citation, vérifié par l'opération elle-même",
    "close-quoted-reply": "nettoyage après échec, sans effet sur le résultat",
    "diverse-reaction-pill-button": "pastilles de réactions déjà posées, repli sur les boutons",
    "file-attachment-grid": "pièces jointes reçues : absentes de la plupart des fils",
    "message-author-name": "auteur affiché seulement en tête d'une suite de messages",
    "me-control-status-note-container": "message de statut, présent seulement s'il y en a un",
    "me-control-menu-status-message-clear-button": "présent seulement s'il y a un message de statut",
    "me-control-set-status-message": "panneau ouvert par note_edit, constaté par l'opération",
    "me-control-set-status-message-update-status-message-button": "dans le panneau de note_edit",
    "me-control-set-status-message-back-button": "retour arrière de secours",
    "me-control-set-availability-back-button": "retour arrière de secours",
    "message-actions-edit": "seulement sur tes propres messages ; delete le vérifie",
    "message-actions-${reaction}": "les quatre réactions sont des repères react_*",
    "${tid}": "choix de statut, représentés par status_choice",
    "newMessageCommands-discard-draft": "présent seulement quand un brouillon attend",
    "search-message-card": "résultats de recherche : aucun quand rien ne correspond",
    "message-app-card-header": "dans les résultats de recherche",
    "86fcd49b-61a2-4701-b771-54728cd291fb": "dans chat_app",
    # Lien de la réunion d'une conversation de réunion : rien d'autre dans la page ne dit
    # qu'une conversation en est une, le contrôle ne saurait pas quand les exiger.
    "chat-join-button": "seulement dans une conversation de réunion",
    "entity-header-toolbar": "lu pour le lien de réunion, absent ou présent selon la conversation",
    "chat-meeting-details": "seulement dans une conversation de réunion",
}


def _page() -> BeautifulSoup:
    return BeautifulSoup(PAGE.read_text(encoding="utf-8"), "html.parser")


def test_table_read_from_the_bridge():
    keys = [k for k, _, _ in TABLE]
    assert len(keys) == len(set(keys)) and len(keys) >= 30
    assert {w for _, w, _ in TABLE} <= SCOPES


def test_engine_knows_every_landmark():
    # Le moteur doit savoir dire ce que casse chaque repère, et rien de plus.
    assert [k for k, _, _ in TABLE] == list(teams_check.LANDMARKS)
    for _label, feats in teams_check.LANDMARKS.values():
        assert feats and set(feats) <= set(teams_check.FEATURES)


def test_every_data_tid_of_the_bridge_is_watched():
    watched = " ".join(sel for _, _, sel in TABLE)
    rest = SOURCE.replace(_BLOCK, "")
    used = set(re.findall(r'data-tid="([^"]+)"', rest)) | set(re.findall(r'"(message-actions-[\w-]+)"', rest))
    missing = sorted(t for t in used if f'"{t}"' not in watched and t not in NOT_WATCHED)
    assert not missing, f"data-tid du pont ni contrôlés ni justifiés : {missing}"


@pytest.mark.parametrize("key,scope,selector", [t for t in TABLE if t[1] != "menu" and t[2]])
def test_selector_finds_the_real_page(key, scope, selector):
    found = _page().select_one(selector) is not None
    if key in KNOWN_ABSENT:
        assert not found, f"« {key} » retrouvé : le retirer de KNOWN_ABSENT"
    else:
        assert found, f"« {key} » ({selector}) ne trouve plus rien dans la page relevée"


def test_new_chat_screen():
    # Écran « Nouveau message » : le champ « À » et ses suggestions, pas la recherche du haut
    # (elle aussi une liste déroulante, plus haut dans la page : l'ancien repli tombait dessus).
    soup = BeautifulSoup(NEW_CHAT.read_text(encoding="utf-8"), "html.parser")
    sel = dict((k, s) for k, _, s in TABLE)
    picked = soup.select(sel["people_picker"])
    assert [el.get("id") for el in picked] == ["people-picker-input"]
    assert soup.select_one(sel["search_input"]) not in picked
    options = soup.select(sel["people_list"])
    assert len(options) == 2
    # La liste suggérée est celle que le champ désigne (aria-controls), lue par le pont.
    listbox = soup.find(id=picked[0]["aria-controls"])
    assert listbox is not None and all(listbox in o.parents for o in options)
    assert soup.select_one(sel["new_chat"]) is not None


@pytest.mark.parametrize("fixture", [PAGE, NEW_CHAT], ids=["page", "newchat"])
def test_page_is_structure_only(fixture):
    html = fixture.read_text(encoding="utf-8")
    body = html[html.index("<body"):]
    assert re.sub(r"<[^>]*>|\s", "", body) == "", "texte de page dans le fragment"
    assert not re.search(r"[\w.-]+@(?!thread\.v2)[\w-]+\.\w+", body), "adresse dans le fragment"
    labels = set(re.findall(r'aria-label="([^"]*)"', body))
    # Les deux suggestions du champ « À » portent des noms fictifs, mis au relevé.
    assert labels <= {"Conversation", "Joindre", "Envoyer", "Non lu", "Nouveau message",
                      "Ana Lopez (Vous), Ingénierie", "Ana et Marc"}


def test_send_button_uses_the_current_data_tid():
    # Teams web nomme le bouton sendMessageCommands-send : le pont le cherche en premier.
    first = SOURCE.split("const sendButton")[1].split("||")[0]
    assert '[data-tid="sendMessageCommands-send"]' in first
