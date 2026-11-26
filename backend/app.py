from __future__ import annotations
import asyncio
import json
import os
from datetime import datetime
import re
from contextlib import asynccontextmanager
from pathlib import Path, PurePath
from typing import Any, Callable, Literal, Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

import attachments as attachmod
import config as cfgmod
import presence as presencemod
import journal as journalmod
import soul_template as soultpl
from mcp_server import make_router as make_mcp_router
import settings as settingsmod
from settings import SettingsPatch
from watcher import ActionError, Watcher
from models import MessageRef, Reaction
from brain.base import Brain
from brain.claude import ClaudeBrain
from brain.copilot import CopilotBrain
from drivers.base import TeamsDriver
from github import context as ghctx
from github.auth import GithubAuth
from brain.auth import ClaudeAuth


def make_driver() -> TeamsDriver:
    # Teams web inside Trame (« Teams intégré ») is the driver. TRAME_DRIVER=uia keeps
    # the old desktop-app driver for diagnosis, TRAME_DRIVER=mock runs anywhere.
    mode = os.environ.get("TRAME_DRIVER") or ("web" if os.name == "nt" else "mock")
    if mode == "web":
        from drivers.graph import GraphDriver
        from drivers.web_bridge import WebBridgeDriver
        from msgraph.service import SERVICE
        # Microsoft Graph first when IT registered Trame and the user signed in; the
        # Teams page otherwise, and for what Graph cannot do (docs/teams-graph.md).
        return GraphDriver(WebBridgeDriver(), SERVICE.client)
    if os.name == "nt" and mode != "mock":
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
    models = settingsmod.from_config(cfg).models
    if prov == "copilot":
        c = cfg["brain"].get("copilot", {})
        return CopilotBrain(command=c.get("command", "gh"), args=c.get("args"), model=models.copilot_model,
                            effort=models.copilot_effort)
    c = cfg.get("brain", {}).get("claude", {})
    return ClaudeBrain(command=c.get("command", "claude"), args=c.get("args"), model=models.claude_model,
                       effort=models.claude_effort)


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
# While the model thinks, the reflection panel is fed this often.
WS_REFLECTION_POLL = 0.08


class GraphConfigBody(BaseModel):
    client_id: str = Field(default="", max_length=64)
    tenant_id: str = Field(default="", max_length=64)


class PauseBody(BaseModel):
    paused: bool


class WatchBody(BaseModel):
    watch: bool


class FavoriteBody(BaseModel):
    favorite: bool


class ArchiveBody(BaseModel):
    archived: bool


class FavoritesOrderBody(BaseModel):
    order: list[str] = Field(max_length=500)


class ModeBody(BaseModel):
    mode: Literal["draft", "auto"]


class TextBody(BaseModel):
    text: Optional[str] = None
    # Répondre à ce message précis du fil (citation Teams), pas seulement à la conversation.
    reply_to: Optional[MessageRef] = None
    # Noms écrits « @Nom » dans le texte, à transformer en vraies mentions Teams.
    mentions: list[str] = Field(default_factory=list, max_length=10)


class SkillToggleBody(BaseModel):
    enabled: bool


class SkillDirsBody(BaseModel):
    dirs: list[str] = Field(default_factory=list, max_length=10)


class SkillRepoBody(BaseModel):
    url: str = Field(max_length=300)
    branch: str = Field(default="", max_length=100)


class ReportStartBody(BaseModel):
    thread_id: str = Field(default="", max_length=300)
    mid: str = Field(default="", max_length=100)
    title: str = Field(default="", max_length=300)
    date: Optional[str] = Field(default=None, max_length=10)
    skill: str = Field(default="meeting-report", max_length=64)
    path: Optional[str] = Field(default=None, max_length=500)


class ReportAnswerBody(BaseModel):
    text: str = Field(max_length=4000)


class PublishPlanBody(BaseModel):
    report_id: str = Field(max_length=100)


class PublishBody(BaseModel):
    report_id: str = Field(max_length=100)
    repo: str = Field(max_length=200)
    path: Optional[str] = Field(default=None, max_length=400)
    draft: Optional[bool] = None


class ReportStateBody(BaseModel):
    meeting_id: str = Field(default="", max_length=300)
    title: str = Field(default="", max_length=300)
    date: Optional[str] = Field(default=None, max_length=10)
    path: Optional[str] = Field(default=None, max_length=600)


