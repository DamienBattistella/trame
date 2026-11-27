"""WebApiDriver : gestes (lu, réaction, suppression, envoi) par le service de chat, prouvés par
relecture ; la page reprend tout geste qui n'est pas parti ; un geste parti sans preuve est
« incertain » et n'est jamais refait."""
from __future__ import annotations

import pytest

from drivers.base import DeleteUncertain, Focus, ReactUncertain, SendUncertain
from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver
from models import MessageRef

TID = "title-19:grp@thread.v2"


class FakePage:
    def __init__(self, answer):
        self.answer = answer
        self.calls: list[tuple] = []
        self.page: list[tuple] = []
        self.chat_aliases: dict[str, str] = {}
        self.last_error = None

    _ref = staticmethod(WebBridgeDriver._ref)
    chat_id = staticmethod(WebBridgeDriver.chat_id)

    def chat_gesture(self, kind, thread_id, **args):
        self.calls.append((kind, thread_id, args))
        return dict(self.answer)

    # La page (DOM), quand le service ne peut pas.
    def mark_read(self, thread_id):
        self.page.append(("markread", thread_id))
        return True

    def react_focused(self, thread_id, target, reaction, restore=True, remove=False):
        self.page.append(("react", thread_id, reaction, remove))
        return Focus(ok=True)

    def delete_focused(self, thread_id, target, restore=True):
        self.page.append(("delete", thread_id))
        return Focus(ok=True)

    def type_focused(self, thread_id, text, send, restore, **kw):
        self.page.append(("type", thread_id, text, send, tuple(sorted(kw))))
        return Focus(ok=True)


REF = MessageRef(id="1795777000001", sender="Ana Martin", text="Bonjour")


def test_proven_gestures_never_touch_the_page():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    assert d.mark_read(TID) is True
    assert d.react_focused(TID, REF, "like").ok
    assert d.delete_focused(TID, REF).ok
    assert d.type_focused(TID, "C'est noté.", True, restore=True).ok
    assert [c[0] for c in page.calls] == ["markread", "react", "delete", "send"]
    assert page.page == []
    assert page.calls[1][2] == {"message": {"id": "1795777000001", "sender": "Ana Martin", "text": "Bonjour"},
                                "reaction": "like", "remove": False}
    assert page.calls[3][2] == {"text": "C'est noté."}
    assert all(d.routes()[a]["via"] == "api" for a in ("mark_read", "react", "delete", "send"))


def test_removing_a_reaction_goes_to_the_chat_service_then_the_page_the_same_way():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    assert d.react_focused(TID, REF, "heart", remove=True).ok
    assert page.calls[0][0] == "react" and page.calls[0][2]["remove"] is True and page.page == []
    fallback = FakePage({"ok": False, "attempted": False, "error": "conversation sans identifiant Teams"})
    assert WebApiDriver(fallback).react_focused(TID, REF, "heart", remove=True).ok
    assert fallback.page == [("react", TID, "heart", True)]


def test_gesture_not_attempted_falls_back_to_the_page_with_the_reason():
    page = FakePage({"ok": False, "attempted": False, "error": "texte différent de celui affiché"})
    d = WebApiDriver(page)
    assert d.react_focused(TID, REF, "heart").ok
    assert d.type_focused(TID, "ok", True, restore=True).ok
    assert d.mark_read(TID) is True
    assert [p[0] for p in page.page] == ["react", "type", "markread"]
    assert d.routes()["react"]["via"] == "page" and "texte différent" in d.routes()["react"]["reason"]


@pytest.mark.parametrize("call, exc", [
    (lambda d: d.type_focused(TID, "Je regarde ça", True, restore=True), SendUncertain),
    (lambda d: d.react_focused(TID, REF, "like"), ReactUncertain),
    (lambda d: d.delete_focused(TID, REF), DeleteUncertain),
])
def test_gesture_sent_without_proof_is_uncertain_and_never_redone_on_the_page(call, exc):
    page = FakePage({"ok": False, "attempted": True, "uncertain": True, "error": "envoi non confirmé"})
    d = WebApiDriver(page)
    with pytest.raises(exc):
        call(d)
    assert page.page == []  # surtout pas une deuxième fois par la page


def test_refused_after_the_call_is_a_failure_not_a_page_retry():
    page = FakePage({"ok": False, "attempted": True, "error": "réaction refusée (HTTP 403)"})
    d = WebApiDriver(page)
    focus = d.react_focused(TID, REF, "like")
    assert not focus.ok and "403" in focus.reason and page.page == []
    assert d.mark_read(TID) is False and "403" in page.last_error


def test_typing_without_sending_and_files_stay_on_the_page():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    d.type_focused(TID, "brouillon", False, restore=True)  # saisie seule : la page
    d.type_focused(TID, "ci-joint", True, restore=True, files=["a.pdf"])  # pièce jointe : la page
    assert page.calls == []
    assert [p[4] for p in page.page] == [(), ("files",)]


