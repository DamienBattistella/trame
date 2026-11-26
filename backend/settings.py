from __future__ import annotations
import copy
import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

BrainName = Literal["claude", "copilot"]


class GithubSettings(BaseModel):
    enabled: bool
    all_repos: bool


class SafetySettings(BaseModel):
    auto_pause_on_screen_share: bool
    selftest_gate: bool
    countdown_seconds: int = Field(ge=0, le=60)
    never_auto_send_if_message_contains: list[str]

    @field_validator("never_auto_send_if_message_contains")
    @classmethod
    def _clean(cls, v: list[str]) -> list[str]:
        return [t.strip() for t in v if t.strip()]


class BriefSettings(BaseModel):
    enabled: bool
    last_messages: int = Field(ge=10, le=100)


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


class Settings(BaseModel):
    onboarded: bool
    brain: BrainName
    github: GithubSettings
    safety: SafetySettings
    brief: BriefSettings
    telemetry: TelemetrySettings = TelemetrySettings()


class _Patch(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GithubPatch(_Patch):
    enabled: Optional[bool] = None
    all_repos: Optional[bool] = None


class SafetyPatch(_Patch):
    auto_pause_on_screen_share: Optional[bool] = None
    selftest_gate: Optional[bool] = None
    countdown_seconds: Optional[int] = Field(default=None, ge=0, le=60)
    never_auto_send_if_message_contains: Optional[list[str]] = None


class BriefPatch(_Patch):
    enabled: Optional[bool] = None
    last_messages: Optional[int] = Field(default=None, ge=10, le=100)


class TelemetryPatch(_Patch):
    enabled: Optional[bool] = None
    endpoint: Optional[str] = Field(default=None, max_length=300)
    include_content: Optional[bool] = None


class SettingsPatch(_Patch):
    onboarded: Optional[bool] = None
    brain: Optional[BrainName] = None
    github: Optional[GithubPatch] = None
    safety: Optional[SafetyPatch] = None
    brief: Optional[BriefPatch] = None
    telemetry: Optional[TelemetryPatch] = None


def _int(value, default: int, lo: int, hi: int) -> int:
    try:
        return min(hi, max(lo, int(value)))
    except (TypeError, ValueError):
        return default


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
        github=GithubSettings(enabled=bool(gh.get("enabled", True)), all_repos=gh.get("repos", "all") == "all"),
        safety=SafetySettings(
            auto_pause_on_screen_share=bool(safety.get("auto_pause_on_screen_share", True)),
            selftest_gate=bool(reply.get("selector_selftest_gate", True)),
            countdown_seconds=_int(reply.get("auto_send_countdown_seconds", 5), 5, 0, 60),
            never_auto_send_if_message_contains=[
                t for t in safety.get("never_auto_send_if_message_contains", []) if isinstance(t, str)
            ],
        ),
        brief=BriefSettings(
            enabled=bool(brief.get("enabled", True)),
            last_messages=_int(brief.get("last_messages", 30), 30, 10, 100),
        ),
        telemetry=_telemetry(cfg.get("telemetry", {})),
    )


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
    merged = Settings.model_validate(_merge(from_config(cfg).model_dump(), patch.model_dump(exclude_unset=True, exclude_none=True)))
    out = copy.deepcopy(cfg)
    out["onboarded"] = merged.onboarded
    out.setdefault("brain", {})["provider"] = merged.brain
    gh = out.setdefault("context", {}).setdefault("github", {})
    gh["enabled"] = merged.github.enabled
    gh["repos"] = "all" if merged.github.all_repos else "allowlist"
    gh.setdefault("repos_allowlist", [])
    reply = out.setdefault("reply", {})
    reply["selector_selftest_gate"] = merged.safety.selftest_gate
    reply["auto_send_countdown_seconds"] = merged.safety.countdown_seconds
    safety = out.setdefault("safety", {})
    safety["auto_pause_on_screen_share"] = merged.safety.auto_pause_on_screen_share
    safety["never_auto_send_if_message_contains"] = merged.safety.never_auto_send_if_message_contains
    out["brief"] = {**out.get("brief", {}), **merged.brief.model_dump()}
    out["telemetry"] = merged.telemetry.model_dump()
    return out, merged
