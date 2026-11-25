from __future__ import annotations
import json
import threading
import time
import uuid
from datetime import datetime
from contextlib import contextmanager
from typing import Iterator, Callable, Iterable, Optional

import config as cfgmod
import safety
import settings as settingsmod
from github import context as gh
from models import AppState, Brief, BriefSources, Draft, IncomingMessage, LogItem, WatchEntity
from drivers.base import Focus, TeamsDriver
from brain.base import Brain
from brain.brief import BriefParseError, build_brief_prompt, parse_brief


class ActionError(Exception):
    """An API-triggered action failed; carries the HTTP status and a French message."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Watcher:
    """Owns the live state and the detection loop. The API reads `state`, the loop
    mutates it. Draft entities queue a proposal; auto entities type+send after a
    cancelable countdown handled by the delivery layer."""

    MAX_DRAFTS = 50
    BRIEF_TIMEOUT = 120.0

    def __init__(self, driver: TeamsDriver, brain: Brain, brain_factory: Optional[Callable[[dict], Brain]] = None):
        self.driver = driver
        self.brain = brain
        self.brain_factory = brain_factory
        self.cfg = cfgmod.load()
        self.soul = cfgmod.load_soul()
        self.state = AppState(
            onboarded=bool(self.cfg.get("onboarded", False)),
            brain=self.cfg.get("brain", {}).get("provider", "claude"),
            watchlist=[WatchEntity(**w) for w in self.cfg.get("watchlist", [])],
        )
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._ui_lock = threading.Lock()
        self._briefs: dict[str, Brief] = {}
        self._history: dict[str, tuple[float, str]] = {}
        self._in_flight: set[str] = set()
        self._sent_recent: dict[str, list[tuple[float, str]]] = {}

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
        self._process(msg)

    def _process(self, msg: IncomingMessage, force_draft: bool = False) -> Optional[str]:
        """Run one message through the pipeline. Returns "draft", "sent" or None."""
        if self.state.paused:
            return None
        cfg = self.cfg
        if cfg.get("safety", {}).get("auto_pause_on_screen_share", True) and self._screen_sharing():
            self.state.screen_sharing = True
            self.log("warn", "Partage d'écran détecté → veille en pause automatique")
            return None
        self.state.screen_sharing = False

        entity = next((w for w in self.state.watchlist if w.thread_id == msg.thread_id and w.watch), None)
        if entity is None:
            return None
        triggers = cfg.get("triggers", {})
        self_names = triggers.get("self_names", ["Damien"])
        if self._is_own_message(msg, self_names):
            return None
        if not safety.should_react(entity.surface.value, msg.mentions, entity.named_people, triggers, self_names):
            return None

        ctx = cfg.get("context", {})
        gh_cfg = ctx.get("github", {})
        gh_ctx = ""
        if gh_cfg.get("enabled", True) and gh.is_relevant(msg.text):
            repos = gh.list_repos() if gh_cfg.get("repos", "all") == "all" else gh_cfg.get("repos_allowlist", [])
            gh_ctx = gh.fetch(msg.text, repos, True)
        summary = self._summary(msg.thread_id, ctx.get("last_messages", 15))

        try:
            proposal = self.brain.draft(self.soul, summary, msg.text, gh_ctx)
        except Exception as e:
            self.log("warn", f"Rédaction impossible: {e}")
            return None

        mode = "draft" if force_draft else entity.mode
        gate = cfg.get("reply", {}).get("selector_selftest_gate", True)
        filt = cfg.get("safety", {}).get("never_auto_send_if_message_contains", [])
        if mode == "auto" and (
            (gate and not self.state.selftest_ok)
            or safety.blocked_by_filter(proposal, filt)
            or safety.blocked_by_filter(msg.text, filt)
        ):
            mode = "draft"

        gh_ref = gh_ctx.splitlines()[0] if gh_ctx else None

        if mode == "auto":
            secs = cfg.get("reply", {}).get("auto_send_countdown_seconds", 5)
            self.log("info", f"Envoi auto dans {secs}s → {msg.sender} (annulable via pause)")
            if not self._countdown_ok(secs):
                self._queue_draft(msg, proposal, entity.mode, gh_ref)
                self.log("warn", f"Envoi auto annulé → gardé en brouillon ({msg.sender})")
                return "draft"
            if self._deliver(msg.thread_id, proposal, send=True, restore=True, auto=True):
                self.log("sent", f"Auto → {msg.sender} : « {proposal[:60]} »")
                return "sent"
            self._queue_draft(msg, proposal, entity.mode, gh_ref)
            self.log("warn", f"Envoi auto non effectué → gardé en brouillon ({msg.sender})")
            return "draft"
        self._queue_draft(msg, proposal, entity.mode, gh_ref)
        self.log("draft", f"Brouillon déposé → {msg.sender}")
        return "draft"

    def _countdown_ok(self, seconds: float) -> bool:
        """Wait the cancelable window. Pausing (or stopping) during it cancels the send."""
        steps = max(1, int(seconds / 0.1))
        for i in range(steps):
            if self._stop.is_set() or self.state.paused:
                return False
            if i % 10 == 0 and self._screen_share_guarded():
                self.state.screen_sharing = True
                return False
            threading.Event().wait(0.1)
        return not (self._stop.is_set() or self.state.paused)

    SELF_ECHO_TTL = 600.0

    def _is_own_message(self, msg: IncomingMessage, self_names: list[str]) -> bool:
        """The user's own messages, and the replies Trame just sent, must never trigger
        a reply (an auto-mode conversation would otherwise answer itself forever)."""
        sender = (msg.sender or "").strip().casefold()
        if sender and any(sender == n.strip().casefold() for n in self_names if n.strip()):
            return True
        now = time.monotonic()
        with self._lock:
            recent = [(t, x) for t, x in self._sent_recent.get(msg.thread_id, []) if now - t < self.SELF_ECHO_TTL]
            self._sent_recent[msg.thread_id] = recent
        text = msg.text.strip()
        return any(text == x for _t, x in recent)

    def _remember_sent(self, thread_id: str, text: str) -> None:
        with self._lock:
            self._sent_recent.setdefault(thread_id, []).append((time.monotonic(), text.strip()))
            self._sent_recent[thread_id] = self._sent_recent[thread_id][-10:]

    def _deliver(self, thread_id: str, text: str, send: bool, restore: bool, auto: bool = False) -> bool:
        """Type into thread_id through the driver's guard. False on any doubt or error.
        restore=True puts the user's previous conversation back afterwards. Pause (for
        automatic sends) and screen share are re-checked under the UI lock, right before
        typing: either may have started during the LLM call, the countdown or the wait."""
        with self._ui_lock:
            if auto and (self.state.paused or self._stop.is_set()):
                self.log("warn", "Envoi auto annulé : Trame a été mis en pause.")
                return False
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                self.log("warn", "Partage d'écran en cours : aucune saisie dans Teams.")
                return False
            try:
                focus = self.driver.type_focused(thread_id, text, send, restore)
            except Exception as e:
                self.log("warn", f"Saisie impossible: {e}")
                return False
            if focus.ok and send:
                self._remember_sent(thread_id, text)
        self._warn_if_not_restored(focus)
        return focus.ok

    def _warn_if_not_restored(self, focus: Focus) -> None:
        if focus.restored is False:
            self.log("warn", "Impossible de rouvrir la conversation que tu regardais dans Teams.")

    def _screen_sharing(self) -> bool:
        try:
            return self.driver.is_screen_sharing()
        except Exception:
            return False

    def _queue_draft(self, msg: IncomingMessage, proposal: str, mode: str, gh_ref: str | None) -> None:
        with self._lock:
            # One pending draft per thread: the latest message supersedes the older proposal.
            # It keeps the previous draft's id so a card being edited in the UI is updated in
            # place (and its send still resolves) — unless that draft is being sent right now.
            previous = next((d for d in self.state.drafts if d.thread_id == msg.thread_id), None)
            draft_id = previous.id if previous and previous.id not in self._in_flight else str(uuid.uuid4())[:8]
            drafts = [d for d in self.state.drafts if d.thread_id != msg.thread_id or d.id in self._in_flight]
            drafts = drafts[: self.MAX_DRAFTS - 1]
            drafts.insert(0, Draft(
                id=draft_id, thread_id=msg.thread_id, **{"from": msg.sender},
                surface=msg.surface, incoming=msg.text, proposal=proposal,
                received_at=msg.received_at, mode=mode,  # type: ignore[arg-type]
                used_github=gh_ref,
            ))
            self.state.drafts = drafts

    # --- actions from the API ---
    def _draft(self, draft_id: str) -> Draft:
        d = next((x for x in self.state.drafts if x.id == draft_id), None)
        if d is None:
            raise ActionError(404, "Brouillon introuvable.")
        return d

    def _screen_share_guarded(self) -> bool:
        return bool(self.cfg.get("safety", {}).get("auto_pause_on_screen_share", True) and self._screen_sharing())

    def _typing_allowed(self) -> None:
        if self._screen_share_guarded():
            self.state.screen_sharing = True
            raise ActionError(409, "Partage d'écran en cours : aucune saisie dans Teams.")

    @contextmanager
    def _claim(self, draft_id: str) -> Iterator[Draft]:
        """One action at a time per draft: a double click cannot send it twice."""
        with self._lock:
            d = self._draft(draft_id)
            if draft_id in self._in_flight:
                raise ActionError(409, "Ce brouillon est déjà en cours d'envoi.")
            self._in_flight.add(draft_id)
        try:
            yield d
        finally:
            with self._lock:
                self._in_flight.discard(draft_id)

    def send_draft(self, draft_id: str, text: Optional[str] = None) -> None:
        with self._claim(draft_id) as d:
            body = text.strip() if text and text.strip() else d.proposal
            self._typing_allowed()
            if not self._deliver(d.thread_id, body, send=True, restore=True):
                with self._lock:
                    d.proposal = body
                self.log("warn", f"Envoi refusé : conversation de {d.from_} non confirmée → brouillon conservé")
                raise ActionError(409, "Impossible de confirmer la conversation dans Teams : rien n'a été envoyé, le brouillon est conservé.")
            with self._lock:
                self.state.drafts = [x for x in self.state.drafts if x is not d]
        self.log("sent", f"Envoyé à {d.from_}")

    def compose_draft(self, draft_id: str, text: Optional[str] = None) -> None:
        with self._claim(draft_id) as d:
            body = text.strip() if text and text.strip() else d.proposal
            self._typing_allowed()
            with self._lock:
                d.proposal = body
            if not self._deliver(d.thread_id, body, send=False, restore=False):
                self.log("warn", f"Saisie refusée : conversation de {d.from_} non confirmée")
                raise ActionError(409, "Impossible de confirmer la conversation dans Teams : rien n'a été saisi.")
        self.log("info", f"Brouillon saisi dans Teams pour {d.from_} (à valider dans Teams)")

    def dismiss_draft(self, draft_id: str) -> None:
        with self._lock:
            self.state.drafts = [x for x in self.state.drafts if x.id != draft_id]

    def catchup(self) -> int:
        """Process unread messages of watched threads, always as drafts (never auto-send)."""
        if self.state.paused:
            raise ActionError(409, "Trame est en pause : rattrapage impossible.")
        watched = [w.thread_id for w in self.state.watchlist if w.watch]
        try:
            unread = self.driver.list_unread(watched)
        except Exception as e:
            raise ActionError(502, f"Lecture des non-lus impossible: {e}")
        queued = sum(1 for m in unread if self._process(m, force_draft=True) == "draft")
        self.log("info", f"Rattrapage : {queued} brouillon(s) sur {len(unread)} non-lu(s)")
        return queued

    def set_paused(self, paused: bool) -> None:
        self.state.paused = paused

    def _entity(self, thread_id: str) -> WatchEntity:
        entity = next((w for w in self.state.watchlist if w.thread_id == thread_id), None)
        if entity is None:
            raise ActionError(404, "Conversation introuvable dans la watchlist.")
        return entity

    def set_watch(self, thread_id: str, watch: bool) -> None:
        with self._lock:
            self._entity(thread_id).watch = watch
        self._persist_watchlist()

    def set_mode(self, thread_id: str, mode: str) -> None:
        with self._lock:
            self._entity(thread_id).mode = mode  # type: ignore[assignment]
        self._persist_watchlist()

    def upsert_watchlist(self, items: Iterable[tuple[str, Optional[bool], Optional[str]]]) -> int:
        """Bulk (thread_id, watch, mode) update. Unknown ids are added only if Teams lists them."""
        known: Optional[dict[str, WatchEntity]] = None
        count = 0
        with self._lock:
            self._last_missing: list[str] = []
            by_id = {w.thread_id: w for w in self.state.watchlist}
            added: list[WatchEntity] = []
            for thread_id, watch, mode in items:
                entity = by_id.get(thread_id)
                if entity is None:
                    if known is None:
                        try:
                            known = {c.thread_id: c for c in self.driver.list_conversations()}
                        except Exception:
                            known = {}
                    if thread_id not in known:
                        self._last_missing.append(thread_id)
                        continue
                    entity = known[thread_id].model_copy()
                    by_id[thread_id] = entity
                    added.append(entity)
                if watch is not None:
                    entity.watch = watch
                if mode is not None:
                    entity.mode = mode  # type: ignore[assignment]
                count += 1
            self.state.watchlist = self.state.watchlist + added
        self._persist_watchlist()
        return count

    def _persist_watchlist(self) -> None:
        with self._lock:
            cfg = dict(self.cfg)
            cfg["watchlist"] = [json.loads(w.model_dump_json()) for w in self.state.watchlist]
            self.cfg = cfg
            try:
                cfgmod.save(cfg)
            except Exception as e:
                self.log("warn", f"Sauvegarde de la watchlist impossible: {e}")

    # --- conversation brief ---
    def _conversation(self, thread_id: str) -> WatchEntity:
        entity = next((w for w in self.state.watchlist if w.thread_id == thread_id), None)
        if entity is None:
            try:
                entity = next((c for c in self.driver.list_conversations() if c.thread_id == thread_id), None)
            except Exception:
                entity = None
        if entity is None:
            raise ActionError(404, "Conversation introuvable.")
        return entity

    def generate_brief(self, thread_id: str, last_messages: Optional[int] = None) -> Brief:
        """Summarise one conversation with a single brain call, then look up related
        GitHub items read-only. Cached in memory only on success."""
        entity = self._conversation(thread_id)
        prefs = self.get_settings()
        if not prefs.brief.enabled:
            raise ActionError(409, "Le résumé de conversation est désactivé dans les réglages.")
        name = entity.display_name
        msgs = self._read_focused(thread_id, name, last_messages or prefs.brief.last_messages)
        if not msgs:
            self.log("warn", f"Résumé impossible pour {name} : aucun message lisible")
            raise ActionError(502, "Aucun message lisible dans cette conversation : rien n'a été résumé.")
        transcript = "\n".join(f"[{m.received_at}] {m.sender}: {m.text}" if m.received_at else f"{m.sender}: {m.text}" for m in msgs)

        try:
            raw = self.brain.complete(build_brief_prompt(name, transcript), timeout=self.BRIEF_TIMEOUT)
        except Exception as e:
            self.log("warn", f"Résumé impossible pour {name} : le cerveau a échoué ({str(e)[:120]})")
            raise ActionError(502, "Le cerveau n'a pas pu produire le résumé. Rien n'a été perdu, tu peux réessayer.")
        try:
            digest = parse_brief(raw)
        except BriefParseError as e:
            self.log("warn", f"Résumé impossible pour {name} : {e}")
            raise ActionError(502, "Réponse du cerveau inexploitable pour le résumé. Rien n'a été perdu, tu peux réessayer.")

        hits: list = []
        repos_searched = 0
        if prefs.github.enabled:
            numbers = gh.mentioned_numbers(transcript)
            if numbers or digest.search_queries:
                gh_cfg = self.cfg.get("context", {}).get("github", {})
                try:
                    repos = gh.scope(prefs.github.all_repos, gh_cfg.get("repos_allowlist", []))
                    hits = gh.search(digest.search_queries, numbers, repos, prefs.github.all_repos, transcript)
                    repos_searched = len(repos)
                except Exception as e:
                    self.log("warn", f"Recherche GitHub impossible pour le résumé de {name} : {e}")

        brief = Brief(
            thread_id=thread_id,
            display_name=name,
            generated_at=datetime.now().strftime("%H:%M"),
            summary=digest.summary,
            open_points=digest.open_points,
            topics=digest.topics,
            github_enabled=prefs.github.enabled,
            github=hits,
            sources=BriefSources(messages=len(msgs), repos_searched=repos_searched),
        )
        with self._lock:
            self._briefs[thread_id] = brief
        gh_part = f", {len(hits)} élément(s) GitHub" if prefs.github.enabled else ""
        self.log("info", f"Résumé généré pour {name} ({len(msgs)} message(s){gh_part})")
        return brief

    def _read_focused(self, thread_id: str, name: str, last_n: int) -> list[IncomingMessage]:
        """Open the conversation just long enough to read it, then reopen the previous one."""
        with self._ui_lock:
            if self.driver._current() != thread_id and self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame n'ouvre pas d'autre conversation dans Teams.")
            msgs: list[IncomingMessage] = []
            try:
                with self.driver.focused(thread_id, restore=True) as focus:
                    if focus.ok:
                        msgs = self.driver.read_context(thread_id, last_n)
            except Exception as e:
                self.log("warn", f"Résumé impossible pour {name} : lecture de la conversation échouée ({e})")
                raise ActionError(502, "Lecture de la conversation impossible dans Teams. Rien n'a été perdu, tu peux réessayer.")
        self._warn_if_not_restored(focus)
        if not focus.ok:
            self.log("warn", f"Résumé impossible pour {name} : conversation non confirmée dans Teams")
            raise ActionError(409, f"Impossible d'ouvrir la conversation « {name} » dans Teams : rien n'a été résumé.")
        return msgs

    def cached_brief(self, thread_id: str) -> Optional[Brief]:
        """Last brief of a known conversation, None if none was generated yet."""
        self._conversation(thread_id)
        return self._briefs.get(thread_id)

    # --- settings & persona ---
    def get_settings(self) -> settingsmod.Settings:
        return settingsmod.from_config(self.cfg)

    def update_settings(self, patch: settingsmod.SettingsPatch) -> settingsmod.Settings:
        with self._lock:
            new_cfg, merged = settingsmod.apply(self.cfg, patch)
            new_brain = None
            if merged.brain != self.get_settings().brain and self.brain_factory is not None:
                try:
                    new_brain = self.brain_factory(new_cfg)
                except Exception as e:
                    raise ActionError(500, f"Changement de cerveau impossible: {e}")
            try:
                cfgmod.save(new_cfg)
            except Exception as e:
                raise ActionError(500, f"Sauvegarde des réglages impossible: {e}")
            self.cfg = new_cfg
            if new_brain is not None:
                self.brain = new_brain
                self.log("info", f"Cerveau changé → {merged.brain}")
            self.state.brain = merged.brain
            self.state.onboarded = merged.onboarded
            return merged

    def set_soul(self, content: str) -> None:
        with self._lock:
            try:
                cfgmod.save_soul(content)
            except Exception as e:
                raise ActionError(500, f"Écriture du persona impossible: {e}")
            if self.cfg.get("persona", {}).get("active_soul", "SOUL.md") != "SOUL.md":
                cfg = dict(self.cfg)
                cfg["persona"] = {**cfg.get("persona", {}), "active_soul": "SOUL.md"}
                cfgmod.save(cfg)
                self.cfg = cfg
            self.soul = content
        self.log("info", "Persona mis à jour")

    # --- helpers ---
    HISTORY_TTL = 120.0

    def _summary(self, thread_id: str, last_n: int) -> str:
        """History for drafting. Opens the conversation just long enough to read it
        and reopens the previous one; reused for HISTORY_TTL so a burst of messages
        doesn't keep switching the user's view. Never switches during a screen share."""
        cached = self._history.get(thread_id)
        if cached and time.monotonic() - cached[0] < self.HISTORY_TTL:
            return cached[1]
        msgs: list[IncomingMessage] = []
        try:
            with self._ui_lock:
                if self.driver._current() == thread_id:
                    msgs = self.driver.read_context(thread_id, last_n)
                elif self._screen_share_guarded():
                    return ""
                else:
                    with self.driver.focused(thread_id, restore=True) as focus:
                        if focus.ok:
                            msgs = self.driver.read_context(thread_id, last_n)
                    self._warn_if_not_restored(focus)
        except Exception:
            return ""
        text = "\n".join(f"{m.sender}: {m.text}" for m in msgs)
        if text:
            self._history[thread_id] = (time.monotonic(), text)
        return text

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
        self.state.logs = [LogItem(at=datetime.now().strftime("%H:%M:%S"), level=level, text=text), *self.state.logs][:200]
