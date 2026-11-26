from __future__ import annotations
from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field

from presence import Presence


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
    # Teams presence of the other person of a 1:1 chat, None when Teams does not say
    # (or said it too long ago): never a guessed status.
    presence: Optional[Presence] = None


# Le petit jeu de réactions de Teams : clé stable côté moteur, emoji côté interface.
REACTIONS: dict[str, str] = {
    "like": "👍",
    "heart": "❤️",
    "laugh": "😆",
    "surprised": "😮",
    "sad": "😢",
    "angry": "😡",
}
Reaction = Literal["like", "heart", "laugh", "surprised", "sad", "angry"]


class IncomingMessage(BaseModel):
    thread_id: str
    sender: str
    text: str
    received_at: str
    surface: Surface
    mentions: list[str] = Field(default_factory=list)
    # Identifiant du message dans Teams quand le pilote le connaît, et réactions que
    # l'utilisateur y a déjà mises (clés de REACTIONS).
    id: Optional[str] = None
    reactions: list[str] = Field(default_factory=list)


class MessageRef(BaseModel):
    """Un message précis du fil, pour y réagir ou y répondre. Le pilote le retrouve par
    son id, puis vérifie l'auteur et le début du texte : jamais d'action sur un message
    qui ne correspond pas à ce que l'utilisateur a vu."""

    id: Optional[str] = Field(default=None, max_length=200)
    sender: str = Field(default="", max_length=200)
    text: str = Field(min_length=1, max_length=8000)
    at: str = Field(default="", max_length=40)


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
    # ISO date and time: `at` alone is the time of day, too short for a journal kept across days.
    ts: str = ""
    level: Literal["info", "warn", "sent", "draft"]
    text: str


class Capabilities(BaseModel):
    """Ce que le pilote Teams actif sait faire en plus de lire et d'écrire."""
    react: bool = False
    reply: bool = False


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
    capabilities: Capabilities = Field(default_factory=Capabilities)


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
