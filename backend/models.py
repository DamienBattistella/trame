from __future__ import annotations
from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


class Surface(str, Enum):
    dm = "dm"
    group = "group"
    channel = "channel"


Mode = Literal["draft", "auto"]


class WatchEntity(BaseModel):
    thread_id: str
    display_name: str
    surface: Surface
    watch: bool = False
    mode: Mode = "draft"
    named_people: list[str] = Field(default_factory=list)
    # Live facts from Teams (not saved): rail position (0 = most recent), time of the
    # last message as Teams shows it ("04:49", "25/11"), unread flag.
    rank: Optional[int] = None
    last_activity: Optional[str] = None
    unread: bool = False
    is_self: bool = False
    own_preview: Optional[str] = None


class IncomingMessage(BaseModel):
    thread_id: str
    sender: str
    text: str
    received_at: str
    surface: Surface
    mentions: list[str] = Field(default_factory=list)


class Draft(BaseModel):
    id: str
    thread_id: str
    from_: str = Field(alias="from")
    surface: Surface
    incoming: str
    proposal: str
    received_at: str
    mode: Mode
    used_github: Optional[str] = None
    sender_label: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class Notice(BaseModel):
    """A message just received, whatever the conversation: the UI turns it into a
    Windows notification."""
    id: str
    thread_id: str
    conversation: str
    from_: str = Field(alias="from")
    text: str
    at: str
    surface: Surface

    model_config = ConfigDict(populate_by_name=True)


class LogItem(BaseModel):
    at: str
    level: Literal["info", "warn", "sent", "draft"]
    text: str


class AppState(BaseModel):
    onboarded: bool = False
    paused: bool = False
    screen_sharing: bool = False
    brain: Literal["claude", "copilot"] = "claude"
    selftest_ok: bool = True
    watchlist: list[WatchEntity] = Field(default_factory=list)
    drafts: list[Draft] = Field(default_factory=list)
    logs: list[LogItem] = Field(default_factory=list)
    notices: list[Notice] = Field(default_factory=list)


class GithubHit(BaseModel):
    kind: Literal["pr", "issue", "commit"]
    repo: str
    number: Optional[int] = None
    title: str
    state: Optional[Literal["open", "closed", "merged"]] = None
    url: str
    why: str


class BriefSources(BaseModel):
    messages: int
    repos_searched: int


class Brief(BaseModel):
    thread_id: str
    display_name: str
    generated_at: str
    summary: str
    open_points: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    github_enabled: bool
    github: list[GithubHit] = Field(default_factory=list)
    sources: BriefSources
