"""Graph step 5: sending files (OneDrive upload, shared with the chat, reference attachment)."""
from __future__ import annotations
import json

import pytest

from attachments import Attachment
from drivers.base import SendUncertain
from msgraph.client import BASE
from test_graph import ALICE, DM, ME, FakeGraph, driver

GUID = "6a1f0c2e-1b2c-4d5e-8f90-123456789abc"
FILE = Attachment(name="compte rendu.pdf", mime="application/pdf", data=b"%PDF-1.4 demo")


class FileGraph(FakeGraph):
    def __init__(self, emails=True, show_file=True):
        super().__init__({("GET", "/me"): {"id": ME}, ("GET", "/me/chats"): {"value": []}})
        self.emails, self.show_file = emails, show_file
        self.uploads, self.invites, self.posted = [], [], []

    def __call__(self, method, url, headers, body):
        path = urlpath = url[len(BASE):].split("?")[0]
        if (method, path) == ("GET", f"/chats/{DM}/members"):
            members = [{"userId": ME, "displayName": "Moi", "email": "moi@exemple.fr"},
                       {"userId": ALICE, "displayName": "Alice Martin", "email": "alice@exemple.fr" if self.emails else ""}]
            return 200, {}, json.dumps({"value": members}).encode()
        if method == "PUT" and urlpath.startswith("/me/drive/root:/Microsoft Teams Chat Files/"):
            assert "conflictBehavior=rename" in url and headers["Content-Type"] == "application/pdf"
            self.uploads.append((urlpath, body))
            return 201, {}, json.dumps({"id": "ITEM1", "name": "compte rendu.pdf", "eTag": f'"{{{GUID.upper()}}},1"',
                                        "webUrl": "https://contoso-my.sharepoint.com/personal/moi/Documents/cr.pdf"}).encode()
        if (method, path) == ("POST", "/me/drive/items/ITEM1/invite"):
            self.invites.append(json.loads(body))
            return 200, {}, b'{"value": []}'
        if (method, path) == ("POST", f"/chats/{DM}/messages"):
            self.posted.append(json.loads(body))
            return 201, {}, b'{"id": "77"}'
        if (method, path) == ("GET", f"/chats/{DM}/messages/77"):
            sent = self.posted[-1]
            shown = {"id": "77", "body": sent["body"],
                     "attachments": sent.get("attachments", []) if self.show_file else []}
            return 200, {}, json.dumps(shown).encode()
        return super().__call__(method, url, headers, body)


def test_file_is_uploaded_shared_with_the_chat_and_sent():
    fake = FileGraph()
    d, _page = driver(fake)
    d.inner.type_focused = lambda *a, **k: pytest.fail("envoyé aussi par la page")
    assert d.type_focused(DM, "Voici le CR", send=True, restore=True, files=[FILE]).ok
    [(path, data)] = fake.uploads
    assert path == "/me/drive/root:/Microsoft Teams Chat Files/compte%20rendu.pdf:/content" and data == FILE.data
    assert fake.invites == [{"recipients": [{"email": "alice@exemple.fr"}], "roles": ["read"],
                             "requireSignIn": True, "sendInvitation": False}]
    [sent] = fake.posted
    assert sent["attachments"] == [{"id": GUID, "contentType": "reference", "name": "compte rendu.pdf",
                                    "contentUrl": "https://contoso-my.sharepoint.com/personal/moi/Documents/cr.pdf"}]
    assert sent["body"]["content"] == f'Voici le CR<attachment id="{GUID}"></attachment>'
    assert d.routes()["send"]["via"] == "graph"


def test_file_alone_without_text():
    fake = FileGraph()
    d, _page = driver(fake)
    assert d.type_focused(DM, "", send=True, restore=True, files=[FILE]).ok
    assert fake.posted[0]["body"]["content"] == f'<attachment id="{GUID}"></attachment>'


def test_member_without_address_leaves_the_file_to_the_page_before_any_upload():
    fake = FileGraph(emails=False)
    d, _page = driver(fake)
    d.inner.type_focused = lambda *a, **k: "page"
    assert d.type_focused(DM, "Voici", send=True, restore=True, files=[FILE]) == "page"
    assert fake.uploads == [] and fake.posted == []


def test_file_missing_from_the_sent_message_is_uncertain():
    d, _page = driver(FileGraph(show_file=False))
    d.inner.type_focused = lambda *a, **k: pytest.fail("renvoyé par la page")
    with pytest.raises(SendUncertain, match="pièce jointe non visible"):
        d.type_focused(DM, "Voici", send=True, restore=True, files=[FILE])


def test_file_with_a_mention_stays_on_the_page():
    fake = FileGraph()
    d, _page = driver(fake)
    d.inner.type_focused = lambda *a, **k: "page"
    assert d.type_focused(DM, "@Alice Martin voici", send=True, restore=True, files=[FILE],
                          mentions=["Alice Martin"]) == "page"
    assert fake.uploads == []
