from __future__ import annotations
import json
import os
import threading
import time
import uuid
from datetime import datetime
from contextlib import contextmanager
from typing import Iterator, Callable, Iterable, Optional

import config as cfgmod
import safety
import people as peoplemod
import telemetry
from drivers import rail_label
import settings as settingsmod
from github import context as gh
from models import AppState, Brief, BriefSources, Draft, IncomingMessage, LogItem, Notice, WatchEntity
from drivers.base import Focus, SendUncertain, TeamsDriver
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
        self.people = peoplemod.Directory.load()
        self._why = threading.local()
        self.telemetry_error = telemetry.configure(self.cfg.get("telemetry"))
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
        self._thread_cache: dict[str, tuple[float, list[dict]]] = {}
        self._in_flight: set[str] = set()
        self._sent_recent: dict[str, list[tuple[float, str]]] = {}

    # --- lifecycle ---
    def teams_ready(self, ready: bool) -> None:
        """Teams web signed in after the engine started (the usual case): mark Teams as
        checked and read its conversations, which were unknown until then."""
        if ready == self.state.selftest_ok:
            return
        self.state.selftest_ok = ready
        if not ready:
            self.log("warn", "Teams : connexion perdue, tout reste en brouillon")
            return
        self.log("info", "Teams connecté")
        if getattr(self.driver, "list_all_conversations", None) is None:
            self._read_conversations(self.driver.list_conversations)
            return
        # Teams only draws the beginning of its list: reading it all takes a few seconds
        # of scrolling, done aside so the caller is not kept waiting. What Teams shows
        # right now is only taken when nothing is known yet: merging that short list
        # would drop every other conversation until the full read lands.
        if not self.state.watchlist:
            self._read_conversations(self.driver.list_conversations)
        threading.Thread(target=self._read_conversations, args=(self.driver.list_all_conversations,),
                         daemon=True).start()

    def _read_conversations(self, read) -> None:
        try:
            discovered = read()
        except Exception:
            return
        with self._lock:
            self.state.watchlist = self._merge(discovered)
        self._persist_watchlist()

    def start(self) -> None:
        try:
            self.state.selftest_ok = bool(self.driver.selftest())
        except Exception:
            self.state.selftest_ok = False
        if not self.state.selftest_ok and getattr(self.driver, "waits_for_relay", False):
            self.log("info", "Teams : en attente de la fenêtre Teams de Trame")
        else:
            self.log("info", f"Vérification de Teams : {'OK' if self.state.selftest_ok else 'échec, tout reste en brouillon'}")
        try:
            self.state.watchlist = self._merge(self.driver.list_conversations())
            self._persist_watchlist()
        except Exception:
            pass
        if self.telemetry_error:
            self.log("warn", self.telemetry_error)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        self.driver.watch(self._on_message, self._stop.is_set)

    # --- core reaction ---
    MAX_NOTICES = 20

    def _on_message(self, msg: IncomingMessage) -> None:
        self._notice(msg)
        self._process(msg)

    def _notice(self, msg: IncomingMessage) -> None:
        """Announce a received message, followed conversation or not. Never the user's
        own messages nor the replies Trame just sent."""
        try:
            if self._is_own_message(msg, self.cfg.get("triggers", {}).get("self_names", ["Damien"])):
                return
            entity = next((w for w in self.state.watchlist if w.thread_id == msg.thread_id), None)
            notice = Notice(id=str(uuid.uuid4())[:8], thread_id=msg.thread_id,
                            conversation=entity.display_name if entity else msg.sender,
                            **{"from": msg.sender}, text=msg.text, at=msg.received_at, surface=msg.surface)
            with self._lock:
                self.state.notices = [notice, *self.state.notices][: self.MAX_NOTICES]
        except Exception:
            pass

    def _process(self, msg: IncomingMessage, force_draft: bool = False) -> Optional[str]:
        with telemetry.span("message", conversation=msg.thread_id, surface=msg.surface.value, force_draft=force_draft,
                            text=telemetry.content(msg.text)) as sp:
            outcome = self._process_inner(msg, force_draft)
            telemetry.set_attrs(sp, outcome=outcome or "ignored")
            return outcome

    def _process_inner(self, msg: IncomingMessage, force_draft: bool = False) -> Optional[str]:
        """Run one message through the pipeline. Returns "draft", "sent" or None."""
        if self.state.paused:
            return None
        cfg = self.cfg
        if cfg.get("safety", {}).get("auto_pause_on_screen_share", True) and self._screen_sharing():
            self.state.screen_sharing = True
            self.log("warn", "Partage d'écran : Trame se met en pause")
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
        # GitHub (network) and the conversation history (Teams UI) are independent: fetch
        # them side by side instead of one after the other.
        gh_result: list[str] = [""]
        gh_thread: threading.Thread | None = None
        if gh_cfg.get("enabled", True) and gh.is_relevant(msg.text):
            def _fetch_github() -> None:
                try:
                    repos = gh.list_repos() if gh_cfg.get("repos", "all") == "all" else gh_cfg.get("repos_allowlist", [])
                    with telemetry.span("github.fetch", repos=len(repos)):
                        gh_result[0] = gh.fetch(msg.text, repos, True)
                except Exception:
                    gh_result[0] = ""

            gh_thread = threading.Thread(target=_fetch_github, daemon=True)
            gh_thread.start()
        summary = self._summary(msg.thread_id, ctx.get("last_messages", 15))
        if gh_thread is not None:
            gh_thread.join()
        gh_ctx = gh_result[0]

        try:
            with telemetry.span("brain.draft", provider=self.state.brain, history_chars=len(summary),
                                github=bool(gh_ctx)):
                proposal = self.brain.draft(self.soul, summary, msg.text, gh_ctx, self._people_context(msg, summary))
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
            self.log("info", f"Réponse à {msg.sender} envoyée dans {secs} s (la pause l'annule)")
            if not self._countdown_ok(secs):
                self._queue_draft(msg, proposal, entity.mode, gh_ref)
                self.log("warn", f"Envoi à {msg.sender} annulé : réponse gardée en brouillon")
                return "draft"
            if self._deliver(msg.thread_id, proposal, send=True, restore=True, auto=True):
                self.log("sent", f"Envoyé à {msg.sender} : « {proposal[:60]} »")
                return "sent"
            self._queue_draft(msg, proposal, entity.mode, gh_ref)
            self.log("warn", f"Envoi à {msg.sender} non effectué : réponse gardée en brouillon")
            return "draft"
        self._queue_draft(msg, proposal, entity.mode, gh_ref)
        self.log("draft", f"Réponse à relire pour {msg.sender}")
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
        if sender in ("you", "vous", "moi") or (sender and any(sender == n.strip().casefold() for n in self_names if n.strip())):
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

    def _because(self) -> str:
        reason = getattr(self._why, "reason", None)
        return f" Raison : {reason}." if reason else " La conversation n'a pas pu être confirmée dans Teams."

    def _deliver(self, thread_id: str, text: str, send: bool, restore: bool, auto: bool = False) -> bool:
        """Type into thread_id through the driver's guard. False on any doubt or error.
        restore=True puts the user's previous conversation back afterwards. Pause (for
        automatic sends) and screen share are re-checked under the UI lock, right before
        typing: either may have started during the LLM call, the countdown or the wait."""
        self._why.reason = None
        with self._ui_lock:
            if auto and (self.state.paused or self._stop.is_set()):
                self.log("warn", "Envoi auto annulé : Trame a été mis en pause.")
                return False
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                self.log("warn", "Partage d'écran en cours : aucune saisie dans Teams.")
                return False
            try:
                with telemetry.span("teams.type", conversation=thread_id, send=send, auto=auto) as sp:
                    focus = self.driver.type_focused(thread_id, text, send, restore)
                    telemetry.set_attrs(sp, confirmed=focus.ok, restored=focus.restored)
            except SendUncertain as e:
                # Never report "nothing was sent" here: a resend could duplicate it.
                self._remember_sent(thread_id, text)
                self.log("warn", f"Envoi non confirmé, à vérifier dans Teams : {e}")
                if auto:
                    return False
                raise ActionError(409, "Envoi non confirmé : le message est peut-être parti. Vérifie dans Teams avant de renvoyer.")
            except Exception as e:
                self._why.reason = str(e)
                self.log("warn", f"Saisie impossible: {e}")
                return False
            if not focus.ok:
                self._why.reason = focus.reason
                if focus.reason:
                    self.log("warn", f"Saisie refusée : {focus.reason}")
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
                used_github=gh_ref, sender_label=self._sender_label(msg.sender),
            ))
            self.state.drafts = drafts
        # The discussion view rereads the conversation: its cached copy lacks this message.
        self._thread_cache.pop(msg.thread_id, None)

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
                self.log("warn", f"Envoi à {d.from_} refusé : conversation non confirmée, réponse conservée")
                raise ActionError(409, f"Rien n'a été envoyé, le brouillon est conservé.{self._because()}")
            with self._lock:
                self.state.drafts = [x for x in self.state.drafts if x is not d]
        self._history.pop(d.thread_id, None)
        self._thread_cache.pop(d.thread_id, None)
        self.log("sent", f"Envoyé à {d.from_}")

    def compose_draft(self, draft_id: str, text: Optional[str] = None) -> None:
        with self._claim(draft_id) as d:
            body = text.strip() if text and text.strip() else d.proposal
            self._typing_allowed()
            with self._lock:
                d.proposal = body
            if not self._deliver(d.thread_id, body, send=False, restore=False):
                self.log("warn", f"Saisie refusée : conversation de {d.from_} non confirmée")
                raise ActionError(409, f"Rien n'a été saisi dans Teams.{self._because()}")
        self.log("info", f"Brouillon saisi dans Teams pour {d.from_} (à valider dans Teams)")

    # --- manual mode: read a conversation, reply by hand, or ask for a proposal ---
    def _is_mine(self, sender: str) -> bool:
        names = self.cfg.get("triggers", {}).get("self_names", ["Damien"])
        s = (sender or "").strip().casefold()
        return s in ("you", "vous", "moi") or any(s == n.strip().casefold() for n in names if n.strip())

    def thread_messages(self, thread_id: str, last_n: int = 30, fresh: bool = False) -> list[dict]:
        """History shown in the discussion view. Kept HISTORY_TTL so that clicking
        around the sidebar does not keep switching the conversation open in Teams."""
        cached = self._thread_cache.get(thread_id)
        if cached and not fresh and time.monotonic() - cached[0] < self.HISTORY_TTL:
            return cached[1]
        entity = self._conversation(thread_id)
        msgs = self._read_focused(thread_id, entity.display_name, last_n, purpose="Lecture")
        out = [{"sender": m.sender, "text": m.text, "at": m.received_at, "mine": self._is_mine(m.sender)} for m in msgs]
        self._thread_cache[thread_id] = (time.monotonic(), out)
        return out

    def send_manual(self, thread_id: str, text: str) -> None:
        entity = self._conversation(thread_id)
        body = text.strip()
        if not body:
            raise ActionError(422, "Le message est vide.")
        self._typing_allowed()
        if not self._deliver(thread_id, body, send=True, restore=True):
            self.log("warn", f"Envoi à {entity.display_name} refusé.{self._because()}")
            raise ActionError(409, f"Rien n'a été envoyé à « {entity.display_name} ».{self._because()}")
        self._history.pop(thread_id, None)
        self._thread_cache.pop(thread_id, None)
        self.log("sent", f"Envoyé à {entity.display_name} : « {body[:60]} »")

    def suggest_reply(self, thread_id: str, last_n: int = 15) -> str:
        entity = self._conversation(thread_id)
        msgs = self._read_focused(thread_id, entity.display_name, last_n, purpose="Proposition")
        theirs = [m for m in msgs if not self._is_mine(m.sender)]
        if not theirs:
            raise ActionError(409, "Aucun message à qui répondre dans cette conversation.")
        last = theirs[-1]
        summary = "\n".join(f"{m.sender}: {m.text}" for m in msgs[:-1])
        try:
            reply = self.brain.draft(self.soul, summary, last.text, "", self._people_context(last, summary))
        except Exception as e:
            raise ActionError(502, f"Le cerveau n'a pas pu proposer de réponse : {e}")
        return reply.strip()

    def propose_external_reply(self, thread_id: str, text: str) -> Draft:
        """A reply prepared by an outside assistant (MCP): it waits in « À relire »,
        never sent without the user's click."""
        entity = self._conversation(thread_id)
        body = text.strip()
        if not body:
            raise ActionError(422, "La réponse proposée est vide.")
        msg = IncomingMessage(thread_id=thread_id, sender=entity.display_name, received_at=datetime.now().strftime("%H:%M"),
                              text="Réponse préparée par un assistant externe (MCP).", surface=entity.surface)
        self._queue_draft(msg, body[:4000], "draft", None)
        self.log("draft", f"Réponse proposée via MCP pour {entity.display_name}")
        return next(d for d in self.state.drafts if d.thread_id == thread_id)

    def show_in_teams(self, thread_id: str) -> None:
        """Open the conversation in Teams for the user (Trame types nothing)."""
        name = next((w.display_name for w in self.state.watchlist if w.thread_id == thread_id), thread_id)
        with self._ui_lock:
            try:
                ok = self.driver.show_thread(thread_id)
            except Exception:
                ok = False
        if not ok:
            raise ActionError(404, f"« {name} » est introuvable dans la liste de Teams. Fais-la défiler dans Teams puis réessaie.")

    def edit_draft(self, draft_id: str, text: str) -> Draft:
        body = (text or "").strip()
        if not body:
            raise ActionError(422, "La réponse est vide.")
        with self._lock:
            d = self._draft(draft_id)
            if draft_id in self._in_flight:
                raise ActionError(409, "Ce brouillon est en cours d'envoi.")
            d.proposal = body[:4000]
        return d

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

    def refresh_conversations(self) -> int:
        """Read the conversation list again from Teams (asked from Réglages › Conversations)."""
        read = getattr(self.driver, "list_all_conversations", self.driver.list_conversations)
        try:
            discovered = read()
        except Exception as e:
            raise ActionError(502, f"Teams n'a pas rendu la liste des conversations : {e}")
        if not discovered:
            raise ActionError(409, "Teams n'a rendu aucune conversation. La liste est gardée telle quelle.")
        with self._lock:
            self.state.watchlist = self._merge(discovered)
            count = len(self.state.watchlist)
        self._persist_watchlist()
        self.log("info", f"Conversations actualisées : {count}")
        return count

    def _persist_watchlist(self) -> None:
        with self._lock:
            cfg = dict(self.cfg)
            cfg["watchlist"] = [json.loads(w.model_dump_json(exclude={"rank", "last_activity", "unread", "is_self", "own_preview"}))
                                for w in self.state.watchlist]
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
            raw = self.brain.complete(build_brief_prompt(name, transcript),
                                      timeout=max(self.BRIEF_TIMEOUT, 2 * float(getattr(self.brain, "timeout", 0) or 0)))
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

    def _read_focused(self, thread_id: str, name: str, last_n: int, purpose: str = "Résumé") -> list[IncomingMessage]:
        """Open the conversation just long enough to read it, then reopen the previous one."""
        with self._ui_lock:
            if self.driver._current() != thread_id and self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame n'ouvre pas d'autre conversation dans Teams.")
            msgs: list[IncomingMessage] = []
            try:
                with telemetry.span("teams.read", conversation=name, purpose=purpose, last_n=last_n) as sp, \
                        self.driver.focused(thread_id, restore=True) as focus:
                    if focus.ok:
                        msgs = self.driver.read_context(thread_id, last_n)
                    telemetry.set_attrs(sp, confirmed=focus.ok, messages=len(msgs))
            except Exception as e:
                self.log("warn", f"{purpose} impossible pour {name} : lecture de la conversation échouée ({e})")
                raise ActionError(502, "Lecture de la conversation impossible dans Teams. Rien n'a été perdu, tu peux réessayer.")
        self._warn_if_not_restored(focus)
        if not focus.ok:
            self.log("warn", f"{purpose} impossible pour {name} : {focus.reason or 'conversation non confirmée dans Teams'}")
            raise ActionError(409, f"Impossible d'ouvrir la conversation « {name} » dans Teams.")
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
            try:
                new_cfg, merged = settingsmod.apply(self.cfg, patch)
            except ValueError as e:
                errors = getattr(e, "errors", lambda: [])()
                detail = errors[0].get("msg", str(e)) if errors else str(e)
                raise ActionError(422, f"Réglage invalide : {detail.removeprefix('Value error, ')}")
            new_brain = None
            before = self.get_settings()
            if (merged.brain, merged.models) != (before.brain, before.models) and self.brain_factory is not None:
                try:
                    new_brain = self.brain_factory(new_cfg)
                except Exception as e:
                    raise ActionError(500, f"Changement de cerveau impossible: {e}")
            try:
                cfgmod.save(new_cfg)
            except Exception as e:
                raise ActionError(500, f"Sauvegarde des réglages impossible: {e}")
            if new_cfg.get("telemetry") != self.cfg.get("telemetry"):
                self.telemetry_error = telemetry.configure(new_cfg.get("telemetry"))
            self.cfg = new_cfg
            if new_brain is not None:
                self.brain = new_brain
                self.log("info", f"Cerveau : {'Claude' if merged.brain == 'claude' else 'Copilot'}")
            self.state.brain = merged.brain
            self.state.onboarded = merged.onboarded
            return merged

    # --- entourage (who's who, exported from Orbite) ---
    def _people_context(self, msg: IncomingMessage, summary: str) -> str:
        """Cards of the sender, then of the other people speaking in the thread."""
        names = [msg.sender] + [line.split(":", 1)[0] for line in summary.splitlines() if ":" in line]
        return self.people.context(n for n in names if n.strip())

    def _sender_label(self, name: str) -> Optional[str]:
        p = self.people.find(name)
        return (peoplemod.Directory.label(p) or None) if p else None

    def people_summary(self) -> peoplemod.PeopleSummary:
        return self.people.summary()

    def set_people(self, content: str) -> peoplemod.PeopleSummary:
        if len(content.encode("utf-8")) > peoplemod.MAX_BYTES:
            raise ActionError(413, "Le fichier d'entourage dépasse 512 Ko.")
        try:
            directory = peoplemod.save(content)
        except ValueError as e:
            raise ActionError(422, str(e))
        except OSError as e:
            raise ActionError(500, f"Enregistrement impossible : {e}")
        with self._lock:
            self.people = directory
        summary = directory.summary()
        self.log("info", f"Entourage importé : {summary.count} personne(s)")
        return summary

    def clear_people(self) -> None:
        with self._lock:
            self.people = peoplemod.remove()
        self.log("info", "Entourage retiré")

    def preview_soul(self, content: str, incoming: str) -> str:
        """A sample reply written with this persona (not saved), to show what it changes."""
        try:
            reply = self.brain.draft(content, "", incoming)
        except Exception as e:
            raise ActionError(502, f"Le cerveau n'a pas pu rédiger d'exemple : {e}")
        if not reply.strip():
            raise ActionError(502, "Le cerveau a rendu une réponse vide.")
        return reply.strip()

    def factory_reset(self) -> None:
        """Danger zone: default settings, nothing followed, no draft, default persona,
        shipped org chart; the wizard runs again. Claude / GitHub sign-ins are untouched."""
        try:
            cfg = cfgmod.factory_reset()
        except Exception as e:
            raise ActionError(500, f"Réinitialisation impossible : {e}")
        new_brain = None
        if self.brain_factory is not None:
            try:
                new_brain = self.brain_factory(cfg)
            except Exception:
                new_brain = None
        self.telemetry_error = telemetry.configure(cfg.get("telemetry"))
        with self._lock:
            self.cfg = cfg
            if new_brain is not None:
                self.brain = new_brain
            self.soul = cfgmod.load_soul()
            self.people = peoplemod.restore_default()
            self._briefs.clear()
            self._history.clear()
            self._thread_cache.clear()
            self._sent_recent.clear()
            self.state.drafts = []
            self.state.notices = []
            self.state.logs = []
            self.state.paused = False
            self.state.onboarded = False
            self.state.brain = cfg.get("brain", {}).get("provider", "claude")
            try:
                discovered = self.driver.list_conversations()
            except Exception:
                discovered = []
            self.state.watchlist = [w.model_copy(update={"watch": False, "mode": "draft"}) for w in discovered]
        self.log("info", "Trame réinitialisé : configuration à refaire")

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
        """Teams is the source of names and kinds; the saved list only keeps the user's
        choices (followed, mode, named people). Entries saved by older versions under the
        raw rail label ("name:Chat X Offline Last message …") are carried over to the
        clean id, then dropped."""
        if not discovered:
            return self.state.watchlist
        by_id = {w.thread_id: w for w in self.state.watchlist}
        by_name = {d.display_name.casefold(): d.thread_id for d in discovered}
        for w in self.state.watchlist:
            unstable = not w.thread_id.startswith("name:") and rail_label.stable_id(w.thread_id) is None
            if unstable:
                target = by_name.get(w.display_name.casefold())
                if target and target != w.thread_id and (target not in by_id or (w.watch and not by_id[target].watch)):
                    by_id[target] = w
                continue
            if w.thread_id.startswith("name:"):
                clean = "name:" + rail_label.parse(w.thread_id[5:]).name
                if clean != w.thread_id:
                    prev = by_id.get(clean)
                    if prev is None or (w.watch and not prev.watch):
                        by_id[clean] = w
        found = {d.thread_id for d in discovered}
        out: list[WatchEntity] = []
        for d in discovered:
            saved = by_id.get(d.thread_id)
            if saved is None:
                out.append(d)
            else:
                out.append(d.model_copy(update={"watch": saved.watch, "mode": saved.mode,
                                                "named_people": saved.named_people or d.named_people}))
        legacy = {w.thread_id for w in self.state.watchlist if w.thread_id.startswith("name:")
                  and "name:" + rail_label.parse(w.thread_id[5:]).name != w.thread_id}
        legacy |= {w.thread_id for w in self.state.watchlist
                   if not w.thread_id.startswith("name:") and rail_label.stable_id(w.thread_id) is None}
        for w in self.state.watchlist:
            if w.thread_id not in found and w.thread_id not in legacy and w.watch:
                out.append(w)
        return out

    def export_logs(self, tail_lines: int = 300, otel_records: int = 200) -> str:
        """Everything useful to debug, as one text: Journal, end of backend.log, last
        OpenTelemetry records. Message text quoted « … » stays masked unless allowed."""
        def tail(path, n):
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    return f.readlines()[-n:]
            except OSError:
                return []

        out = [
            "# Trame : journaux",
            f"Version : {os.environ.get('TRAME_VERSION', 'dev')} · exporté le {datetime.now():%d/%m/%Y %H:%M:%S}",
            f"Cerveau : {self.state.brain} · Teams vérifié : {'oui' if self.state.selftest_ok else 'non'} · "
            f"en pause : {'oui' if self.state.paused else 'non'} · conversations suivies : "
            f"{sum(1 for w in self.state.watchlist if w.watch)}",
            "",
            "## Journal",
        ]
        out += [f"{l.at}  {l.level:<5}  {telemetry.redact(l.text)}" for l in reversed(self.state.logs)] or ["(vide)"]
        try:
            with self._ui_lock:
                diag = self.driver.diagnose(None)
            if diag.get("driver") == "web_bridge":
                page = diag.get("diagnose") if isinstance(diag.get("diagnose"), dict) else {"erreur": diag.get("diagnose")}
                teams = {"driver": "web_bridge", "relay": diag.get("relay"), "ready": diag.get("ready"), "error": diag.get("error"),
                         **{k: page.get(k) for k in ("title_conversation", "rail", "items", "editor", "editor_info",
                                                     "textboxes", "send_button", "messages", "erreur") if k in page}}
            else:
                teams = {k: diag.get(k) for k in ("driver", "window", "teams_windows", "title_conversation", "rail_items", "selected_now")}
                teams["compose_found"] = bool(diag.get("compose")) if "compose" in diag else None
            out += ["", "## Teams (diagnostic court)", json.dumps(teams, ensure_ascii=False)]
        except Exception as e:
            out += ["", "## Teams (diagnostic court)", f"indisponible : {e!r}"]
        backend_log = tail(cfgmod.HOME / "backend.log", tail_lines)
        out += ["", "## backend.log (fin)"] + ([l.rstrip("\n") for l in backend_log] or ["(absent)"])
        telemetry.flush()
        otel = tail(telemetry.file_path(), otel_records)
        out += ["", "## OpenTelemetry (otel.jsonl, fin)"] + ([l.rstrip("\n") for l in otel] or ["(désactivé ou vide)"])
        return "\n".join(out) + "\n"

    def log(self, level, text: str) -> None:
        telemetry.event(level, text)
        self.state.logs = [LogItem(at=datetime.now().strftime("%H:%M:%S"), level=level, text=text), *self.state.logs][:200]