def test_mentions_go_to_the_chat_service_with_the_names():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    assert d.type_focused(TID, "@Ana Martin tu valides ?", True, restore=True, mentions=["Ana Martin"]).ok
    assert page.calls == [("send", TID, {"text": "@Ana Martin tu valides ?", "mentions": ["Ana Martin"]})]
    assert page.page == []


def test_mention_the_service_cannot_link_falls_back_to_the_page():
    page = FakePage({"ok": False, "attempted": False, "error": "« Ana » n'est pas dans cette conversation"})
    d = WebApiDriver(page)
    d.type_focused(TID, "@Ana oui", True, restore=True, mentions=["Ana"])
    assert [p[4] for p in page.page] == [("mentions",)]


def test_quoted_reply_goes_to_the_chat_service_with_the_message_seen():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    assert d.type_focused(TID, "oui", True, restore=True, reply_to=REF).ok
    assert page.calls == [("send", TID, {"text": "oui", "reply": {"id": REF.id, "sender": "Ana Martin", "text": "Bonjour"}})]
    assert page.page == []


def test_quoted_reply_to_a_message_without_teams_id_stays_on_the_page():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    d.type_focused(TID, "oui", True, restore=True, reply_to=MessageRef(sender="Ana Martin", text="Bonjour"))
    assert page.calls == []
    assert [p[4] for p in page.page] == [("reply_to",)]


def test_quoted_reply_not_sent_by_the_service_falls_back_to_the_page_quote():
    page = FakePage({"ok": False, "attempted": False, "error": "texte différent de celui affiché"})
    d = WebApiDriver(page)
    d.type_focused(TID, "oui", True, restore=True, reply_to=REF)
    assert [p[4] for p in page.page] == [("reply_to",)]


def test_driver_without_the_chat_service_uses_the_page():
    class OnlyPage(FakePage):
        chat_gesture = None

    page = OnlyPage({})
    d = WebApiDriver(page)
    assert d.mark_read(TID) is True and d.type_focused(TID, "x", True, restore=True).ok
    assert [p[0] for p in page.page] == ["markread", "type"]


def test_bridge_gesture_resolves_the_teams_id_and_reports_no_answer_as_uncertain():
    d = WebBridgeDriver()
    # Fenêtre Teams pas prête : refusé avant la file, rien n'est parti (jamais « incertain »).
    assert d.chat_gesture("send", TID, text="x") == {
        "ok": False, "attempted": False, "error": "la fenêtre Teams de Trame n'est pas prête"}
    d.relay_connected = lambda: True
    sent = {}
    d._rpc = lambda op, **kw: sent.update(op=op, **kw) or {"ok": True}
    d.chat_aliases = {"name:Ana Martin": "19:a_b@unq.gbl.spaces"}
    assert d.chat_gesture("send", "name:Ana Martin", text="Salut")["ok"]
    assert sent["op"] == "chatgesture" and sent["thread"] == "19:a_b@unq.gbl.spaces" and sent["kind"] == "send"
    # Conversation sans id Teams : rien ne part, la page fera le geste.
    assert d.chat_gesture("send", "name:Inconnu", text="x") == {
        "ok": False, "attempted": False, "error": "conversation sans identifiant Teams"}

    def boom(op, **kw):
        raise RuntimeError("Teams intégré : pas de réponse de la page")
    d._rpc = boom
    res = d.chat_gesture("send", TID, text="x")
    assert res["uncertain"] and res["attempted"]


def test_one_to_one_linked_only_by_the_day_gets_reads_but_never_writes_by_the_service():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    d._chat.mapped = {"name:Ana Martin": "19:a_b@unq.gbl.spaces"}
    page.chat_aliases = dict(d._chat.mapped)
    # Relié au jour près seulement : l'envoi passe par la page.
    d.type_focused("name:Ana Martin", "Bonjour", True, restore=True)
    assert page.calls == [] and page.page[-1][0] == "type"
    assert "preuve suffisante" in d.routes()["send"]["reason"]
    # Relié par le texte ou la minute : le service de chat.
    d._chat.strong = {"name:Ana Martin"}
    d.type_focused("name:Ana Martin", "Bonjour", True, restore=True)
    assert [c[0] for c in page.calls] == ["send"]


def test_hide_in_teams_goes_to_the_chat_service_and_reports_failures():
    page = FakePage({"ok": True})
    d = WebApiDriver(page)
    assert d.can_hide_chat is True
    assert d.hide_chat(TID, True) is True
    assert page.calls == [("hide", TID, {"hidden": True})]
    refused = WebApiDriver(FakePage({"ok": False, "attempted": True, "error": "masquage refusé (HTTP 403)"}))
    with pytest.raises(RuntimeError, match="403"):
        refused.hide_chat(TID, True)
