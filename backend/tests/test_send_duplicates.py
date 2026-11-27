"""Jamais de doublon après un envoi incertain : mention relue sans « @ », envoi automatique
incertain, nouvel essai d'un message incertain de la file."""
from __future__ import annotations

import attachments as attachmod
from drivers.base import SendUncertain
from models import IncomingMessage


def test_a_mention_shows_without_its_at_sign_once_sent():
    assert attachmod.shows({"text": "Ana Lopez tu peux voir ?"}, "@Ana Lopez tu peux voir ?", [])
    # Un courriel garde son « @ » des deux côtés : toujours reconnu.
    assert attachmod.shows({"text": "Écris à ana@exemple.fr"}, "Écris à ana@exemple.fr", [])
    assert not attachmod.shows({"text": "Autre chose"}, "@Ana Lopez tu peux voir ?", [])


def _auto(watcher):
    entity = watcher.state.watchlist[0]
    entity.watch, entity.mode = True, "auto"
    watcher.state.selftest_ok = True
    watcher.cfg.setdefault("reply", {})["fact_check_before_auto_send"] = False
    watcher.cfg["reply"]["auto_send_countdown_seconds"] = 0
    watcher._screen_sharing = lambda: False
    watcher._draft_reply = lambda *a, **k: "Avec plaisir !"
    return entity


def test_uncertain_automatic_send_leaves_a_draft_that_is_never_sent_twice(make_client):
    client, watcher, driver = make_client()
    entity = _auto(watcher)

    def unsure(*a, **k):
        raise SendUncertain("pas de réponse de la page")

    driver.type_focused = unsure
    msg = IncomingMessage(thread_id=entity.thread_id, sender="Ana Martin", text="Merci pour ton aide !",
                          received_at="10:00", surface=entity.surface)
    assert watcher._process(msg) == "draft"
    assert entity.thread_id in watcher._unconfirmed
    assert any("non confirmé" in line.text for line in watcher.state.logs)
    # Le brouillon laissé : Teams montre déjà la réponse, elle ne repart pas.
    watcher.thread_messages = lambda tid, n=10, fresh=False: [{"mine": True, "text": "Avec plaisir !", "at": "10:01", "files": []}]
    draft = watcher.state.drafts[0]
    r = client.post(f"/api/drafts/{draft.id}/send", json={})
    assert r.status_code == 409 and r.json()["code"] == "maybe_sent"


def test_retrying_an_uncertain_outbox_item_rereads_the_thread_first(make_client):
    client, watcher, driver = make_client()
    tid = watcher.state.watchlist[0].thread_id
    item = watcher._enqueue(tid, "Lucas", "Coucou", None, (), (), "test")
    watcher._outbox_update(item, status="uncertain", reason="peut-être parti")
    watcher._unconfirmed.clear()  # comme après un redémarrage
    watcher.thread_messages = lambda t, n=10, fresh=False: [{"mine": True, "text": "Coucou", "at": "18:22", "files": []}]
    r = client.post(f"/api/outbox/{item.id}/retry")
    assert r.status_code == 409 and r.json()["code"] == "maybe_sent"
    assert watcher._outbox_item(item.id).status == "uncertain"
