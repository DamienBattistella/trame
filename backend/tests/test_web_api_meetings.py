"""WebApiDriver : réunions terminées lues sur le service de chat (rien d'ouvert dans la page),
même `mid` que la carte de la page ; la page reprend si le service refuse."""
from __future__ import annotations

from drivers.web_api import WebApiDriver
from drivers.web_bridge import WebBridgeDriver

MEET = "19:meeting_YTM1abc@thread.v2"


class FakePage:
    def __init__(self, fail=None):
        self.fail = fail
        self.asked: list = []
        self.page: list = []

    def chat_list(self, sync=""):
        return {"full": True, "sync": "S", "me": "8:orgid:me", "rows": [
            {"id": MEET, "kind": "meeting", "topic": "Point hebdo", "last": {"id": "2", "ts": 2000}},
            {"id": "19:grp@thread.v2", "kind": "group", "topic": "Projet X", "last": {"id": "9", "ts": 9000}},
        ]}

    def meetings_api(self, threads, topics=None):
        self.asked.append(list(threads))
        self.topics = dict(topics or {})
        if self.fail:
            raise WebBridgeDriver.ApiError(self.fail)
        return [{"thread": MEET, "recaps": [{"mid": "1700000000999", "when": "vendredi 27 novembre 2026 11:00 - 11:20",
                                             "transcript": True}]}]

    def list_meetings(self, limit=None):
        self.page.append(limit)
        return []


def test_meetings_are_read_on_the_service_with_the_page_ids():
    page = FakePage()
    d = WebApiDriver(page)
    got = d.list_meetings()
    assert page.asked == [[MEET]] and page.page == []
    assert page.topics == {MEET: "Point hebdo"}
    assert got == [{"thread_id": "title-" + MEET, "chat": "Point hebdo", "mid": "1700000000999",
                    "title": "Point hebdo", "when": "vendredi 27 novembre 2026 11:00 - 11:20", "transcript": True}]
    assert d.routes()["meetings"]["via"] == "api"


def test_meetings_fall_back_to_the_page_when_the_service_refuses():
    page = FakePage(fail="fil refusé")
    d = WebApiDriver(page)
    d.list_meetings()
    assert page.page == [None] and d.routes()["meetings"]["via"] == "page"


# --- Toutes les sortes de réunion : conversation de réunion, groupe, tête-à-tête ---------------
GROUP = "19:grpcall@thread.v2"
DM = "19:aaaa_bbbb@unq.gbl.spaces"


class AllKindsPage(FakePage):
    """Une conversation de réunion, un groupe nommé et un tête-à-tête actifs, avec chacun un appel
    transcrit ; plus un groupe sans nom et une conversation masquée, jamais relus."""

    def __init__(self, fail=None):
        super().__init__(fail)
        self._names: dict = {}
        self._kinds: dict = {}
        self.opened: list = []

    def chat_list(self, sync=""):
        import time as _t
        now = int(_t.time() * 1000)
        return {"full": True, "sync": "S", "me": "8:orgid:me", "rows": [
            {"id": MEET, "kind": "meeting", "topic": "Point hebdo", "last": {"id": "2", "ts": now - 3000}},
            {"id": GROUP, "kind": "group", "topic": "Projet X", "last": {"id": "9", "ts": now - 1000}},
            {"id": DM, "kind": "dm", "name": "Ana Martin", "topic": "", "last": {"id": "8", "ts": now - 2000}},
            {"id": "19:anon@thread.v2", "kind": "group", "topic": "", "last": {"id": "7", "ts": now}},
            {"id": "19:cache@thread.v2", "kind": "group", "topic": "Masqué", "hidden": True, "last": {"id": "6", "ts": now}},
        ]}

    def meetings_api(self, threads, topics=None):
        self.asked.append(list(threads))
        self.topics = dict(topics or {})
        rec = lambda mid: [{"mid": mid, "when": "vendredi 27 novembre 2026 11:00 - 11:20", "transcript": True}]
        return [{"thread": MEET, "recaps": rec("1")}, {"thread": GROUP, "recaps": rec("2")},
                {"thread": DM, "recaps": rec("3")}]

    @staticmethod
    def chat_id(thread_id):
        return WebBridgeDriver.chat_id(thread_id)

    def meeting_transcript(self, thread_id, mid, probe=False):
        self.opened.append((thread_id, self._names.get(thread_id)))
        return {"ok": True, "entries": []}


def test_meetings_of_every_kind_are_listed_with_ids_the_page_can_open():
    page = AllKindsPage()
    d = WebApiDriver(page)
    got = d.list_meetings()
    # Les conversations de réunion d'abord, puis groupes et tête-à-tête récents.
    assert page.asked == [[MEET, GROUP, DM]]
    # Un tête-à-tête n'a pas de sujet à chercher dans l'agenda.
    assert page.topics == {MEET: "Point hebdo", GROUP: "Projet X", DM: ""}
    by_mid = {m["mid"]: m for m in got}
    assert by_mid["1"]["thread_id"] == "title-" + MEET and by_mid["1"]["title"] == "Point hebdo"
    assert by_mid["2"]["thread_id"] == "title-" + GROUP and by_mid["2"]["title"] == "Projet X"
    assert by_mid["3"]["thread_id"] == "name:Ana Martin" and by_mid["3"]["title"] == "Ana Martin"
    # Le nom est retenu : la page ouvre la conversation par son nom pour lire la transcription.
    assert page._names["title-" + GROUP] == "Projet X" and page._names["title-" + MEET] == "Point hebdo"


def test_call_chats_are_capped_and_recent_only(monkeypatch):
    page = AllKindsPage()
    d = WebApiDriver(page)
    monkeypatch.setattr(WebApiDriver, "MAX_CALL_CHATS", 1)
    d.list_meetings()
    assert page.asked == [[MEET, GROUP]]


def test_transcript_of_a_kept_meeting_opens_its_chat_by_name_after_a_restart():
    page = AllKindsPage()
    d = WebApiDriver(page)
    # Moteur redémarré : la réunion vient de la liste gardée sur le poste, aucun nom connu.
    d.meeting_transcript("title-" + GROUP, "2")
    d.meeting_transcript("title-" + MEET, "1")
    assert page.opened == [("title-" + GROUP, "Projet X"), ("title-" + MEET, "Point hebdo")]


def test_a_known_name_is_never_replaced():
    page = AllKindsPage()
    page._names["title-" + GROUP] = "Nom de la page"
    d = WebApiDriver(page)
    d.list_meetings()
    d.meeting_transcript("title-" + GROUP, "2")
    assert page.opened == [("title-" + GROUP, "Nom de la page")]
