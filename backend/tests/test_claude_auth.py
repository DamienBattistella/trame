from __future__ import annotations
import io
import json
import subprocess

from conftest import offline_claude
from brain.auth import parse_status

LOGGED = json.dumps({"loggedIn": True, "authMethod": "claude.ai", "email": "moi@exemple.fr", "subscriptionType": "max"})
OUT = json.dumps({"loggedIn": False})


def _run(stdout):
    return lambda cmd, timeout: subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")


class FakeProc:
    def __init__(self, lines):
        self.stdout = io.StringIO("".join(lines))
        self.killed = False
        self._rc = None

    def poll(self):
        return self._rc

    def kill(self):
        self.killed = True
        self._rc = -9

    def wait(self, timeout=None):
        return self._rc


def test_parse_status():
    assert parse_status(LOGGED) == (True, "moi@exemple.fr", "Max")
    assert parse_status(OUT) == (False, None, None)
    assert parse_status("pas du json") == (False, None, None)


def test_status_routes(make_client):
    client, _w, _d = make_client()
    assert client.get("/api/brain/claude/status").json()["claude"]["installed"] is False
    client, _w, _d = make_client(claude_auth=offline_claude(which=lambda _n: "/usr/bin/claude", run=_run(LOGGED)))
    c = client.get("/api/brain/claude/status").json()["claude"]
    assert c["logged_in"] and c["account"] == "moi@exemple.fr" and c["plan"] == "Max"


def test_login_returns_browser_url_and_can_cancel(make_client):
    proc = FakeProc(["Opening browser to sign in…\n", "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=abc\n"])
    auth = offline_claude(which=lambda _n: "/usr/bin/claude", run=_run(OUT), spawn=lambda cmd: proc)
    client, _w, _d = make_client(claude_auth=auth)
    r = client.post("/api/brain/claude/login").json()
    assert r["ok"] and r["login_url"] == "https://claude.ai/oauth/authorize?code=abc"
    assert client.get("/api/brain/claude/status").json()["claude"]["login_pending"] is True
    assert client.post("/api/brain/claude/login/cancel").json() == {"ok": True} and proc.killed


def test_login_refused_when_missing_or_already_connected(make_client):
    client, _w, _d = make_client()
    assert client.post("/api/brain/claude/login").status_code == 409
    client, _w, _d = make_client(claude_auth=offline_claude(which=lambda _n: "/usr/bin/claude", run=_run(LOGGED)))
    r = client.post("/api/brain/claude/login")
    assert r.status_code == 409 and "déjà connecté" in r.json()["error"]
