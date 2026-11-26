from __future__ import annotations
import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import PurePath
from typing import Callable, Literal, Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

import config as cfgmod
from settings import SettingsPatch
from watcher import ActionError, Watcher
from brain.base import Brain
from brain.claude import ClaudeBrain
from brain.copilot import CopilotBrain
from drivers.base import TeamsDriver
from github.auth import GithubAuth
from brain.auth import ClaudeAuth


def make_driver() -> TeamsDriver:
    # Real UIA driver on Windows; mock elsewhere so the API runs anywhere.
    if os.name == "nt" and os.environ.get("TRAME_DRIVER", "uia") != "mock":
        try:
            from drivers.windows_uia import WindowsUIADriver
            return WindowsUIADriver()
        except Exception as e:
            import sys
            from drivers.unavailable import UnavailableDriver
            print(f"[trame] pilote Teams indisponible : {e!r}", file=sys.stderr)
            return UnavailableDriver(repr(e))
    from drivers.mock import MockTeamsDriver
    return MockTeamsDriver(interval=float(os.environ.get("TRAME_MOCK_INTERVAL", "15")))


def make_brain(cfg: dict) -> Brain:
    if os.environ.get("TRAME_BRAIN") == "mock":
        from brain.mock import MockBrain
        return MockBrain()
    prov = cfg.get("brain", {}).get("provider", "claude")
    if prov == "copilot":
        c = cfg["brain"].get("copilot", {})
        return CopilotBrain(command=c.get("command", "gh"), args=c.get("args"))
    c = cfg.get("brain", {}).get("claude", {})
    return ClaudeBrain(command=c.get("command", "claude"), args=c.get("args"))


# Packaged app (Tauri) and the Vite dev / preview servers only.
ALLOWED_ORIGIN = re.compile(r"^(https?://(localhost|127\.0\.0\.1):(517\d|4173)|tauri://localhost|https?://tauri\.localhost)$")
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "testserver"}