class FollowUpSendBody(BaseModel):
    text: Optional[str] = Field(default=None, max_length=8000)


class SnoozeBody(BaseModel):
    hours: float = Field(default=24, gt=0, le=24 * 14)


class SendBody(TextBody):
    """A send clicked in the conversation view: text, plus files the user chose there."""
    attachments: list[attachmod.AttachmentIn] = Field(default_factory=list, max_length=attachmod.MAX_FILES)
    # Envoyer même si le même contenu, resté « non confirmé », semble déjà dans le fil.
    force: bool = False


def _files(body: Optional[SendBody]) -> list[attachmod.Attachment]:
    try:
        return attachmod.parse(body.attachments if body else [])
    except attachmod.AttachmentError as e:
        raise ActionError(422, f"Rien n'a été envoyé : {e}") from None


class ReactBody(BaseModel):
    message: MessageRef
    reaction: Reaction = "like"


class DeleteBody(BaseModel):
    message: MessageRef


class CorrectBody(BaseModel):
    text: str = ""
    # The conversation being written in, to file the action in the reflection panel.
    thread_id: Optional[str] = None


class SuggestBody(BaseModel):
    # Proposer une réponse à ce message précis plutôt qu'au dernier reçu.
    message: Optional[MessageRef] = None


class CheckBody(BaseModel):
    text: str = Field(max_length=4000)
    # La réponse cite ce message : la vérification le prend comme contexte.
    message: Optional[MessageRef] = None


class WatchlistItem(BaseModel):
    thread_id: str = Field(min_length=1)
    watch: Optional[bool] = None
    mode: Optional[Literal["draft", "auto"]] = None


class StartBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class SearchBody(BaseModel):
    q: str = Field(max_length=200)
    limit: int = Field(default=25, ge=1, le=50)


class StatusBody(BaseModel):
    presence: presencemod.Choice
    # « Rétablir le statut après » : 30 min, 1 h, 2 h, aujourd'hui, cette semaine ; absent : jusqu'à changement.
    duration: Optional[presencemod.Duration] = None
    # « Personnalisé » : jusqu'à une date et une heure locales, "AAAA-MM-JJTHH:MM" (sans durée).
    until: Optional[str] = Field(default=None, max_length=32)


class StatusMessageBody(BaseModel):
    text: str = Field(default="", max_length=presencemod.MESSAGE_MAX * 2)


class BriefBody(BaseModel):
    last_messages: Optional[int] = Field(default=None, ge=10, le=100)


SOUL_SAMPLE = "Salut, tu peux jeter un œil à la PR #214 avant demain ? Je bloque sur le mapping OBX."


class SoulPreviewBody(BaseModel):
    content: str = Field(min_length=1, max_length=64 * 1024)


class BridgeReply(BaseModel):
    id: int
    ok: bool
    result: Optional[Any] = None
    error: Optional[str] = None


class TranscriptBody(BaseModel):
    thread_id: str = Field(min_length=1, max_length=300)
    mid: str = Field(min_length=1, max_length=40, pattern=r"^[0-9A-Za-z_-]+$")
    directory: Optional[str] = Field(default=None, max_length=400)
    # Diagnostic : la forme de la page de transcription (sans son texte), rien d'enregistré.
    probe: bool = False


class FolderBody(BaseModel):
    directory: Optional[str] = Field(default=None, max_length=400)


class FolderChoiceBody(BaseModel):
    directory: str = Field(min_length=1, max_length=400)


class TranscriptFileBody(BaseModel):
    path: str = Field(min_length=1, max_length=600)
    reveal: bool = False


class DiagnosticBody(BaseModel):
    thread_id: Optional[str] = None


class ResetBody(BaseModel):
    confirm: Literal["RESET"]


class SoulBody(BaseModel):
    filename: str
    content: str


