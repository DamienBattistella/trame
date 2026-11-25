from __future__ import annotations
import copy
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


class Settings(BaseModel):
    onboarded: bool
    brain: BrainName
    github: GithubSettings
    safety: SafetySettings


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


class SettingsPatch(_Patch):
    onboarded: Optional[bool] = None
    brain: Optional[BrainName] = None
    github: Optional[GithubPatch] = None
    safety: Optional[SafetyPatch] = None


def from_config(cfg: dict) -> Settings:
    gh = cfg.get("context", {}).get("github", {})
    safety = cfg.get("safety", {})
    reply = cfg.get("reply", {})
    return Settings(
        onboarded=bool(cfg.get("onboarded", False)),
        brain=cfg.get("brain", {}).get("provider", "claude"),
        github=GithubSettings(enabled=gh.get("enabled", True), all_repos=gh.get("repos", "all") == "all"),
        safety=SafetySettings(
            auto_pause_on_screen_share=safety.get("auto_pause_on_screen_share", True),
            selftest_gate=reply.get("selector_selftest_gate", True),
            countdown_seconds=reply.get("auto_send_countdown_seconds", 5),
            never_auto_send_if_message_contains=safety.get("never_auto_send_if_message_contains", []),
        ),
    )


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
    return out, merged
