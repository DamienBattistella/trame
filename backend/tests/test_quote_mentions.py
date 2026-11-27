"""Citation d'une réponse, mentions et « Modifié » : vérifiés au passage du pont, la citation
gardée hors du texte de la réponse et rendue au cerveau comme contexte."""
from __future__ import annotations

from drivers.web_bridge import WebBridgeDriver
from models import IncomingMessage, QuoteRef, Surface

DM = "19:bb22@thread.v2"


def _bridge(monkeypatch, messages):
    driver = WebBridgeDriver()
    monkeypatch.setattr(driver, "_rpc", lambda op, timeout=None, **a: {"messages": messages, "top": True})
    return driver


def test_bridge_reads_quote_mentions_and_edited(monkeypatch):
    driver = _bridge(monkeypatch, [
        {"sender": "Yves", "text": "D'accord pour moi", "at": "16:59", "edited": True,
         "quote": {"sender": "  Paul   Durand ", "at": "05/11/2026 14:02", "text": "Le point de jeudi"},
         "mentions": ["Alex Martin", "", "Alex Martin", 42, "Lou"]},
        # Rien de lisible dans la citation : pas de citation ; « edited » doit être un vrai booléen.
        {"sender": "Yves", "text": "Suite", "at": "17:00", "edited": "yes", "quote": {"sender": "", "text": ""}},
        {"sender": "Yves", "text": "Ce message a été supprimé.", "at": "17:01", "edited": True,
         "quote": {"sender": "Paul", "text": "x"}, "mentions": ["Lou"]},
    ])
    first, second, deleted = driver.read_history(DM, 30)[0]
    assert first.text == "D'accord pour moi"
    assert first.quote == QuoteRef(sender="Paul Durand", at="05/11/2026 14:02", text="Le point de jeudi")
    assert first.mentions == ["Alex Martin", "42", "Lou"]
    assert first.edited is True
    assert (second.quote, second.edited, second.mentions) == (None, False, [])
    assert (deleted.quote, deleted.edited, deleted.mentions) == (None, False, [])


def test_brain_sees_what_a_reply_answers():
    m = IncomingMessage(thread_id=DM, sender="Yves", text="D'accord", received_at="16:59", surface=Surface.dm,
                        quote=QuoteRef(sender="Paul Durand", at="Hier 14:02", text="Le point\nde jeudi"))
    assert m.brain_text() == "(en réponse à Paul Durand (Hier 14:02) : « Le point de jeudi »)\nD'accord"
