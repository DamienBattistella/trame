"""Trame's own Microsoft sign-in for Graph (MSAL public client, delegated permissions).

The application is registered in the tenant by IT (see docs/teams-graph.md): Trame only
knows its client id and tenant id, no secret. The token cache is encrypted for the
Windows session (DPAPI) in Trame's data folder; elsewhere it stays in memory."""
from __future__ import annotations
import os
import threading
from pathlib import Path
from typing import Any, Callable, Optional

SCOPES = [
    "User.Read", "User.ReadBasic.All", "People.Read",
    "Chat.ReadWrite", "Chat.Create", "ChatMessage.Send",
    "Presence.Read.All", "Presence.ReadWrite",
    "Files.ReadWrite", "Calendars.Read", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All",
]
CACHE_FILE = "graph-token-cache.bin"


class NotSignedIn(RuntimeError):
    pass


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    src, out = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), Blob()
    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, 0x1, ctypes.byref(out)):  # UI_FORBIDDEN
        raise OSError("DPAPI a refusé le cache")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


class GraphAuth:
    """Sign-in state for one app registration. `app_factory` is injectable for tests."""

    def __init__(self, home: Path, client_id: str, tenant_id: str,
                 app_factory: Optional[Callable[..., Any]] = None):
        self.client_id, self.tenant_id = client_id.strip(), tenant_id.strip()
        self._path = home / CACHE_FILE
        self._lock = threading.Lock()
        self._pending: Optional[threading.Thread] = None
        self.error: Optional[str] = None
        import msal  # noqa: PLC0415 (optional dependency, only once Graph is configured)
        self._cache = msal.SerializableTokenCache()
        self._load()
        make = app_factory or msal.PublicClientApplication
        self._app = make(self.client_id, authority=f"https://login.microsoftonline.com/{self.tenant_id}",
                         token_cache=self._cache)

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.tenant_id)

    def _load(self) -> None:
        if os.name != "nt" or not self._path.exists():
            return
        try:
            self._cache.deserialize(_dpapi(self._path.read_bytes(), protect=False).decode("utf-8"))
        except Exception:
            self._path.unlink(missing_ok=True)

    def _save(self) -> None:
        if os.name != "nt" or not self._cache.has_state_changed:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_bytes(_dpapi(self._cache.serialize().encode("utf-8"), protect=True))
        tmp.replace(self._path)

    def account(self) -> Optional[dict]:
        accounts = self._app.get_accounts()
        return accounts[0] if accounts else None

    def status(self) -> dict:
        acc = self.account()
        return {"configured": self.configured, "signed_in": bool(acc),
                "account": (acc or {}).get("username"), "pending": bool(self._pending and self._pending.is_alive()),
                "error": self.error}

    def token(self) -> str:
        with self._lock:
            acc = self.account()
            if not acc:
                raise NotSignedIn("Microsoft Graph : pas connecté")
            res = self._app.acquire_token_silent(SCOPES, account=acc) or {}
            self._save()
        if "access_token" not in res:
            raise NotSignedIn("Microsoft Graph : connexion à refaire")
        return res["access_token"]

    def login(self) -> None:
        """Interactive sign-in in the user's browser (loopback redirect, PKCE), in background."""
        if self._pending and self._pending.is_alive():
            return

        def run() -> None:
            try:
                res = self._app.acquire_token_interactive(SCOPES, prompt="select_account") or {}
                with self._lock:
                    self._save()
                self.error = None if "access_token" in res else (res.get("error_description") or "connexion refusée")[:300]
            except Exception as e:
                self.error = str(e)[:300]

        self._pending = threading.Thread(target=run, daemon=True, name="graph-login")
        self._pending.start()

    def logout(self) -> None:
        with self._lock:
            for acc in self._app.get_accounts():
                self._app.remove_account(acc)
            self._path.unlink(missing_ok=True)
        self.error = None
