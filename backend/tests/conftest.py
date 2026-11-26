from __future__ import annotations
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))
os.environ["TRAME_HOME"] = tempfile.mkdtemp(prefix="trame-test-")
os.environ["TRAME_DRIVER"] = "mock"
os.environ["TRAME_MOCK_INTERVAL"] = "9999"

import config as cfgmod  # noqa: E402
from brain.base import Brain  # noqa: E402
from drivers.mock import MockTeamsDriver  # noqa: E402
from github import context as gh  # noqa: E402
from github.auth import GithubAuth  # noqa: E402


class FakeBrain(Brain):
    def __init__(self, name: str = "claude", reply: str = "Réponse de test", completion: str = ""):
        self.name = name
        self.reply = reply
        self.completion = completion
        self.calls: list[str] = []
        self.prompts: list[str] = []
        self.people: list[str] = []

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "", people_context: str = "") -> str:
        self.calls.append(incoming)
        self.people.append(people_context)
        return self.reply

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        self.prompts.append(prompt)
        if isinstance(self.completion, Exception):
            raise self.completion
        return self.completion


def fake_factory(cfg: dict) -> FakeBrain:
    return FakeBrain(name=cfg.get("brain", {}).get("provider", "claude"))


def _no_process(*_args, **_kwargs):
    raise AssertionError("aucun vrai processus gh dans les tests")


def offline_auth(**kwargs) -> GithubAuth:
    """GithubAuth that can never start a real gh process (gh absent unless overridden)."""
    return GithubAuth(**{"which": lambda _name: None, "run": _no_process, "spawn": _no_process, **kwargs})


def offline_claude(**kwargs):
    """ClaudeAuth that can never start a real claude process (absent unless overridden)."""
    from brain.auth import ClaudeAuth
    return ClaudeAuth(**{"which": lambda _name: None, "run": _no_process, "spawn": _no_process, **kwargs})


class RefusingDriver(MockTeamsDriver):
    def open_thread(self, thread_id: str) -> bool:
        return False


@pytest.fixture(autouse=True)
def fresh_home(monkeypatch):
    home = Path(os.environ["TRAME_HOME"])
    assert home != REPO and cfgmod.HOME == home
    cfg = json.loads((REPO / "config.json").read_text(encoding="utf-8"))
    cfg["reply"]["auto_send_countdown_seconds"] = 0
    (home / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    shutil.copyfile(REPO / "SOUL.md", home / "SOUL.md")
    monkeypatch.setattr(gh, "_gh", lambda args, timeout=20: "")
    monkeypatch.setattr(gh, "_run", _no_process)
    gh._sso_blocked.clear()
    monkeypatch.setattr(gh, "_repos_cache", None)
    yield home
    gh._sso_blocked.clear()


@pytest.fixture
def make_client():
    from fastapi.testclient import TestClient
    from app import create_app

    clients = []

    def _make(driver=None, brain=None, github_auth=None, claude_auth=None):
        driver = driver or MockTeamsDriver(interval=9999)
        app = create_app(driver=driver, brain=brain or FakeBrain(), brain_factory=fake_factory,
                         github_auth=github_auth or offline_auth(),
                         claude_auth=claude_auth or offline_claude())
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client, app.state.watcher, driver

    yield _make
    for c in clients:
        c.__exit__(None, None, None)
