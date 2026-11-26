from __future__ import annotations
import os
import re
import shutil
import subprocess
import threading
from typing import Callable, Optional

from pydantic import BaseModel, Field

from github import context as ghctx
from winproc import _creationflags
from watcher import ActionError

HOST = "github.com"
DEFAULT_VERIFICATION_URL = "https://github.com/login/device"
LOGIN_CMD = ["auth", "login", "--hostname", HOST, "--git-protocol", "https", "--web", "--skip-ssh-key"]
STATUS_CMD = ["auth", "status", "--hostname", HOST]

_ACCOUNT_RE = re.compile(
    r"(?P<state>Logged in|Failed to log in|Timeout trying to log in) to (?P<host>\S+?)"
    r" (?:account|as) (?P<account>[^\s()]+)",
    re.IGNORECASE,
)
_ACTIVE_RE = re.compile(r"Active account:\s*(true|false)", re.IGNORECASE)
_SCOPES_RE = re.compile(r"Token scopes:\s*(.*)$", re.IGNORECASE)
_CODE_RE = re.compile(r"one[- ]?time\s+code\W*([A-Z0-9]{4}-[A-Z0-9]{4})", re.IGNORECASE)
_LOOSE_CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b")
_URL_RE = re.compile(r"https://\S+/login/device\b")


class GithubStatus(BaseModel):
    installed: bool
    logged_in: bool = False
    account: Optional[str] = None
    scopes: list[str] = Field(default_factory=list)
    sso_blocked: list[str] = Field(default_factory=list)
    login_pending: bool = False
    # Outcome of the last sign-in once gh has exited: "ok", "failed" (with login_error) or None.
    login_result: Optional[str] = None
    login_error: Optional[str] = None


def parse_scopes(raw: str) -> list[str]:
    raw = raw.strip()
    if not raw or raw.lower() in ("none", "(none)"):
        return []
    return [s.strip().strip("'\"") for s in raw.split(",") if s.strip().strip("'\"")]


def parse_auth_status(text: str, host: str = HOST) -> tuple[bool, Optional[str], list[str]]:
    """Parse `gh auth status` output (old "as X" and new multi-account "account X" formats)
    into (logged_in, account, scopes) for the active account of `host`."""
    blocks: list[dict] = []
    current: Optional[dict] = None
    for line in (text or "").splitlines():
        m = _ACCOUNT_RE.search(line.strip())
        if m:
            current = None
            if m.group("host").lower() == host.lower():
                current = {
                    "ok": m.group("state").lower() == "logged in",
                    "account": m.group("account"),
                    "active": None,
                    "scopes": [],
                }
                blocks.append(current)
            continue
        if current is None:
            continue
        active = _ACTIVE_RE.search(line)
        if active:
            current["active"] = active.group(1).lower() == "true"
            continue
        scopes = _SCOPES_RE.search(line)
        if scopes:
            current["scopes"] = parse_scopes(scopes.group(1))
    if not blocks:
        return False, None, []
    chosen = next((b for b in blocks if b["active"]), None)
    if chosen is None:
        chosen = next((b for b in blocks if b["ok"] and b["active"] is not False), blocks[0])
    if not chosen["ok"]:
        return False, None, []
    return True, chosen["account"], chosen["scopes"]


def parse_device_code(line: str) -> Optional[str]:
    m = _CODE_RE.search(line)
    if m:
        return m.group(1).upper()
    if "code" in line.lower():
        loose = _LOOSE_CODE_RE.search(line)
        if loose:
            return loose.group(1).upper()
    return None


def _env() -> dict:
    # GH_PROMPT_DISABLED only turns off interactive prompts; `--web` is the
    # non-interactive login path, so the device flow still runs. The "Press Enter
    # to open the browser" step reads stdin directly, hence the newline we feed.
    env = dict(os.environ)
    env.update({"GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1", "NO_COLOR": "1"})
    return env




def default_run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=_env(),
                          stdin=subprocess.DEVNULL, creationflags=_creationflags())


def default_spawn(cmd: list[str]) -> subprocess.Popen:
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1, env=_env(), creationflags=_creationflags())


