"""Graph step 4: meetings and transcripts, pasted images, new messages (watch, catch-up)."""
from __future__ import annotations
import base64
import json

import transcripts as tr
from drivers.graph import GraphDriver
from drivers.mock import MockTeamsDriver
from msgraph.client import BASE, GraphClient
from test_graph import ALICE, CHATS, DM, ME, FakeGraph, driver, routes

MEETING_CHAT = "19:meeting_abc@thread.v2"
VTT = ("WEBVTT\n\n0a/1-0\n00:00:01.000 --> 00:00:04.000\n<v Alice Martin>Bonjour à tous</v>\n\n"
       "0a/2-0\n00:00:05.500 --> 00:00:07.000\n<v Moi>On commence</v>\n")
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + (320).to_bytes(4, "big") + (200).to_bytes(4, "big") + b"rest"


class MeetingGraph(FakeGraph):
    def __init__(self, transcripts_status=200):
        super().__init__({("GET", "/me"): {"id": ME}})
        self.transcripts_status = transcripts_status

    def __call__(self, method, url, headers, body):
        path = url[len(BASE):].split("?")[0]
        answers = {
            "/me/chats": {"value": [{"id": MEETING_CHAT, "topic": "Point hebdo",
                                     "onlineMeetingInfo": {"joinWebUrl": "https://teams.microsoft.com/l/meetup-join/x"}}]},
            "/me/onlineMeetings": {"value": [{"id": "MSpLONG==", "subject": "Point hebdo"}]},
            "/me/onlineMeetings/MSpLONG==/transcripts": {"value": [
                {"id": "T1==", "createdDateTime": "2026-11-24T10:00:00Z", "endDateTime": "2026-11-24T10:45:00Z"}]},
        }
        if method == "GET" and path == "/me/onlineMeetings/MSpLONG==/transcripts/T1==/content":
            self.calls.append((method, path, None))
            assert headers["Accept"] == "text/vtt"
            return 200, {}, VTT.encode()
        if method == "GET" and path in answers:
            self.calls.append((method, path, None))
            if path.endswith("/transcripts") and self.transcripts_status != 200:
                return self.transcripts_status, {}, b'{"error": {"code": "Forbidden"}}'
            return 200, {}, json.dumps(answers[path]).encode()
        return super().__call__(method, url, headers, body)


def test_meetings_and_their_transcript_through_graph():
    d, _page = driver(MeetingGraph())
    [m] = d.list_meetings()
    assert (m["thread_id"], m["title"], m["transcript"]) == (MEETING_CHAT, "Point hebdo", True)
    assert m["mid"].startswith("g") and len(m["mid"]) == 21
    assert tr.split_meeting_id(tr.meeting_id(m["thread_id"], m["mid"])) == (MEETING_CHAT, m["mid"])
    assert tr.parse_meeting_date(m["when"]).isoformat() == "2026-11-24"
    res = d.meeting_transcript(MEETING_CHAT, m["mid"])
    assert res["ok"] and res["title"] == "Point hebdo"
    cues = tr.cues_from_entries(res["entries"])
    assert [(c.speaker, c.text, c.start) for c in cues] == [("Alice Martin", "Bonjour à tous", 1.0),
                                                            ("Moi", "On commence", 5.0)]
    vtt = tr.build_vtt(cues, title=res["title"])
    assert len(tr.parse_vtt(vtt)) == 2
    assert d.routes()["meetings"]["via"] == "graph" and d.routes()["transcript"]["via"] == "graph"


def test_transcript_found_again_after_a_restart():
    d, _page = driver(MeetingGraph())
    [m] = d.list_meetings()
    fresh, _ = driver(MeetingGraph())  # new engine: no alias in memory yet
    assert fresh.meeting_transcript(MEETING_CHAT, m["mid"])["ok"]


def test_meetings_refused_by_graph_are_listed_by_the_page():
    d, page = driver(MeetingGraph(transcripts_status=403))
    page.list_meetings = lambda limit=None: [{"mid": "page1"}]
    assert d.list_meetings() == [{"mid": "page1"}]
    assert d.routes()["meetings"]["via"] == "page"


def test_page_meeting_ids_stay_with_the_page():
    d, page = driver(MeetingGraph())
    page.meeting_transcript = lambda t, mid, probe=False: {"ok": True, "entries": [], "from": "page"}
    assert d.meeting_transcript(MEETING_CHAT, "abc123")["from"] == "page"


