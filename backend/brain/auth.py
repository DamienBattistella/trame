from __future__ import annotations
import json
import re
import shutil
import subprocess
import threading
from typing import Callable, Optional

from pydantic import BaseModel

from winproc import _creationflags
from watcher import ActionError

STATUS_CMD = ["auth", "status", "--json"]
LOGIN_CMD = ["auth", "login", "--claudeai"]
_URL_RE = re.compile(r"https://\S+")
_PLANS = {"max": "Max", "pro": "Pro", "team": "Team", "enterprise": "Enterprise"}


class ClaudeStatus(BaseModel):
    installed: bool
    logged_in: bool = False
    account: Optional[str] = None
    plan: Optional[str] = None
    login_pending: bool = False
    login_url: Optional[str] = None


def parse_status(text: str) -> tuple[bool, Optional[str], Optional[str]]:
    """`claude auth status --json` → (logged_in, email, plan label)."""
    try:
        data = json.loads(text or "{}")
    except ValueError:
        return False, None, None
    if not isinstance(data, dict) or not data.get("loggedIn"):
        return False, None, None
    sub = str(data.get("subscriptionType") or "").lower()
    plan = _PLANS.get(sub) or ("API" if data.get("authMethod") not in (None, "claude.ai") else None)
    return True, data.get("email") or None, plan


def default_run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          stdin=subprocess.DEVNULL, creationflags=_creationflags())


def default_spawn(cmd: list[str]) -> subprocess.Popen:
    return subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=_creationflags())


class ClaudeAuth:
    """Sign-in of the local Claude Code CLI (`claude auth login`, browser OAuth on the
    user's own subscription). Trame never sees the credentials: claude keeps them."""

    STATUS_TIMEOUT = 15.0
    URL_WAIT = 8.0

    def __init__(
        self,
        which: Callable[[str], Optional[str]] = shutil.which,
        run: Callable[[list[str], float], subprocess.CompletedProcess] = default_run,
        spawn: Callable[[list[str]], subprocess.Popen] = default_spawn,
    ):
        self.which, self.run, self.spawn = which, run, spawn
        self._lock = threading.Lock()
        self._proc = None
        self._url: Optional[str] = None

    def _claude(self) -> Optional[str]:
        return self.which("claude")

    def _pending(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _status(self, claude: str) -> tuple[bool, Optional[str], Optional[str]]:
        try:
            proc = self.run([claude, *STATUS_CMD], self.STATUS_TIMEOUT)
        except Exception:
            return False, None, None
        return parse_status(proc.stdout)

    def status(self) -> ClaudeStatus:
        claude = self._claude()
        with self._lock:
            pending, url = self._pending(), self._url
        if not claude:
            return ClaudeStatus(installed=False)
        logged_in, account, plan = self._status(claude)
        if logged_in and pending:
            self.cancel()
            pending, url = False, None
        return ClaudeStatus(installed=True, logged_in=logged_in, account=account, plan=plan,
                            login_pending=pending, login_url=url if pending else None)

    def login(self) -> dict:
        claude = self._claude()
        if not claude:
            raise ActionError(409, "Claude Code (commande claude) n'est pas installé sur ce poste.")
        with self._lock:
            if self._pending():
                return {"login_url": self._url}
        logged_in, account, _plan = self._status(claude)
        if logged_in:
            raise ActionError(409, f"Claude est déjà connecté ({account or 'compte actif'}).")
        found = threading.Event()
        with self._lock:
            self._url = None
            try:
                proc = self.spawn([claude, *LOGIN_CMD])
            except Exception as e:
                raise ActionError(502, f"Impossible de lancer la connexion Claude : {e}")
            self._proc = proc
        threading.Thread(target=self._drain, args=(proc, found), daemon=True).start()
        # claude opens the browser itself; the URL is kept as a fallback link.
        found.wait(self.URL_WAIT)
        with self._lock:
            if self._proc is proc and proc.poll() not in (None, 0) and not self._url:
                self._proc = None
                raise ActionError(502, "La connexion Claude s'est arrêtée avant d'ouvrir le navigateur.")
            return {"login_url": self._url}

    def _drain(self, proc, found: threading.Event) -> None:
        try:
            for line in iter(proc.stdout.readline, ""):
                m = _URL_RE.search(line)
                if m:
                    with self._lock:
                        if self._proc is proc and not self._url:
                            self._url = m.group(0).rstrip(").,")
                    found.set()
        except Exception:
            pass
        finally:
            found.set()

    def cancel(self) -> None:
        with self._lock:
            proc, self._proc, self._url = self._proc, None, None
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
            except Exception:
                pass