class GithubAuth:
    """GitHub sign-in through the local `gh` CLI. Trame never reads the token: gh keeps
    it in its own credential store. The process launchers are injectable for tests."""

    STATUS_TIMEOUT = 10.0
    LOGIN_TIMEOUT = 10.0

    def __init__(
        self,
        which: Callable[[str], Optional[str]] = shutil.which,
        run: Callable[[list[str], float], subprocess.CompletedProcess] = default_run,
        spawn: Callable[[list[str]], subprocess.Popen] = default_spawn,
    ):
        self.which = which
        self.run = run
        self.spawn = spawn
        self._lock = threading.Lock()
        self._proc = None
        self._code: Optional[str] = None
        self._url = DEFAULT_VERIFICATION_URL
        self._output: list[str] = []
        self._code_found = threading.Event()
        self._last_result: Optional[str] = None
        self._last_error: Optional[str] = None

    def _gh(self) -> Optional[str]:
        return self.which("gh")

    def _pending(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def status(self) -> GithubStatus:
        gh = self._gh()
        with self._lock:
            pending = self._pending()
            result, error = self._last_result, self._last_error
        if not gh:
            return GithubStatus(installed=False, sso_blocked=ghctx.sso_blocked(), login_pending=pending)
        logged_in, account, scopes = self._auth_status(gh)
        return GithubStatus(installed=True, logged_in=logged_in, account=account, scopes=scopes,
                            sso_blocked=ghctx.sso_blocked(), login_pending=pending,
                            login_result=None if pending else result, login_error=None if pending else error)

    def _auth_status(self, gh: str) -> tuple[bool, Optional[str], list[str]]:
        try:
            proc = self.run([gh, *STATUS_CMD], self.STATUS_TIMEOUT)
        except Exception:
            return False, None, []
        return parse_auth_status(f"{proc.stdout or ''}\n{proc.stderr or ''}")

    def login(self) -> dict:
        gh = self._gh()
        if not gh:
            raise ActionError(409, "La commande gh n'est pas installée sur ce poste.")
        with self._lock:
            if self._pending():
                if self._code:
                    return self._result()
                raise ActionError(409, "Une connexion GitHub est déjà en cours.")
            logged_in, account, _scopes = self._auth_status(gh)
            if logged_in:
                raise ActionError(409, f"Déjà connecté à GitHub en tant que {account}.")
            self._code, self._url, self._output = None, DEFAULT_VERIFICATION_URL, []
            self._last_result, self._last_error = None, None
            self._code_found = threading.Event()
            try:
                proc = self.spawn([gh, *LOGIN_CMD])
            except Exception as e:
                raise ActionError(502, f"Impossible de lancer gh pour la connexion GitHub : {e}")
            self._proc = proc
            try:
                proc.stdin.write("\n")
                proc.stdin.flush()
                proc.stdin.close()
            except Exception:
                pass
            threading.Thread(target=self._drain, args=(proc, self._code_found), daemon=True).start()
            found = self._code_found
        found.wait(self.LOGIN_TIMEOUT)
        with self._lock:
            if self._proc is proc and self._code:
                return self._result()
            last = next((line for line in reversed(self._output) if line.strip()), "")
            self._kill(proc)
            if self._proc is proc:
                self._proc = None
        detail = f" ({last.strip()[:160]})" if last else ""
        raise ActionError(502, f"GitHub n'a pas fourni de code de connexion à temps : connexion annulée{detail}.")

    def _result(self) -> dict:
        return {"code": self._code, "verification_url": self._url}

    def _drain(self, proc, found: threading.Event) -> None:
        """Read gh's output until it exits; the one-time code unblocks login()."""
        try:
            for line in iter(proc.stdout.readline, ""):
                with self._lock:
                    if self._proc is not proc:
                        continue
                    self._output = (self._output + [line])[-50:]
                    url = _URL_RE.search(line)
                    if url:
                        self._url = url.group(0)
                    code = None if self._code else parse_device_code(line)
                    if code:
                        self._code = code
                if code:
                    found.set()
        except Exception:
            pass
        finally:
            try:
                code = proc.wait(timeout=30)
            except Exception:
                code = None
            with self._lock:
                if self._proc is proc and code is not None:
                    self._last_result = "ok" if code == 0 else "failed"
                    last = next((x.strip() for x in reversed(self._output) if x.strip()), "")
                    self._last_error = None if code == 0 else (last[:200] or f"gh a quitté avec le code {code}.")
            found.set()

    def cancel(self) -> None:
        with self._lock:
            proc, self._proc, self._code = self._proc, None, None
        if proc is not None:
            self._kill(proc)

    @staticmethod
    def _kill(proc) -> None:
        try:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
        except Exception:
            pass