def test_pasted_image_is_fetched_as_png_data():
    msgs = {"value": [{"id": "5", "messageType": "message", "createdDateTime": "2026-11-26T09:00:00Z",
                       "from": {"user": {"id": ALICE, "displayName": "Alice Martin"}},
                       "body": {"contentType": "html", "content":
                                f'<p><img src="{BASE}/chats/{DM}/messages/5/hostedContents/aW1n/$value"></p>'}}]}
    fake = routes({("GET", f"/chats/{DM}/messages"): msgs})

    def with_image(method, url, headers, body):
        if url.endswith("/hostedContents/aW1n/$value"):
            assert headers["Accept"] == "image/*"
            return 200, {}, PNG
        return fake(method, url, headers, body)

    client = GraphClient(lambda: "t0k3n", with_image)
    d = GraphDriver(MockTeamsDriver(interval=9999), lambda: client)
    [m] = d.read_context(DM, 5)
    assert m.text == "" and m.sender == "Alice Martin"
    [img] = m.images
    assert img.data == "data:image/png;base64," + base64.b64encode(PNG).decode()
    assert (img.width, img.height) == (320, 200)


class WatchGraph(FakeGraph):
    """A chat whose last message moves between ticks."""

    def __init__(self):
        super().__init__({("GET", "/me"): {"id": ME}, ("POST", "/communications/getPresencesByUserId"): {"value": []}})
        self.last = ("100", ALICE)
        self.messages = [self._msg("100", ALICE, "ancien")]

    @staticmethod
    def _msg(mid, who, text):
        return {"id": mid, "messageType": "message", "createdDateTime": "2026-11-26T09:05:00Z",
                "from": {"user": {"id": who, "displayName": "Alice Martin" if who == ALICE else "Moi"}},
                "body": {"contentType": "text", "content": text}}

    def say(self, mid, who, text):
        self.messages.insert(0, self._msg(mid, who, text))
        self.last = (mid, who)

    def __call__(self, method, url, headers, body):
        path = url[len(BASE):].split("?")[0]
        if (method, path) == ("GET", "/me/chats"):
            preview = {"id": self.last[0], "createdDateTime": "2026-11-26T09:05:00Z",
                       "from": {"user": {"id": self.last[1]}}, "body": {"contentType": "text", "content": "x"}}
            return 200, {}, json.dumps({"value": [{**CHATS["value"][0], "lastMessagePreview": preview}]}).encode()
        if (method, path) == ("GET", f"/chats/{DM}/messages"):
            return 200, {}, json.dumps({"value": self.messages}).encode()
        return super().__call__(method, url, headers, body)


def test_watch_reports_only_new_messages_from_others():
    fake = WatchGraph()
    d, _page = driver(fake)
    client, seen, got = d._client(), {}, []
    d._watch_tick(client, seen, "2026-11-26T08:00:00", got.append)
    assert got == []  # first look: where each chat stands
    fake.say("101", ALICE, "Tu es dispo ?")
    fake.say("102", ALICE, "C'est urgent")
    d._watch_tick(client, seen, "2026-11-26T08:00:00", got.append)
    assert [m.text for m in got] == ["Tu es dispo ?", "C'est urgent"]
    fake.say("103", ME, "J'arrive")
    d._watch_tick(client, seen, "2026-11-26T08:00:00", got.append)
    d._watch_tick(client, seen, "2026-11-26T08:00:00", got.append)
    assert len(got) == 2  # my own message is not news, and nothing is reported twice


def test_watch_uses_the_page_tick_without_graph():
    page = MockTeamsDriver(interval=9999)
    ticks = []
    page.watch_tick = lambda on_message: ticks.append(1)
    page.POLL_SECONDS = 0.0
    d = GraphDriver(page, lambda: None)
    stops = iter([False, False, True])
    d.watch(lambda m: None, lambda: next(stops))
    assert ticks == [1, 1] and d.routes()["watch"]["via"] == "page"


def test_unread_catch_up_reads_the_last_message():
    d, _page = driver(routes())
    assert [(m.thread_id, m.sender) for m in d.list_unread()] == [(DM, "Alice Martin")]


def test_meeting_chat_gets_its_join_link_from_graph():
    url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"
    fake = routes({("GET", f"/chats/{MEETING_CHAT}/messages"): {"value": []},
                   ("GET", f"/chats/{MEETING_CHAT}"): {"onlineMeetingInfo": {"joinWebUrl": url}}})
    d, _page = driver(fake)
    d.read_context(MEETING_CHAT, 5)
    assert d.meeting(MEETING_CHAT) == {"url": url, "live": False}
