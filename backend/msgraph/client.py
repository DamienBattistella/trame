"""Minimal Microsoft Graph client: JSON over HTTPS with the signed-in user's token.

Only the documented Graph v1.0 API (https://graph.microsoft.com). The token comes from
Trame's own sign-in (msgraph.auth); nothing here ever reads a token from Teams web."""
from __future__ import annotations
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Iterator, Optional

BASE = "https://graph.microsoft.com/v1.0"
TIMEOUT = 20.0
MAX_PAGES = 20

# transport(method, url, headers, body bytes or None) -> (status, headers, body bytes)
Transport = Callable[[str, str, dict, Optional[bytes]], "tuple[int, dict, bytes]"]


class GraphError(RuntimeError):
    def __init__(self, status: int, code: str = "", message: str = ""):
        self.status, self.code = status, code
        super().__init__(f"Microsoft Graph {status}{f' {code}' if code else ''}{f' : {message}' if message else ''}")

    @property
    def forbidden(self) -> bool:
        """Missing permission or consent: the action stays on the Teams page."""
        return self.status in (401, 403)


def urllib_transport(method: str, url: str, headers: dict, body: Optional[bytes]) -> "tuple[int, dict, bytes]":
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read() or b""


class GraphClient:
    def __init__(self, token: Callable[[], str], transport: Transport = urllib_transport):
        self._token, self._transport = token, transport

    def _url(self, path: str, params: Optional[dict] = None) -> str:
        url = path if path.startswith("https://") else BASE + path
        if not url.startswith(BASE + "/"):
            raise ValueError("Microsoft Graph uniquement")
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, safe="$,'/:")
        return url

    def request(self, method: str, path: str, params: Optional[dict] = None, body: Any = None,
                accept: str = "application/json") -> Any:
        headers = {"Authorization": f"Bearer {self._token()}", "Accept": accept}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        status, _headers, raw = self._transport(method, self._url(path, params), headers, data)
        if status >= 400:
            code, message = "", ""
            try:
                err = json.loads(raw or b"{}").get("error") or {}
                code, message = str(err.get("code") or ""), str(err.get("message") or "")[:200]
            except ValueError:
                pass
            raise GraphError(status, code, message)
        if accept != "application/json":
            return raw
        return json.loads(raw) if raw else None

    def get(self, path: str, params: Optional[dict] = None) -> Any:
        return self.request("GET", path, params)

    def post(self, path: str, body: Any = None, params: Optional[dict] = None) -> Any:
        return self.request("POST", path, params, body if body is not None else {})

    def pages(self, path: str, params: Optional[dict] = None, limit: Optional[int] = None) -> Iterator[dict]:
        """Every item of a paged collection, following @odata.nextLink (bounded)."""
        url, count = path, 0
        for _ in range(MAX_PAGES):
            page = self.get(url, params) or {}
            for item in page.get("value") or []:
                yield item
                count += 1
                if limit is not None and count >= limit:
                    return
            url, params = page.get("@odata.nextLink"), None
            if not url:
                return
