"""Graph state for the engine: the app registration from config.json (`graph.client_id`,
`graph.tenant_id`, given by IT) and Trame's own sign-in. No registration, no Graph:
every action stays on the Teams page."""
from __future__ import annotations
import re
import threading
from typing import Optional

import config as cfgmod
from msgraph.client import GraphClient

GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


class GraphService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._auth = None
        self._key: tuple[str, str] = ("", "")
        self._failed: Optional[tuple[str, str]] = None
        self.error: Optional[str] = None

    @staticmethod
    def _registration(cfg: Optional[dict] = None) -> tuple[str, str]:
        g = ((cfg if cfg is not None else cfgmod.load()).get("graph") or {})
        return str(g.get("client_id") or "").strip(), str(g.get("tenant_id") or "").strip()

    def auth(self, cfg: Optional[dict] = None, retry: bool = False):
        """The sign-in for the registration in config.json. A failed setup (unknown tenant,
        no network, msal missing) is not retried at every status poll: only on `retry`
        (sign-in button) or once the registration changes."""
        key = self._registration(cfg)
        if not all(GUID.match(k) for k in key):
            return None
        with self._lock:
            if self._auth is not None and self._key == key:
                return self._auth
            if self._failed == key and not retry:
                return None
            try:
                from msgraph.auth import GraphAuth
                self._auth, self._key, self._failed, self.error = GraphAuth(cfgmod.HOME, *key), key, None, None
            except Exception as e:
                self._auth, self._failed, self.error = None, key, f"Microsoft Graph indisponible : {e}"[:300]
            return self._auth

    def client(self) -> Optional[GraphClient]:
        auth = self.auth()
        if auth is None or not auth.status()["signed_in"]:
            return None
        return GraphClient(auth.token)

    def status(self) -> dict:
        client_id, tenant_id = self._registration()
        auth = self.auth()
        base = {"client_id": client_id, "tenant_id": tenant_id}
        if auth is None:
            return {**base, "configured": False, "signed_in": False, "account": None, "pending": False,
                    "error": self.error}
        return {**base, **auth.status()}

    def configure(self, client_id: str, tenant_id: str) -> dict:
        client_id, tenant_id = client_id.strip(), tenant_id.strip()
        for value in (client_id, tenant_id):
            if value and not GUID.match(value):
                raise ValueError("Identifiant attendu au format GUID (donné par la DSI).")
        cfg = cfgmod.load()
        if self._registration(cfg) != (client_id, tenant_id) and self._auth is not None:
            self._auth.logout()
        cfg["graph"] = {"client_id": client_id, "tenant_id": tenant_id}
        cfgmod.save(cfg)
        self.auth(cfg, retry=True)
        return self.status()


SERVICE = GraphService()
