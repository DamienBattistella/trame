"""Join link of a Teams meeting, as the page of a meeting chat gives it.

Trame does not take calls or meetings: it only offers to open the meeting in the user's
Teams. The link comes from Teams' page, so it is kept only when it is a Microsoft Teams
meeting link (https, a Teams host, a join path): anything else is dropped, never opened.
"""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlsplit

# Teams for work or school, and its newer domain; teams.live.com: Teams (free).
_HOSTS = {"teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"}
# /l/meetup-join/<thread>/0?context=… : the classic link; /meet/<id>?p=… : the meeting ID link.
_PATHS = ("/l/meetup-join/", "/meet/")
_MAX = 2048


def join_url(raw: Any) -> Optional[str]:
    """raw when it is a Teams meeting join link, else None."""
    if not isinstance(raw, str):
        return None
    url = raw.strip()
    if not url or len(url) > _MAX or any(c.isspace() or ord(c) < 32 for c in url):
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or port is not None or parts.username or parts.password:
        return None
    if (parts.hostname or "") not in _HOSTS or parts.netloc.lower() != parts.hostname:
        return None
    path = parts.path
    if not any(path.startswith(p) and len(path) > len(p) for p in _PATHS):
        return None
    return url