class LocalOnly:
    """The engine listens on loopback, but any web page the user opens can still reach
    127.0.0.1 (no-cors POSTs, WebSockets, DNS rebinding). Only the Trame UI may talk to
    it: the Host must be loopback and, when the browser sends an Origin, it must be the
    Trame UI's. Requests without Origin come from local tools, not from web pages."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            host = headers.get("host", "").rsplit(":", 1)[0].strip("[]").lower()
            origin = headers.get("origin")
            if host not in ALLOWED_HOSTS or (origin is not None and not ALLOWED_ORIGIN.match(origin)):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                body = json.dumps({"ok": False, "error": "Origine non autorisée."}).encode()
                await send({"type": "http.response.start", "status": 403,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


WS_POLL = 0.25
WS_KEEPALIVE = 15.0


class PauseBody(BaseModel):
    paused: bool


class WatchBody(BaseModel):
    watch: bool


class ModeBody(BaseModel):
    mode: Literal["draft", "auto"]


class TextBody(BaseModel):
    text: Optional[str] = None


class WatchlistItem(BaseModel):
    thread_id: str = Field(min_length=1)
    watch: Optional[bool] = None
    mode: Optional[Literal["draft", "auto"]] = None


class BriefBody(BaseModel):
    last_messages: Optional[int] = Field(default=None, ge=10, le=100)


SOUL_SAMPLE = "Salut, tu peux jeter un œil à la PR #214 avant demain ? Je bloque sur le mapping OBX."


class SoulPreviewBody(BaseModel):
    content: str = Field(min_length=1, max_length=64 * 1024)


class ResetBody(BaseModel):
    confirm: Literal["RESET"]


class SoulBody(BaseModel):
    filename: str
    content: str


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"ok": False, "error": message})


def create_app(
    driver: Optional[TeamsDriver] = None,
    brain: Optional[Brain] = None,
    brain_factory: Callable[[dict], Brain] = make_brain,
    github_auth: Optional[GithubAuth] = None,
    claude_auth: Optional[ClaudeAuth] = None,
) -> FastAPI:
    watcher = Watcher(driver or make_driver(), brain or brain_factory(cfgmod.load()), brain_factory=brain_factory)
    gh_auth = github_auth or GithubAuth()
    cl_auth = claude_auth or ClaudeAuth()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        watcher.start()
        yield
        watcher.stop()
        gh_auth.cancel()
        cl_auth.cancel()

    app = FastAPI(title="Trame", lifespan=lifespan)
    app.state.watcher = watcher
    app.state.github_auth = gh_auth
    # Loopback-only server. Allow the dev origin (Vite) and the packaged Tauri origin
    # (tauri://localhost, http(s)://tauri.localhost) — otherwise POST actions are
    # blocked by CORS in the installed app.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ALLOWED_ORIGIN.pattern,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(LocalOnly)

    @app.exception_handler(ActionError)
    async def _action_error(_req: Request, exc: ActionError):
        return _error(exc.status, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        details = "; ".join(
            f"{'.'.join(str(p) for p in e.get('loc', ()) if p != 'body') or 'corps'} : {e.get('msg', '')}"
            for e in exc.errors()
        )
        return _error(422, f"Requête invalide — {details}")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_req: Request, exc: StarletteHTTPException):
        message = "Ressource introuvable." if exc.status_code == 404 else str(exc.detail)
        return _error(exc.status_code, message)

    def state_payload() -> str:
        return watcher.state.model_dump_json(by_alias=True)

    @app.get("/api/state")
    def get_state():
        return json.loads(state_payload())

    @app.post("/api/pause")
    def set_pause(body: PauseBody):
        watcher.set_paused(body.paused)
        return {"ok": True, "paused": body.paused}

    @app.post("/api/watch/{thread_id:path}")
    def set_watch(thread_id: str, body: WatchBody):
        watcher.set_watch(thread_id, body.watch)
        return {"ok": True}

    @app.post("/api/mode/{thread_id:path}")
    def set_mode(thread_id: str, body: ModeBody):
        watcher.set_mode(thread_id, body.mode)
        return {"ok": True}

    @app.put("/api/watchlist")
    def put_watchlist(body: list[WatchlistItem]):
        count = watcher.upsert_watchlist((i.thread_id, i.watch, i.mode) for i in body)
        return {"ok": True, "count": count, "missing": list(watcher._last_missing)}

    @app.post("/api/drafts/{draft_id}/send")
    def send_draft(draft_id: str, body: Optional[TextBody] = None):
        watcher.send_draft(draft_id, body.text if body else None)
        return {"ok": True}

    @app.post("/api/drafts/{draft_id}/compose")
    def compose_draft(draft_id: str, body: Optional[TextBody] = None):
        watcher.compose_draft(draft_id, body.text if body else None)
        return {"ok": True}

    @app.post("/api/drafts/{draft_id}/dismiss")
    def dismiss_draft(draft_id: str):
        watcher.dismiss_draft(draft_id)
        return {"ok": True}

    @app.post("/api/catchup")
    def catchup():
        return {"ok": True, "queued": watcher.catchup()}

    @app.get("/api/settings")
    def get_settings():
        return {"ok": True, "settings": watcher.get_settings().model_dump()}

    @app.put("/api/settings")
    def put_settings(body: SettingsPatch):
        return {"ok": True, "settings": watcher.update_settings(body).model_dump()}

    @app.post("/api/threads/{thread_id:path}/brief")
    def post_brief(thread_id: str, body: Optional[BriefBody] = None):
        brief = watcher.generate_brief(thread_id, body.last_messages if body else None)
        return {"ok": True, "brief": brief.model_dump()}

    @app.get("/api/threads/{thread_id:path}/brief")
    def get_brief(thread_id: str):
        brief = watcher.cached_brief(thread_id)
        return {"ok": True, "brief": brief.model_dump() if brief else None}

    @app.get("/api/github/status")
    def github_status():
        return {"ok": True, "github": gh_auth.status().model_dump()}

    @app.post("/api/github/login")
    def github_login():
        return {"ok": True, **gh_auth.login()}

    @app.get("/api/brain/claude/status")
    def claude_status():
        return {"ok": True, "claude": cl_auth.status().model_dump()}

    @app.post("/api/brain/claude/login")
    def claude_login():
        return {"ok": True, **cl_auth.login()}

    @app.post("/api/brain/claude/login/cancel")
    def claude_login_cancel():
        cl_auth.cancel()
        return {"ok": True}

    @app.post("/api/github/login/cancel")
    def github_login_cancel():
        gh_auth.cancel()
        return {"ok": True}

    @app.post("/api/soul")
    def post_soul(body: SoulBody):
        name = PurePath(body.filename.strip()).name
        if not name.lower().endswith((".md", ".txt")):
            raise ActionError(422, "Le persona doit être un fichier .md ou .txt.")
        if not body.content.strip():
            raise ActionError(422, "Le persona est vide.")
        if len(body.content.encode("utf-8")) > cfgmod.SOUL_MAX_BYTES:
            raise ActionError(413, "Le persona dépasse 64 Ko.")
        watcher.set_soul(body.content)
        return {"ok": True}

    @app.get("/api/people")
    def get_people():
        return {"ok": True, "people": watcher.people_summary().model_dump()}

    @app.post("/api/people")
    def post_people(body: SoulBody):
        if not PurePath(body.filename.strip()).name.lower().endswith(".json"):
            raise ActionError(422, "L'entourage doit être un fichier .json exporté d'Orbite.")
        return {"ok": True, "people": watcher.set_people(body.content).model_dump()}

    @app.delete("/api/people")
    def delete_people():
        watcher.clear_people()
        return {"ok": True}

    @app.get("/api/soul")
    def get_soul():
        custom = cfgmod.soul_is_custom()
        return {"ok": True, "soul": {"custom": custom, "filename": "SOUL.md", "content": watcher.soul if custom else ""}}

    @app.post("/api/soul/preview")
    def soul_preview(body: SoulPreviewBody):
        return {"ok": True, "incoming": SOUL_SAMPLE, "reply": watcher.preview_soul(body.content, SOUL_SAMPLE)}

    @app.post("/api/reset")
    def reset(body: ResetBody):
        watcher.factory_reset()
        return {"ok": True}

    @app.post("/api/selftest")
    def selftest():
        try:
            watcher.state.selftest_ok = bool(watcher.driver.selftest())
        except Exception:
            watcher.state.selftest_ok = False
        return {"ok": True, "selftest_ok": watcher.state.selftest_ok}

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        # The state is checked often (changes show up within 250 ms) but only sent when it
        # changed, plus a keep-alive every 15 s: an idle Trame sends almost nothing and
        # the UI does not re-render the whole watchlist every second.
        await socket.accept()
        last = ""
        idle = 0.0
        try:
            while True:
                payload = state_payload()
                if payload != last or idle >= WS_KEEPALIVE:
                    await socket.send_text(payload)
                    last, idle = payload, 0.0
                await asyncio.sleep(WS_POLL)
                idle += WS_POLL
        except WebSocketDisconnect:
            return

    return app


app = create_app()
watcher: Watcher = app.state.watcher
