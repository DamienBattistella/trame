from __future__ import annotations
import json
import threading
import uuid
from datetime import datetime

import config as cfgmod
import safety
from github import context as gh
from models import AppState, Draft, IncomingMessage, LogItem, WatchEntity
from drivers.base import TeamsDriver
from brain.base import Brain


class Watcher:
    """Owns the live state and the detection loop. The API reads `state`, the loop
    mutates it. Draft entities queue a proposal; auto entities type+send after a
    cancelable countdown handled by the delivery layer."""

    def __init__(self, driver: TeamsDriver, brain: Brain):
        self.driver = driver
        self.brain = brain
        self.cfg = cfgmod.load()
        self.soul = cfgmod.load_soul()
        self.state = AppState(
            brain=self.cfg.get("brain", {}).get("provider", "claude"),
            watchlist=[WatchEntity(**w) for w in self.cfg.get("watchlist", [])],
        )
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # --- lifecycle ---
    def start(self) -> None:
        self.state.selftest_ok = self.driver.selftest()
        self.log("info", f"Auto-test des sélecteurs : {'OK' if self.state.selftest_ok else 'ÉCHEC → repli brouillon'}")
        try:
            self.state.watchlist = self._merge(self.driver.list_conversations())
        except Exception:
            pass
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        self.driver.watch(self._on_message, self._stop.is_set)

    # --- core reaction ---
    def _on_message(self, msg: IncomingMessage) -> None:
        if self.state.paused:
            return
        if self.cfg.get("safety", {}).get("auto_pause_on_screen_share", True) and self.driver.is_screen_sharing():
            self.state.screen_sharing = True
            self.log("warn", "Partage d'écran détecté → veille en pause automatique")
            return
        self.state.screen_sharing = False

        entity = next((w for w in self.state.watchlist if w.thread_id == msg.thread_id and w.watch), None)
        if entity is None:
            return
        triggers = self.cfg.get("triggers", {})
        self_names = triggers.get("self_names", ["Damien"])
        if not safety.should_react(entity.surface.value, msg.mentions, entity.named_people, triggers, self_names):
            return

        ctx = self.cfg.get("context", {})
        repos = gh.list_repos() if ctx.get("github", {}).get("repos") == "all" else ctx.get("github", {}).get("repos_allowlist", [])
        gh_ctx = gh.fetch(msg.text, repos, ctx.get("github", {}).get("enabled", True))
        summary = self._summary(msg.thread_id, ctx.get("last_messages", 15))

        try:
            proposal = self.brain.draft(self.soul, summary, msg.text, gh_ctx)
        except Exception as e:
            self.log("warn", f"Rédaction impossible: {e}")
            return

        mode = entity.mode
        filt = self.cfg.get("safety", {}).get("never_auto_send_if_message_contains", [])
        if mode == "auto" and (not self.state.selftest_ok or safety.blocked_by_filter(proposal, filt)):
            mode = "draft"

        gh_ref = gh_ctx.splitlines()[0] if gh_ctx else None

        if mode == "auto":
            secs = self.cfg.get("reply", {}).get("auto_send_countdown_seconds", 5)
            self.log("info", f"Envoi auto dans {secs}s → {msg.sender} (annulable via pause)")
            if self._countdown_ok(secs):
                self.driver.type_reply(msg.thread_id, proposal, send=True)
                self.log("sent", f"Auto → {msg.sender} : « {proposal[:60]} »")
            else:
                self._queue_draft(msg, proposal, entity.mode, gh_ref)
                self.log("warn", f"Envoi auto annulé → gardé en brouillon ({msg.sender})")
        else:
            self._queue_draft(msg, proposal, entity.mode, gh_ref)
            self.log("draft", f"Brouillon déposé → {msg.sender}")

    def _countdown_ok(self, seconds: float) -> bool:
        """Wait the cancelable window. Pausing (or stopping) during it cancels the send."""
        steps = max(1, int(seconds / 0.1))
        for _ in range(steps):
            if self._stop.is_set() or self.state.paused:
                return False
            threading.Event().wait(0.1)
        return not (self._stop.is_set() or self.state.paused)

    def _queue_draft(self, msg: IncomingMessage, proposal: str, mode: str, gh_ref: str | None) -> None:
        self.state.drafts.insert(0, Draft(
            id=str(uuid.uuid4())[:8], thread_id=msg.thread_id, **{"from": msg.sender},
            surface=msg.surface, incoming=msg.text, proposal=proposal,
            received_at=msg.received_at, mode=mode,  # type: ignore[arg-type]
            used_github=gh_ref,
        ))

    # --- actions from the API ---
    def send_draft(self, draft_id: str) -> None:
        d = next((x for x in self.state.drafts if x.id == draft_id), None)
        if not d:
            return
        self.driver.type_reply(d.thread_id, d.proposal, send=True)
        self.state.drafts = [x for x in self.state.drafts if x.id != draft_id]
        self.log("sent", f"Envoyé à {d.from_}")

    def dismiss_draft(self, draft_id: str) -> None:
        self.state.drafts = [x for x in self.state.drafts if x.id != draft_id]

    def set_paused(self, paused: bool) -> None:
        self.state.paused = paused

    def set_watch(self, thread_id: str, watch: bool) -> None:
        for w in self.state.watchlist:
            if w.thread_id == thread_id:
                w.watch = watch
        self._persist_watchlist()

    def set_mode(self, thread_id: str, mode: str) -> None:
        for w in self.state.watchlist:
            if w.thread_id == thread_id:
                w.mode = mode  # type: ignore[assignment]
        self._persist_watchlist()

    def _persist_watchlist(self) -> None:
        cfg = cfgmod.load()
        cfg["watchlist"] = [json.loads(w.model_dump_json()) for w in self.state.watchlist]
        try:
            cfgmod.save(cfg)
        except Exception:
            pass

    # --- helpers ---
    def _summary(self, thread_id: str, last_n: int) -> str:
        try:
            msgs = self.driver.read_context(thread_id, last_n)
            return "\n".join(f"{m.sender}: {m.text}" for m in msgs)
        except Exception:
            return ""

    def _merge(self, discovered: list[WatchEntity]) -> list[WatchEntity]:
        by_id = {w.thread_id: w for w in self.state.watchlist}
        out: list[WatchEntity] = []
        for d in discovered:
            saved = by_id.get(d.thread_id)
            out.append(saved if saved else d)
        for w in self.state.watchlist:
            if w.thread_id not in {d.thread_id for d in discovered}:
                out.append(w)
        return out or self.state.watchlist

    def log(self, level, text: str) -> None:
        self.state.logs.insert(0, LogItem(at=datetime.now().strftime("%H:%M:%S"), level=level, text=text))
        self.state.logs = self.state.logs[:200]