def _error(status: int, message: str, code: Optional[str] = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"ok": False, "error": message, **({"code": code} if code else {})})


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
        return _error(exc.status, exc.message, exc.code)

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

    @app.post("/api/favorite/{thread_id:path}")
    def set_favorite(thread_id: str, body: FavoriteBody):
        return {"ok": True, "favorites": watcher.set_favorite(thread_id, body.favorite)}

    @app.post("/api/archive/{thread_id:path}")
    def set_archived(thread_id: str, body: ArchiveBody):
        return {"ok": True, "archived": watcher.set_archived(thread_id, body.archived)}

    @app.get("/api/archive")
    def archive_status():
        return {"ok": True, "archived": watcher.archived_view(), "can_hide_in_teams": watcher.can_hide_in_teams()}

    @app.put("/api/favorites")
    def reorder_favorites(body: FavoritesOrderBody):
        return {"ok": True, "favorites": watcher.reorder_favorites(body.order)}

    @app.post("/api/mode/{thread_id:path}")
    def set_mode(thread_id: str, body: ModeBody):
        watcher.set_mode(thread_id, body.mode)
        return {"ok": True}

    @app.put("/api/watchlist")
    def put_watchlist(body: list[WatchlistItem]):
        count = watcher.upsert_watchlist((i.thread_id, i.watch, i.mode) for i in body)
        return {"ok": True, "count": count, "missing": list(watcher._last_missing)}

    @app.post("/api/conversations/refresh")
    def refresh_conversations():
        return {"ok": True, "count": watcher.refresh_conversations()}

    @app.post("/api/conversations/start")
    def start_conversation(body: StartBody):
        """Opens (or creates) the private chat with someone, then lists it, unfollowed."""
        entity = watcher.start_conversation(body.name)
        return {"ok": True, "conversation": json.loads(entity.model_dump_json())}

    @app.post("/api/drafts/{draft_id}/send")
    def send_draft(draft_id: str, body: Optional[SendBody] = None):
        queued = watcher.send_draft(draft_id, body.text if body else None, body.reply_to if body else None,
                                    body.mentions if body else None, _files(body), force=bool(body and body.force))
        # Teams pas prêt : le message attend dans la file d'envoi et partira seul.
        return {"ok": True, "queued": queued.model_dump()} if queued else {"ok": True}

    @app.post("/api/drafts/{draft_id}/compose")
    def compose_draft(draft_id: str, body: Optional[TextBody] = None):
        watcher.compose_draft(draft_id, body.text if body else None, body.reply_to if body else None)
        return {"ok": True}

    @app.post("/api/drafts/{draft_id}/dismiss")
    def dismiss_draft(draft_id: str):
        watcher.dismiss_draft(draft_id)
        return {"ok": True}

    @app.post("/api/follow-ups/{item_id}/send")
    def follow_up_send(item_id: str, body: Optional[FollowUpSendBody] = None):
        """Relance envoyée sur ton clic, par le chemin d'un envoi à la main."""
        queued = watcher.send_follow_up(item_id, body.text if body else None)
        return {"ok": True, "queued": queued.model_dump()} if queued else {"ok": True}

    @app.post("/api/follow-ups/{item_id}/snooze")
    def follow_up_snooze(item_id: str, body: Optional[SnoozeBody] = None):
        watcher.snooze_follow_up(item_id, body.hours if body else 24)
        return {"ok": True}

    @app.post("/api/follow-ups/{item_id}/ignore")
    def follow_up_ignore(item_id: str):
        watcher.ignore_follow_up(item_id)
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

    @app.get("/api/threads/{thread_id:path}/messages")
    def thread_messages(thread_id: str, last: int = 30, fresh: bool = False):
        # top: the start of the conversation was reached, there is nothing older to load.
        messages, top = watcher.thread_history(thread_id, max(5, min(500, last)), fresh)
        # meeting: a meeting chat's join link and whether it is in progress (else null).
        return {"ok": True, "messages": messages, "top": top, "meeting": watcher.thread_meeting(thread_id)}

    @app.get("/api/threads/{thread_id:path}/activity")
    def thread_activity(thread_id: str):
        # typing / typing_text: someone is writing; seen: your last message was read.
        return {"ok": True, **watcher.thread_activity(thread_id)}

    @app.get("/api/search")
    def search_messages(q: str = "", limit: int = 50):
        return {"ok": True, **watcher.search_messages(q, max(1, min(200, limit)))}

    @app.post("/api/search/teams")
    def search_teams(body: SearchBody):
        return {"ok": True, **watcher.search_teams(body.q, body.limit)}

    @app.get("/api/me/status")
    def get_my_status():
        """Own Teams status and status message (opens Teams' profile menu, then closes it)."""
        return {"ok": True, **watcher.my_status()}

    @app.post("/api/me/status")
    def post_my_status(body: StatusBody):
        return {"ok": True, **watcher.set_my_status(body.presence, body.duration, body.until)}

    @app.post("/api/me/status-message/suggest")
    def suggest_status_message(body: Optional[StatusMessageBody] = None):
        """A status message proposed in the user's voice. Nothing is sent to Teams."""
        return {"ok": True, **watcher.suggest_status_message(body.text if body else "")}

    @app.post("/api/me/status-message")
    def post_status_message(body: StatusMessageBody):
        return {"ok": True, **watcher.set_status_message(body.text)}

    @app.get("/api/meetings")
    def meetings():
        """Finished meetings of the recent meeting chats (opens them in Teams intégré)."""
        return {"ok": True, **watcher.meetings()}

    @app.get("/api/meetings/known")
    def meetings_known():
        """The meetings of the last reading, kept on this computer: Teams is not read."""
        return {"ok": True, **watcher.known_meetings()}

    @app.post("/api/meetings/transcript")
    def meeting_transcript(body: TranscriptBody):
        """Read one meeting's transcript in Teams and save it as a .vtt on this computer."""
        if body.probe:
            return {"ok": True, **watcher.probe_transcript(body.thread_id, body.mid)}
        return {"ok": True, **watcher.save_transcript(body.thread_id, body.mid, body.directory)}

    @app.post("/api/meetings/open-folder")
    def meetings_open_folder(body: FolderBody):
        """Open the transcripts folder in the Explorer (created when missing)."""
        return {"ok": True, **watcher.open_transcripts_folder(body.directory)}

    @app.get("/api/meetings/folder")
    def meetings_folder():
        """The transcripts folder, without reading Teams nor opening anything."""
        return {"ok": True, **watcher.transcripts_folder()}

    @app.post("/api/meetings/folder")
    def meetings_set_folder(body: FolderChoiceBody):
        """Choose the transcripts folder (remembered), without opening anything."""
        return {"ok": True, **watcher.set_transcripts_folder(body.directory)}

    @app.post("/api/meetings/file")
    def meetings_open_file(body: TranscriptFileBody):
        """Open a saved .vtt, or show it selected in the Explorer (reveal)."""
        return {"ok": True, **watcher.open_transcript_file(body.path, body.reveal)}

    @app.post("/api/threads/{thread_id:path}/send")
    def thread_send(thread_id: str, body: SendBody):
        queued = watcher.send_manual(thread_id, body.text or "", body.reply_to, body.mentions, _files(body), force=body.force)
        return {"ok": True, "queued": queued.model_dump()} if queued else {"ok": True}

    @app.get("/api/attachments")
    def attachments_info():
        """Whether this Teams driver can attach files, and the limits the UI shows."""
        return {"ok": True, **watcher.attachments_info()}

    @app.post("/api/threads/{thread_id:path}/react")
    def thread_react(thread_id: str, body: ReactBody):
        watcher.react(thread_id, body.message, body.reaction)
        return {"ok": True}

    @app.post("/api/undo/{undo_id}")
    def undo_auto(undo_id: str):
        """Take back an automatic reply (deleted in Teams), within its window."""
        watcher.undo_auto(undo_id)
        return {"ok": True}

    @app.post("/api/threads/{thread_id:path}/delete")
    def thread_delete(thread_id: str, body: DeleteBody):
        """Delete one of the user's own messages: asked from the discussion view only."""
        watcher.delete_message(thread_id, body.message)
        return {"ok": True}

    @app.post("/api/threads/{thread_id:path}/suggest")
    def thread_suggest(thread_id: str, body: Optional[SuggestBody] = None):
        return {"ok": True, "text": watcher.suggest_reply(thread_id, target=body.message if body else None)}

    @app.post("/api/threads/{thread_id:path}/check")
    def thread_check(thread_id: str, body: CheckBody):
        return {"ok": True, "check": watcher.fact_check(thread_id, body.text, body.message).model_dump()}

    @app.post("/api/correct")
    def correct_text(body: CorrectBody):
        text = watcher.correct_text(body.text, body.thread_id)
        return {"ok": True, "text": text, "changed": text != body.text.strip()}

    @app.get("/api/skills")
    def get_skills():
        return {"ok": True, **watcher.skills_summary()}

    @app.post("/api/skills/reload")
    def reload_skills():
        return {"ok": True, **watcher.reload_skills()}

    @app.put("/api/skills/dirs")
    def put_skill_dirs(body: SkillDirsBody):
        return {"ok": True, **watcher.set_skill_dirs(body.dirs)}

    @app.post("/api/skills/repos")
    def sync_skill_repo(body: SkillRepoBody):
        return {"ok": True, **watcher.sync_skill_repo(body.url, body.branch)}

    @app.post("/api/skills/repos/remove")
    def remove_skill_repo(body: SkillRepoBody):
        return {"ok": True, **watcher.remove_skill_repo(body.url, body.branch)}

    @app.post("/api/skills/{name}")
    def toggle_skill(name: str, body: SkillToggleBody):
        return {"ok": True, **watcher.set_skill_enabled(name, body.enabled)}

    @app.post("/api/reports")
    def start_report(body: ReportStartBody):
        """Meeting report: a skill applied to the meeting's .vtt (fetched first if needed)."""
        return {"ok": True, "report": watcher.start_meeting_report(body.thread_id, body.mid, body.title, body.date,
                                                                   body.skill, body.path)}

    @app.get("/api/reports")
    def list_reports():
        return {"ok": True, "reports": watcher.reports.list()}

    @app.get("/api/reports/{report_id}")
    def get_report(report_id: str):
        return {"ok": True, "report": watcher.report_call(watcher.reports.snapshot, report_id)}

    @app.post("/api/reports/{report_id}/answer")
    def answer_report(report_id: str, body: ReportAnswerBody):
        return {"ok": True, "report": watcher.report_call(watcher.reports.answer, report_id, body.text)}

    @app.post("/api/reports/{report_id}/cancel")
    def cancel_report(report_id: str):
        return {"ok": True, "report": watcher.report_call(watcher.reports.cancel, report_id)}

    @app.post("/api/reports/{report_id}/save")
    def save_report(report_id: str):
        return {"ok": True, "report": watcher.report_call(watcher.reports.save, report_id)}

    @app.post("/api/reports/{report_id}/open-folder")
    def open_report_folder(report_id: str):
        report = watcher.report_call(watcher.reports.snapshot, report_id)
        return {"ok": True, **watcher.open_transcripts_folder(str(Path(report["vttPath"]).parent))}

    @app.get("/api/reflections")
    def get_reflections():
        """The last reply-box actions and what the model did during each, newest first."""
        return {"ok": True, "runs": watcher.reflections.snapshot()}

    @app.post("/api/reflections/{run_id}/cancel")
    def cancel_reflection(run_id: str):
        if not watcher.reflections.cancel(run_id):
            return _error(409, "Cette action n'est plus en cours.")
        return {"ok": True}

    @app.post("/api/threads/{thread_id:path}/read")
    def mark_thread_read(thread_id: str):
        watcher.mark_read(thread_id)
        return {"ok": True}

    @app.post("/api/outbox/{item_id}/cancel")
    def outbox_cancel(item_id: str):
        watcher.cancel_queued(item_id)
        return {"ok": True}

    @app.post("/api/outbox/{item_id}/retry")
    def outbox_retry(item_id: str):
        watcher.retry_queued(item_id)
        return {"ok": True}

    @app.post("/api/threads/{thread_id:path}/clear-compose")
    def clear_compose(thread_id: str):
        watcher.clear_compose(thread_id)
        return {"ok": True}

    @app.post("/api/threads/{thread_id:path}/show")
    def show_thread(thread_id: str):
        watcher.show_in_teams(thread_id)
        return {"ok": True}

    @app.get("/api/threads/{thread_id:path}/brief")
    def get_brief(thread_id: str):
        brief = watcher.cached_brief(thread_id)
        return {"ok": True, "brief": brief.model_dump() if brief else None}

    @app.get("/api/github/status")
    def github_status():
        return {"ok": True, "github": gh_auth.status().model_dump()}

    @app.get("/api/github/link")
    def github_link(kind: str, repo: str, number: int):
        """Title and state of a PR / issue linked in a message; null when GitHub is off or unreadable."""
        if not watcher.get_settings().github.enabled:
            return {"ok": True, "link": None}
        hit = ghctx.link_info(kind, repo, number)
        return {"ok": True, "link": hit.model_dump() if hit else None}

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

    @app.post("/api/github/publish/plan")
    def github_publish_plan(body: PublishPlanBody):
        """What publishing this report would do: target repo (guessed or to pick), branch,
        file path, whether it is already there, and why publishing may be blocked. No write."""
        return {"ok": True, "plan": watcher.github_publish_plan(body.report_id, gh_auth.status())}

    @app.post("/api/github/publish")
    def github_publish(body: PublishBody):
        """Open a draft pull request adding the report's .md to the chosen repo. Reached only
        from the explicit button, after the user confirmed the repo, branch, path and preview."""
        return {"ok": True, **watcher.github_publish(body.report_id, body.repo, body.path, body.draft, gh_auth.status())}

    @app.post("/api/github/report-state")
    def github_report_state(body: ReportStateBody):
        """Is this meeting's report already on its linked repo (file or open PR)? For the
        meetings list, so the user does not re-run the skill for nothing."""
        return {"ok": True, "state": watcher.github_report_state(body.meeting_id, body.title, body.date, body.path,
                                                                 gh_auth.status())}

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

    @app.get("/api/people/list")
    def list_people():
        """The imported entourage, person by person, for the settings directory. The
        email only serves name matching and stays in the engine."""
        data = watcher.people.data
        return {"ok": True, "people": [p.model_dump(exclude={"email"}) for p in (data.people if data else [])]}

    @app.get("/api/people/search")
    def search_people(q: str = "", limit: int = 8):
        """Suggestions for « Nouvelle conversation » (entourage, then Teams if the driver can)."""
        return {"ok": True, **watcher.people_search(q[:120], limit)}

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

    @app.get("/api/soul/template")
    def soul_template():
        try:
            convs = watcher.driver.list_conversations()
        except Exception:
            convs = []
        return {"ok": True, "content": soultpl.build(convs, None)}

    @app.post("/api/soul/preview")
    def soul_preview(body: SoulPreviewBody):
        return {"ok": True, "incoming": SOUL_SAMPLE, "reply": watcher.preview_soul(body.content, SOUL_SAMPLE)}

    @app.post("/api/reset")
    def reset(body: ResetBody):
        watcher.factory_reset()
        return {"ok": True}

    app.include_router(make_mcp_router(watcher))

    def _bridge():
        from drivers.web_bridge import WebBridgeDriver
        d = getattr(watcher.driver, "inner", watcher.driver)
        if not isinstance(d, WebBridgeDriver):
            raise ActionError(409, "Teams intégré n'est pas activé.")
        return d

    @app.get("/api/teams-web/poll")
    def teams_web_poll():
        bridge = _bridge()
        cmd = bridge.next_command(bridge.POLL_WAIT)
        return {"ok": True, "command": cmd}

    @app.post("/api/teams-web/reply")
    def teams_web_reply(body: BridgeReply):
        _bridge().deliver(body.id, body.ok, body.result, body.error)
        return {"ok": True}

    # --- Microsoft Graph (docs/teams-graph.md): registration, sign-in, path per action ---
    def _graph_status() -> dict:
        from msgraph.service import SERVICE
        routes = getattr(watcher.driver, "routes", None)
        return {**SERVICE.status(), "routes": routes() if callable(routes) else {}}

    @app.get("/api/graph")
    def graph_status():
        return {"ok": True, "graph": _graph_status()}

    @app.put("/api/graph")
    def graph_configure(body: GraphConfigBody):
        from msgraph.service import SERVICE
        try:
            SERVICE.configure(body.client_id, body.tenant_id)
        except ValueError as e:
            raise ActionError(422, str(e))
        return {"ok": True, "graph": _graph_status()}

    @app.post("/api/graph/login")
    def graph_login():
        from msgraph.service import SERVICE
        auth = SERVICE.auth(retry=True)
        if auth is None:
            raise ActionError(409, SERVICE.error or "Application Graph non renseignée (identifiants donnés par la DSI).")
        auth.login()
        return {"ok": True, "graph": _graph_status()}

    @app.post("/api/graph/logout")
    def graph_logout():
        from msgraph.service import SERVICE
        auth = SERVICE.auth()
        if auth is not None:
            auth.logout()
        return {"ok": True, "graph": _graph_status()}

    @app.get("/api/health")
    def get_health():
        """Santé de Trame : Teams, page Teams, file d'envoi, cerveau, veille, disque."""
        return {"ok": True, **watcher.health()}

    @app.get("/api/teams-web/status")
    def teams_web_status():
        from drivers.web_bridge import WebBridgeDriver
        d = getattr(watcher.driver, "inner", watcher.driver)
        if not isinstance(d, WebBridgeDriver):
            return {"ok": True, "status": {"enabled": False}}
        status = d.status()
        watcher.teams_ready(bool(status.get("ready")))
        return {"ok": True, "status": {"enabled": True, **status}}

    @app.get("/api/logs")
    def logs(q: str = "", levels: str = "", since: str = "", before: str = "", limit: int = 100):
        """Activité kept across restarts, newest first, filtered and paged (`before` = `next`)."""
        res = watcher.journal.query(q, journalmod.parse_levels(levels), journalmod.local_iso(since),
                                    journalmod.local_iso(before), max(1, min(500, limit)))
        return {"ok": True, **res, "items": [i.model_dump() for i in res["items"]]}

    @app.get("/api/logs/export")
    def logs_export(q: str = "", levels: str = "", since: str = ""):
        stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
        since_iso = journalmod.local_iso(since)
        if q.strip() or set(journalmod.parse_levels(levels)) != set(journalmod.LEVELS) or since_iso:
            return {"ok": True, "filename": f"trame-activite-{stamp}.txt",
                    "text": watcher.export_activity(q, journalmod.parse_levels(levels), since_iso)}
        return {"ok": True, "filename": f"trame-journaux-{stamp}.txt", "text": watcher.export_logs()}

    @app.post("/api/diagnostics/teams")
    def diagnostics(body: DiagnosticBody):
        try:
            # Clicking a conversation is a UI action: same lock and screen-share rule
            # as typing, so it never races a send or shows up in a shared screen.
            with watcher._ui_lock:
                if body.thread_id and watcher._screen_share_guarded():
                    raise ActionError(409, "Partage d'écran en cours : test d'ouverture annulé.")
                report = watcher.driver.diagnose(body.thread_id)
        except ActionError:
            raise
        except Exception as e:
            report = {"error": repr(e)}
        watcher.log("info", "Diagnostic Teams lancé")
        return {"ok": True, "report": report}

    @app.post("/api/teams/check")
    def teams_check():
        # Lecture seule dans la page Teams : aucun menu ouvert, rien de cliqué.
        check = watcher.check_teams()
        if check is None:
            raise ActionError(409, "Contrôle impossible : Teams n'est pas affiché dans Trame.")
        return {"ok": True, "check": check.model_dump()}

    @app.post("/api/selftest")
    def selftest():
        try:
            ok = bool(watcher.driver.selftest())
        except Exception:
            ok = False
        watcher.teams_ready(ok)
        return {"ok": True, "selftest_ok": watcher.state.selftest_ok}

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        # The state is checked often (changes show up within 250 ms) but only sent when it
        # changed, plus a keep-alive every 15 s: an idle Trame sends almost nothing and
        # the UI does not re-render the whole watchlist every second.
        await socket.accept()
        last = ""
        idle = 0.0
        closed = asyncio.Event()

        # A closed tab is only noticed when reading: without this, the loop would keep
        # running until its next send (up to the keep-alive) after the UI went away.
        async def until_closed():
            try:
                while (await socket.receive())["type"] != "websocket.disconnect":
                    pass
            except Exception:
                pass
            closed.set()

        reader = asyncio.create_task(until_closed())
        # Reflection runs go apart from the state, each one again only when it changed,
        # and more often while one is running: the panel follows the model as it thinks.
        revs: dict[str, int] = {}
        seen = -1
        try:
            while not closed.is_set():
                payload = state_payload()
                if payload != last or idle >= WS_KEEPALIVE:
                    await socket.send_text(payload)
                    last, idle = payload, 0.0
                if watcher.reflections.seq != seen:
                    seen = watcher.reflections.seq
                    for run in watcher.reflections.changed_since(revs):
                        revs[run["id"]] = run["rev"]
                        await socket.send_text(json.dumps({"kind": "reflection", "run": run}, ensure_ascii=False))
                pause = WS_REFLECTION_POLL if watcher.reflections.running() else WS_POLL
                try:
                    await asyncio.wait_for(closed.wait(), pause)
                except asyncio.TimeoutError:
                    idle += pause
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            reader.cancel()

    return app


app = create_app()
watcher: Watcher = app.state.watcher
