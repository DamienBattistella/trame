from __future__ import annotations
import copy
import re
import secrets
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

BrainName = Literal["claude", "copilot"]
Effort = Literal["", "low", "medium", "high", "xhigh", "max"]
# A model is passed as a command-line value: alias or full name only, never an option.
_MODEL = re.compile(r"^(|[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79})$")


def _model(v: object) -> str:
    v = str(v or "").strip()
    if not _MODEL.match(v):
        raise ValueError("nom de modèle invalide (lettres, chiffres, . _ - : [ ])")
    return v


class ModelSettings(BaseModel):
    """Haiku by default for Claude: fast and enough for short Teams replies. Empty keeps
    the CLI's own default (the user's Claude Code / Copilot setting)."""
    claude_model: str = "haiku"
    claude_effort: Effort = ""
    copilot_model: str = "gpt-6-luna"
    copilot_effort: Effort = "low"

    @field_validator("claude_model", "copilot_model", mode="before")
    @classmethod
    def _check(cls, v):
        return _model(v)


# Where a published meeting report lands, and the branch it rides in on. {date} is the
# meeting day (ISO), {slug} the de-accented title; the file is always a new .md.
DEFAULT_PATH_TEMPLATE = "docs/comptes-rendus/{date}-{slug}.md"


class GithubWriteSettings(BaseModel):
    """Opening pull requests on GitHub. Off by default: until the user turns it on, Trame
    only ever reads GitHub. Even on, it only adds a branch + a new file + a draft PR —
    never a push to a protected branch, never an overwrite, never a merge."""
    enabled: bool = False
    all_repos: bool = False
    repos_allowlist: list[str] = Field(default_factory=list)
    path_template: str = DEFAULT_PATH_TEMPLATE
    draft: bool = True

    @field_validator("repos_allowlist")
    @classmethod
    def _repos(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for r in v:
            r = str(r or "").strip()
            if r and r not in out:
                out.append(r)
        return out

    @field_validator("path_template")
    @classmethod
    def _template(cls, v: str) -> str:
        v = str(v or "").strip().lstrip("/")
        if not v:
            return DEFAULT_PATH_TEMPLATE
        if ".." in v.split("/") or "\\" in v or "{slug}" not in v:
            raise ValueError("chemin invalide : relatif, sans « .. », avec {slug} et terminé par .md")
        if not v.lower().endswith(".md"):
            raise ValueError("le chemin doit se terminer par .md")
        return v


class GithubSettings(BaseModel):
    enabled: bool
    all_repos: bool
    write: GithubWriteSettings = GithubWriteSettings()


class SafetySettings(BaseModel):
    auto_pause_on_screen_share: bool
    selftest_gate: bool
    countdown_seconds: int = Field(ge=0, le=60)
    never_auto_send_if_message_contains: list[str]
    # 🤖 at the end of every message sent without a click (Auto mode).
    mark_auto_replies: bool = True
    # Auto mode guards: at most N automatic replies per hour and conversation (0: no
    # cap), no automatic reply during quiet hours (may cross midnight) nor on weekends.
    auto_max_per_hour: int = Field(default=5, ge=0, le=60)
    auto_quiet_hours: bool = False
    auto_quiet_from: str = Field(default="19:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    auto_quiet_to: str = Field(default="08:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    auto_weekends: bool = True

    @field_validator("never_auto_send_if_message_contains")
    @classmethod
    def _clean(cls, v: list[str]) -> list[str]:
        return [t.strip() for t in v if t.strip()]


class BriefSettings(BaseModel):
    enabled: bool
    last_messages: int = Field(ge=10, le=100)


class FollowUpSettings(BaseModel):
    """Relances : proposer de relancer une question restée sans réponse depuis
    delay_hours heures ouvrées (samedi et dimanche non comptés)."""
    enabled: bool = True
    delay_hours: int = Field(default=24, ge=1, le=168)


def follow_up_delay(f: dict) -> int:
    return _int((f or {}).get("delay_hours", 24), 24, 1, 168)


class ArchiveSettings(BaseModel):
    """Archivage automatique des conversations sans activité depuis after_days jours
    (0 : jamais), et masquage dans Teams par Microsoft Graph (désactivé par défaut)."""
    after_days: int = Field(default=0, ge=0, le=365)
    hide_in_teams: bool = False


def archive_after(a: dict) -> int:
    days = _int((a or {}).get("after_days", 0), 0, 0, 365)
    return days


class TelemetrySettings(BaseModel):
    enabled: bool = False
    endpoint: str = Field(default="", max_length=300)
    include_content: bool = False

    @field_validator("endpoint")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip()
        if v and not re.match(r"^https?://[^\s]+$", v):
            raise ValueError("URL OTLP/HTTP attendue (http://… ou https://…), ou vide pour un fichier local")
        return v


class McpSettings(BaseModel):
    enabled: bool = False
    token: str = ""
    allow_send: bool = False


class TeamsWebSettings(BaseModel):
    enabled: bool = True


ConversationSort = Literal["watched", "recent", "alpha"]


class UiSettings(BaseModel):
    """Interface preferences, kept in config.json (in %APPDATA%) so updates keep them."""
    conversation_sort: ConversationSort = "watched"


class Settings(BaseModel):
    onboarded: bool
    brain: BrainName
    models: ModelSettings = ModelSettings()
    github: GithubSettings
    safety: SafetySettings
    brief: BriefSettings
    follow_ups: FollowUpSettings = FollowUpSettings()
    archive: ArchiveSettings = ArchiveSettings()
    telemetry: TelemetrySettings = TelemetrySettings()
    mcp: McpSettings = McpSettings()
    teams_web: TeamsWebSettings = TeamsWebSettings()
    ui: UiSettings = UiSettings()


class _Patch(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelsPatch(_Patch):
    claude_model: Optional[str] = None
    claude_effort: Optional[Effort] = None
    copilot_model: Optional[str] = None
    copilot_effort: Optional[Effort] = None

    @field_validator("claude_model", "copilot_model", mode="before")
    @classmethod
    def _check(cls, v):
        return None if v is None else _model(v)


class GithubWritePatch(_Patch):
    enabled: Optional[bool] = None
    all_repos: Optional[bool] = None
    repos_allowlist: Optional[list[str]] = None
    path_template: Optional[str] = None
    draft: Optional[bool] = None


class GithubPatch(_Patch):
    enabled: Optional[bool] = None
    all_repos: Optional[bool] = None
    write: Optional[GithubWritePatch] = None


class SafetyPatch(_Patch):
    auto_pause_on_screen_share: Optional[bool] = None
    selftest_gate: Optional[bool] = None
    countdown_seconds: Optional[int] = Field(default=None, ge=0, le=60)
    never_auto_send_if_message_contains: Optional[list[str]] = None
    mark_auto_replies: Optional[bool] = None
    auto_max_per_hour: Optional[int] = Field(default=None, ge=0, le=60)
    auto_quiet_hours: Optional[bool] = None
    auto_quiet_from: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    auto_quiet_to: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    auto_weekends: Optional[bool] = None


class BriefPatch(_Patch):
    enabled: Optional[bool] = None
    last_messages: Optional[int] = Field(default=None, ge=10, le=100)


class FollowUpPatch(_Patch):
    enabled: Optional[bool] = None
    delay_hours: Optional[int] = Field(default=None, ge=1, le=168)


class ArchivePatch(_Patch):
    after_days: Optional[int] = Field(default=None, ge=0, le=365)
    hide_in_teams: Optional[bool] = None


class TelemetryPatch(_Patch):
    enabled: Optional[bool] = None
    endpoint: Optional[str] = Field(default=None, max_length=300)
    include_content: Optional[bool] = None


class McpPatch(_Patch):
    enabled: Optional[bool] = None
    allow_send: Optional[bool] = None
    regenerate_token: Optional[bool] = None


class TeamsWebPatch(_Patch):
    enabled: Optional[bool] = None


class UiPatch(_Patch):
    conversation_sort: Optional[ConversationSort] = None


class SettingsPatch(_Patch):
    onboarded: Optional[bool] = None
    brain: Optional[BrainName] = None
    models: Optional[ModelsPatch] = None
    github: Optional[GithubPatch] = None
    safety: Optional[SafetyPatch] = None
    brief: Optional[BriefPatch] = None
    follow_ups: Optional[FollowUpPatch] = None
    archive: Optional[ArchivePatch] = None
    telemetry: Optional[TelemetryPatch] = None
    mcp: Optional[McpPatch] = None
    teams_web: Optional[TeamsWebPatch] = None
    ui: Optional[UiPatch] = None


def _int(value, default: int, lo: int, hi: int) -> int:
    try:
        return min(hi, max(lo, int(value)))
    except (TypeError, ValueError):
        return default


def _hhmm(value, default: str) -> str:
    return value if isinstance(value, str) and re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value) else default


def _models(brain: dict) -> ModelSettings:
    claude, copilot = brain.get("claude", {}) or {}, brain.get("copilot", {}) or {}
    levels = ("low", "medium", "high", "xhigh", "max")
    effort, cop_effort = claude.get("effort", ""), copilot.get("effort", "low")
    try:
        return ModelSettings(claude_model=claude.get("model", "haiku"), copilot_model=copilot.get("model", "gpt-6-luna"),
                             claude_effort=effort if effort in levels else "",
                             copilot_effort=cop_effort if cop_effort in levels else "")
    except ValueError:
        return ModelSettings()


def from_config(cfg: dict) -> Settings:
    """Tolerates hand-edited config.json: out-of-range or wrong-typed values fall back
    to safe values instead of breaking the settings API."""
    gh = cfg.get("context", {}).get("github", {})
    safety = cfg.get("safety", {})
    reply = cfg.get("reply", {})
    brief = cfg.get("brief", {})
    return Settings(
        onboarded=bool(cfg.get("onboarded", False)),
        brain="copilot" if cfg.get("brain", {}).get("provider") == "copilot" else "claude",
        models=_models(cfg.get("brain", {})),
        github=GithubSettings(enabled=bool(gh.get("enabled", True)), all_repos=gh.get("repos", "all") == "all",
                              write=_github_write(gh.get("write", {}) or {})),
        safety=SafetySettings(
            auto_pause_on_screen_share=bool(safety.get("auto_pause_on_screen_share", True)),
            selftest_gate=bool(reply.get("selector_selftest_gate", True)),
            countdown_seconds=_int(reply.get("auto_send_countdown_seconds", 5), 5, 0, 60),
            never_auto_send_if_message_contains=[
                t for t in safety.get("never_auto_send_if_message_contains", []) if isinstance(t, str)
            ],
            mark_auto_replies=bool(safety.get("mark_auto_replies", True)),
            auto_max_per_hour=_int(safety.get("auto_max_per_hour", 5), 5, 0, 60),
            auto_quiet_hours=bool(safety.get("auto_quiet_hours", False)),
            auto_quiet_from=_hhmm(safety.get("auto_quiet_from"), "19:00"),
            auto_quiet_to=_hhmm(safety.get("auto_quiet_to"), "08:00"),
            auto_weekends=bool(safety.get("auto_weekends", True)),
        ),
        brief=BriefSettings(
            enabled=bool(brief.get("enabled", True)),
            last_messages=_int(brief.get("last_messages", 30), 30, 10, 100),
        ),
        follow_ups=FollowUpSettings(enabled=bool((cfg.get("follow_ups") or {}).get("enabled", True)),
                                    delay_hours=follow_up_delay(cfg.get("follow_ups") or {})),
        archive=ArchiveSettings(after_days=archive_after(cfg.get("archive") or {}),
                                hide_in_teams=bool((cfg.get("archive") or {}).get("hide_in_teams", False))),
        telemetry=_telemetry(cfg.get("telemetry", {})),
        teams_web=TeamsWebSettings(enabled=True),
        mcp=McpSettings(enabled=bool(cfg.get("mcp", {}).get("enabled", False)), token=str(cfg.get("mcp", {}).get("token", "") or ""),
                        allow_send=bool(cfg.get("mcp", {}).get("allow_send", False))),
        ui=_ui(cfg.get("ui", {})),
    )


def _github_write(w: dict) -> GithubWriteSettings:
    """Tolerates hand-edited config: a bad value falls back to the safe default
    (write off), never breaking the settings API."""
    try:
        return GithubWriteSettings(
            enabled=bool(w.get("enabled", False)),
            all_repos=w.get("repos", "allowlist") == "all",
            repos_allowlist=[r for r in w.get("repos_allowlist", []) if isinstance(r, str)],
            path_template=str(w.get("path_template") or DEFAULT_PATH_TEMPLATE),
            draft=bool(w.get("draft", True)),
        )
    except ValueError:
        return GithubWriteSettings()


def _ui(u: dict) -> UiSettings:
    sort = u.get("conversation_sort") if isinstance(u, dict) else None
    return UiSettings(conversation_sort=sort) if sort in ("watched", "recent", "alpha") else UiSettings()


def _telemetry(t: dict) -> TelemetrySettings:
    try:
        return TelemetrySettings(enabled=bool(t.get("enabled", False)), endpoint=str(t.get("endpoint", "") or ""),
                                 include_content=bool(t.get("include_content", False)))
    except Exception:
        return TelemetrySettings()


def _merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def apply(cfg: dict, patch: SettingsPatch) -> tuple[dict, Settings]:
    """Deep-merge a partial settings patch and map it back onto the config.json keys."""
    raw = patch.model_dump(exclude_unset=True, exclude_none=True)
    regenerate = bool(raw.get("mcp", {}).pop("regenerate_token", False))
    merged = Settings.model_validate(_merge(from_config(cfg).model_dump(), raw))
    if merged.mcp.enabled and (regenerate or not merged.mcp.token):
        merged.mcp.token = secrets.token_urlsafe(24)
    out = copy.deepcopy(cfg)
    out["onboarded"] = merged.onboarded
    brain_cfg = out.setdefault("brain", {})
    brain_cfg["provider"] = merged.brain
    claude = brain_cfg.setdefault("claude", {})
    claude["model"], claude["effort"] = merged.models.claude_model, merged.models.claude_effort
    copilot = brain_cfg.setdefault("copilot", {})
    copilot["model"], copilot["effort"] = merged.models.copilot_model, merged.models.copilot_effort
    gh = out.setdefault("context", {}).setdefault("github", {})
    gh["enabled"] = merged.github.enabled
    gh["repos"] = "all" if merged.github.all_repos else "allowlist"
    gh.setdefault("repos_allowlist", [])
    w = gh.setdefault("write", {})
    w["enabled"] = merged.github.write.enabled
    w["repos"] = "all" if merged.github.write.all_repos else "allowlist"
    w["repos_allowlist"] = merged.github.write.repos_allowlist
    w["path_template"] = merged.github.write.path_template
    w["draft"] = merged.github.write.draft
    w.setdefault("repo_map", {})  # meeting title → repo, learned on publish; kept across edits
    reply = out.setdefault("reply", {})
    reply["selector_selftest_gate"] = merged.safety.selftest_gate
    reply["auto_send_countdown_seconds"] = merged.safety.countdown_seconds
    safety = out.setdefault("safety", {})
    safety["auto_pause_on_screen_share"] = merged.safety.auto_pause_on_screen_share
    safety["never_auto_send_if_message_contains"] = merged.safety.never_auto_send_if_message_contains
    safety["mark_auto_replies"] = merged.safety.mark_auto_replies
    for key in ("auto_max_per_hour", "auto_quiet_hours", "auto_quiet_from", "auto_quiet_to", "auto_weekends"):
        safety[key] = getattr(merged.safety, key)
    out["brief"] = {**out.get("brief", {}), **merged.brief.model_dump()}
    out["follow_ups"] = merged.follow_ups.model_dump()
    out["archive"] = merged.archive.model_dump()
    out["telemetry"] = merged.telemetry.model_dump()
    out["mcp"] = merged.mcp.model_dump()
    out["teams_web"] = merged.teams_web.model_dump()
    ui = out.get("ui")
    out["ui"] = {**(ui if isinstance(ui, dict) else {}), **merged.ui.model_dump()}
    return out, merged
