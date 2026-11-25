from __future__ import annotations
import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import config as cfgmod
from watcher import Watcher
from brain.claude import ClaudeBrain
from brain.copilot import CopilotBrain


def make_driver():
    # Real UIA driver on Windows; mock elsewhere so the API runs anywhere.
    if os.name == "nt" and os.environ.get("TRAME_DRIVER", "uia") != "mock":
        from drivers.windows_uia import WindowsUIADriver
        return WindowsUIADriver()
    from drivers.mock import MockTeamsDriver
    return MockTeamsDriver(interval=float(os.environ.get("TRAME_MOCK_INTERVAL", "15")))


def make_brain(cfg: dict):
    prov = cfg.get("brain", {}).get("provider", "claude")
    if prov == "copilot":
        c = cfg["brain"].get("copilot", {})
        return CopilotBrain(command=c.get("command", "gh"), args=c.get("args"))
    c = cfg.get("brain", {}).get("claude", {})
    return ClaudeBrain(command=c.get("command", "claude"), args=c.get("args"))


cfg = cfgmod.load()
watcher = Watcher(make_driver(), make_brain(cfg))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    watcher.start()
    yield
    watcher.stop()


app = FastAPI(title="Trame", lifespan=lifespan)
# Loopback-only server. Allow the dev origin (Vite) and the packaged Tauri origin
# (tauri://localhost, http(s)://tauri.localhost) — otherwise POST actions are
# blocked by CORS in the installed app.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|https?://tauri\.localhost)$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/state")
def get_state():
    return json.loads(watcher.state.model_dump_json(by_alias=True))


class PauseBody(BaseModel):
    paused: bool


@app.post("/api/pause")
def set_pause(body: PauseBody):
    watcher.set_paused(body.paused)
    return {"ok": True, "paused": body.paused}


class WatchBody(BaseModel):
    watch: bool


@app.post("/api/watch/{thread_id:path}")
def set_watch(thread_id: str, body: WatchBody):
    watcher.set_watch(thread_id, body.watch)
    return {"ok": True}


class ModeBody(BaseModel):
    mode: Literal["draft", "auto"]


@app.post("/api/mode/{thread_id:path}")
def set_mode(thread_id: str, body: ModeBody):
    watcher.set_mode(thread_id, body.mode)
    return {"ok": True}


@app.post("/api/drafts/{draft_id}/send")
def send_draft(draft_id: str):
    watcher.send_draft(draft_id)
    return {"ok": True}


@app.post("/api/drafts/{draft_id}/dismiss")
def dismiss_draft(draft_id: str):
    watcher.dismiss_draft(draft_id)
    return {"ok": True}


@app.post("/api/selftest")
def selftest():
    watcher.state.selftest_ok = watcher.driver.selftest()
    return {"ok": watcher.state.selftest_ok}


@app.websocket("/ws")
async def ws(socket: WebSocket):
    await socket.accept()
    try:
        while True:
            await socket.send_text(watcher.state.model_dump_json(by_alias=True))
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        return
