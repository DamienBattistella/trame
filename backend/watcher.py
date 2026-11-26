from __future__ import annotations
import json
import os
import threading
import time
import uuid
from datetime import datetime
from contextlib import contextmanager
from typing import Iterator, Callable, Iterable, Optional, Sequence

import attachments as attachmod
import config as cfgmod
import safety
import people as peoplemod
import presence as presencemod
import search as searchmod
import journal as journalmod
import reflection
import telemetry
from drivers import rail_label
import settings as settingsmod
from github import context as gh
from models import (REACTIONS, AppState, Brief, BriefSources, Capabilities, Claim, Draft, FactCheck, FactCheckSources,
                    IncomingMessage, LogItem, MessageRef, Notice, QueuedSend, Surface, WatchEntity)
from drivers.base import Focus, NotSupported, ReactUncertain, SendUncertain, TeamsDriver, same_message
from attachments import Attachment
from brain.base import Brain
from brain.brief import BriefParseError, build_brief_prompt, parse_brief
from brain.correct import MAX_CHARS as CORRECT_MAX_CHARS, CorrectionError
from brain.factcheck import FactCheckParseError, build_factcheck_prompt, parse_factcheck

_DAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
           "novembre", "décembre")


CANCELLED = "Action annulée."


def _gathered(n_messages: int, people: str) -> str:
    who = f"entourage ({sum(1 for x in people.splitlines() if x.strip())} ligne(s))" if people else "entourage (personne de connu)"
    return f"Contexte rassemblé : fil ({n_messages} message(s)), {who}, GitHub (non utilisé pour une proposition)"


def _today() -> str:
    d = datetime.now()
    return f"{_DAYS[d.weekday()]} {d.day} {_MONTHS[d.month - 1]} {d.year}"


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
            capabilities=Capabilities(react=bool(getattr(driver, "supports_reactions", False)),
                                      reply=bool(getattr(driver, "supports_reply", False)),
                                      mentions=bool(getattr(driver, "supports_mentions", False)),
                                      own_status=bool(getattr(driver, "can_set_status", False))),
        )
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._ui_lock = threading.Lock()
        self._briefs: dict[str, Brief] = {}
        self._history: dict[str, tuple[float, str]] = {}
        # thread id -> (read at, messages, how many were asked, start of the conversation reached)
        self._thread_cache: dict[str, tuple[float, list[dict], int, bool]] = {}
        self.archive = searchmod.MessageArchive()
        self.journal = journalmod.Journal(cfgmod.HOME / "journal.jsonl")
        self._in_flight: set[str] = set()
        # What the model does during the reply-box actions, for the reflection panel.
        self.reflections = reflection.Reflections()
        self._sent_recent: dict[str, list[tuple[float, str]]] = {}
        # Conversations started from Trame: kept in the list even unfollowed, until Teams
        # lists them itself (a brand-new chat only shows up there after its first message).
        self._started: set[str] = set()
        # File d'envoi : pièces jointes et mentions des messages en attente (hors de l'état
        # diffusé à l'interface), et réveil du renvoi.
        self._outbox_payload: dict[str, dict] = {}
        self._outbox_wake = threading.Event()
        # Un seul passage à la fois sur la file : deux passages simultanés (boucle de fond
        # et nouvel essai demandé) enverraient le même message deux fois.
        self._outbox_flush = threading.Lock()
        self.outbox_auto = True  # renvoi en arrière-plan ; coupé par les tests

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
        self._outbox_wake.set()
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
        threading.Thread(target=self._presence_loop, daemon=True).start()
        threading.Thread(target=self._outbox_loop, daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        self.driver.watch(self._on_message, self._stop.is_set)

    PRESENCE_REFRESH = 20.0

    def _presence_loop(self) -> None:
        """Copy the drivers' presence onto the conversations every PRESENCE_REFRESH s.
        The drivers read it from the chat list they already poll: this never asks
        Teams anything more."""
        while True:
            self.apply_presence()
            if self._stop.wait(self.PRESENCE_REFRESH):
                return

    def apply_presence(self) -> None:
        try:
            seen = self.driver.presence()
        except Exception:
            seen = {}
        with self._lock:
            for w in self.state.watchlist:
                value = seen.get(w.thread_id) if w.surface == Surface.dm and not w.is_self else None
                if w.presence != value:
                    w.presence = value
        self.apply_own_status()

    def apply_own_status(self) -> None:
        """The user's own status, read on Teams' profile button (no menu opened)."""
        if not self.state.capabilities.own_status:
            return
        try:
            mine = self.driver.my_status().get("presence")
        except Exception:
            mine = None
        with self._lock:
            self.state.my_presence = mine

    # --- the user's own status, changed from Trame ---
    def my_status(self) -> dict:
        """Status and status message as Teams shows them. Reading the message opens
        Teams' profile menu in Trame's hidden Teams window, then closes it."""
        self._require_own_status()
        with self._ui_lock:
            try:
                got = self.driver.my_status(with_message=True)
            except Exception as e:
                raise ActionError(502, f"Statut Teams illisible : {e}")
        with self._lock:
            self.state.my_presence = got.get("presence")
        return {"presence": got.get("presence"), "message": got.get("message") or ""}

    def set_my_status(self, choice: str) -> dict:
        """Pick a status in Teams' menu, then check Teams shows it: never a false
        success. « reset » lets Teams decide again; whatever it then shows is reported."""
        self._require_own_status()
        if choice not in presencemod.CHOICES:
            raise ActionError(422, f"Statut inconnu : {choice}.")
        wanted = presencemod.LABELS.get(choice, "Réinitialiser")
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame ne touche pas à Teams.")
            try:
                shown = self.driver.set_my_status(choice)
            except Exception as e:
                self.log("warn", f"Statut « {wanted} » non appliqué : {e}")
                raise ActionError(502, f"Statut non changé : {e}")
        with self._lock:
            self.state.my_presence = shown
        if choice != "reset" and shown != choice:
            seen = presencemod.LABELS.get(shown or "", "aucun statut lisible")
            self.log("warn", f"Statut « {wanted} » demandé, Teams affiche « {seen} »")
            raise ActionError(409, f"Teams affiche « {seen} » au lieu de « {wanted} ». Vérifie dans Teams.")
        self.log("info", f"Statut Teams : {presencemod.LABELS.get(shown or '', 'réinitialisé')}")
        return {"presence": shown}

    def set_status_message(self, text: str) -> dict:
        """Set (empty: clear) the status message, then check Teams shows exactly it."""
        self._require_own_status()
        want = " ".join((text or "").split())
        if len(want) > presencemod.MESSAGE_MAX:
            raise ActionError(422, f"Message de statut trop long ({len(want)} caractères, {presencemod.MESSAGE_MAX} au plus).")
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame ne touche pas à Teams.")
            try:
                shown = self.driver.set_status_message(want)
            except Exception as e:
                self.log("warn", f"Message de statut non appliqué : {e}")
                raise ActionError(502, f"Message de statut non changé : {e}")
        if shown != want:
            self.log("warn", "Message de statut : Teams n'affiche pas le texte demandé")
            raise ActionError(409, "Teams n'affiche pas le message demandé. Vérifie dans Teams.")
        self.log("info", "Message de statut effacé" if not want else "Message de statut mis à jour")
        return {"message": shown}

    def _require_own_status(self) -> None:
        if not self.state.capabilities.own_status:
            raise ActionError(501, f"Statut Teams indisponible : {self.driver.status_unsupported}.")

    # --- core reaction ---
    MAX_NOTICES = 20

    def _on_message(self, msg: IncomingMessage) -> None:
        # Followed or not, an open discussion view rereads the conversation on the
        # notice: its cached copy lacks this message.
        self._thread_cache.pop(msg.thread_id, None)
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
        self.archive.add(msg.thread_id, [msg])
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
                proposal = self.brain.draft(self.soul, summary, msg.text, gh_ctx, self._people_context(msg, summary, entity))
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

        if mode == "auto" and cfg.get("reply", {}).get("fact_check_before_auto_send", True):
            contradicted = self._auto_fact_check(msg, proposal, summary, gh_ctx)
            if contradicted is not None:
                self._queue_draft(msg, proposal, entity.mode, gh_ref)
                self.log("warn", f"Envoi automatique à {msg.sender} suspendu : « {contradicted.excerpt[:60]} » "
                                 "est contredit par la conversation. Réponse gardée en brouillon")
                return "draft"

        if mode == "auto":
            secs = cfg.get("reply", {}).get("auto_send_countdown_seconds", 5)
            # Sent without a click: the people on the other side see it went out alone.
            outgoing = safety.mark_automatic(proposal) if safety.marks_automatic(cfg) else proposal
            self.log("info", f"Réponse à {msg.sender} envoyée dans {secs} s (la pause l'annule) : « {outgoing} »")
            if not self._countdown_ok(secs):
                self._queue_draft(msg, proposal, entity.mode, gh_ref)
                self.log("warn", f"Envoi à {msg.sender} annulé : réponse gardée en brouillon")
                return "draft"
            if self._deliver(msg.thread_id, outgoing, send=True, restore=True, auto=True):
                self.log("sent", f"Envoyé à {msg.sender} : « {outgoing[:60]} »")
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
        # Compared without the 🤖 marker: Teams may show the emoji differently (or not at all).
        text = safety.unmark(msg.text)
        return any(text == safety.unmark(x) for _t, x in recent)

    def _remember_sent(self, thread_id: str, text: str) -> None:
        with self._lock:
            self._sent_recent.setdefault(thread_id, []).append((time.monotonic(), text.strip()))
            self._sent_recent[thread_id] = self._sent_recent[thread_id][-10:]

    def _because(self) -> str:
        reason = getattr(self._why, "reason", None)
        return f" Raison : {reason}." if reason else " La conversation n'a pas pu être confirmée dans Teams."

    def _deliver(self, thread_id: str, text: str, send: bool, restore: bool, auto: bool = False,
                 reply_to: Optional[MessageRef] = None, mentions: Sequence[str] = (),
                 files: Sequence[Attachment] = ()) -> bool:
        """Type into thread_id through the driver's guard. False on any doubt or error.
        restore=True puts the user's previous conversation back afterwards. Pause (for
        automatic sends) and screen share are re-checked under the UI lock, right before
        typing: either may have started during the LLM call, the countdown or the wait.
        files: chosen by the user and sent by their click; never with an automatic send."""
        if files and (auto or not send):
            raise ValueError("pièces jointes : envoi manuel uniquement")
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
                with telemetry.span("teams.type", conversation=thread_id, send=send, auto=auto,
                                    reply=reply_to is not None, mentions=len(mentions), files=len(files)) as sp:
                    if files:
                        focus = self.driver.type_focused(thread_id, text, send, restore, reply_to=reply_to, files=files)
                    elif mentions:
                        focus = self.driver.type_focused(thread_id, text, send, restore, reply_to=reply_to,
                                                         mentions=list(mentions))
                    elif reply_to is None:
                        focus = self.driver.type_focused(thread_id, text, send, restore)
                    else:
                        focus = self.driver.type_focused(thread_id, text, send, restore, reply_to=reply_to)
                    telemetry.set_attrs(sp, confirmed=focus.ok, restored=focus.restored)
            except SendUncertain as e:
                # Never report "nothing was sent" here: a resend could duplicate it.
                if text.strip():
                    self._remember_sent(thread_id, text)
                self.log("warn", f"Envoi non confirmé, à vérifier dans Teams : {e}")
                if auto:
                    return False
                what = "le message et ses pièces jointes sont peut-être partis" if files else "le message est peut-être parti"
                raise ActionError(409, f"Envoi non confirmé : {what}. Vérifie dans Teams avant de renvoyer.")
            except Exception as e:
                self._why.reason = str(e)
                self.log("warn", f"Saisie impossible: {e}")
                return False
            if not focus.ok:
                self._why.reason = focus.reason
                if focus.reason:
                    self.log("warn", f"Saisie refusée : {focus.reason}")
            if focus.ok and send and text.strip():
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

    def _require(self, gesture: str) -> None:
        """Refuse up front a gesture the active Teams driver cannot do."""
        caps = self.state.capabilities
        if gesture == "reply" and not caps.reply:
            raise ActionError(501, "Répondre à un message précis n'est pas possible avec ce pilote Teams.")
        if gesture == "react" and not caps.react:
            raise ActionError(501, "Réagir à un message n'est pas possible avec ce pilote Teams.")
        if gesture == "mentions" and not caps.mentions:
            raise ActionError(501, "Mentionner quelqu'un n'est pas possible avec ce pilote Teams.")

    MAX_MENTIONS = 10

    def _mentions_in(self, text: str, mentions: Optional[Sequence[str]]) -> list[str]:
        """Names to mention, each written « @Nom » in text, without duplicates. Refuses a
        name missing from the text: Teams would get a mention the reader cannot see."""
        names: list[str] = []
        for raw in mentions or ():
            name = " ".join((raw or "").split())
            if name and name.casefold() not in (n.casefold() for n in names):
                names.append(name)
        if not names:
            return []
        self._require("mentions")
        if len(names) > self.MAX_MENTIONS:
            raise ActionError(422, f"Au plus {self.MAX_MENTIONS} mentions par message.")
        missing = [n for n in names if f"@{n}".casefold() not in text.casefold()]
        if missing:
            raise ActionError(422, f"Mention absente du texte : @{missing[0]}.")
        return names

    # --- outbox: what the user sent while Teams was not ready ---
    OUTBOX_RETRY = 15.0          # seconds between two automatic tries
    OUTBOX_MAX_AGE = 12 * 3600   # a message older than this is no longer sent by itself
    # Reasons where nothing reached Teams: the page could not be reached, or the
    # conversation could not even be opened. Anything else (text refused, compose box
    # busy, conversation not found) needs the user: it is never retried by itself.
    TRANSIENT = ("n'est pas prête", "n'est pas affiché", "pas de réponse à « open »", "pas de réponse à « title »",
                 "pas de réponse à « ping »", "Partage d'écran")

    def _not_ready(self, thread_id: Optional[str] = None) -> Optional[str]:
        """Why a send cannot even be tried now, None when Teams is ready. A conversation
        that already has a message waiting keeps its order: the new one goes behind it."""
        if thread_id and any(x.thread_id == thread_id for x in self.state.outbox):
            return "un message précédent de cette conversation attend encore"
        if self._screen_share_guarded():
            self.state.screen_sharing = True
            return "Partage d'écran en cours"
        relay = getattr(self.driver, "relay_connected", None)
        # The relay of Teams intégré is down: the page cannot be reached at all.
        if callable(relay) and not relay():
            return "Teams n'est pas prêt (la fenêtre Teams de Trame se connecte)"
        return None

    def _transient(self) -> bool:
        reason = getattr(self._why, "reason", None) or ""
        return any(marker in reason for marker in self.TRANSIENT)

    def _enqueue(self, thread_id: str, conversation: str, text: str, reply_to: Optional[MessageRef],
                 mentions: Sequence[str], files: Sequence[Attachment], reason: str) -> QueuedSend:
        item = QueuedSend(id=str(uuid.uuid4())[:8], thread_id=thread_id, conversation=conversation, text=text,
                          files=[f.name for f in files], reply_to=reply_to,
                          queued_at=datetime.now().strftime("%H:%M"), reason=reason)
        with self._lock:
            self._outbox_payload[item.id] = {"mentions": list(mentions), "files": list(files),
                                             "since": time.monotonic()}
            self.state.outbox = [*self.state.outbox, item]
        self.log("info", f"Message pour {conversation} mis en file d'envoi : {reason}. Il partira dès que Teams est prêt.")
        self._outbox_wake.set()
        return item

    def _outbox_loop(self) -> None:
        while not self._stop.is_set():
            self._outbox_wake.wait(self.OUTBOX_RETRY)
            self._outbox_wake.clear()
            if not self.outbox_auto:
                continue
            try:
                self.flush_outbox()
            except Exception as e:
                self.log("warn", f"File d'envoi : {e}")

    def flush_outbox(self) -> None:
        """Send what waits, in order. A conversation whose earlier message is stuck waits
        too: messages never arrive out of order. One pass at a time."""
        if not self._outbox_flush.acquire(blocking=False):
            return
        try:
            self._flush_outbox()
        finally:
            self._outbox_flush.release()

    def _flush_outbox(self) -> None:
        blocked: set[str] = set()
        for item in list(self.state.outbox):
            if item.status in ("failed", "uncertain"):
                blocked.add(item.thread_id)
                continue
            if item.status != "waiting" or item.thread_id in blocked:
                continue
            payload = self._outbox_payload.get(item.id, {})
            if time.monotonic() - payload.get("since", time.monotonic()) > self.OUTBOX_MAX_AGE:
                self._outbox_update(item, status="failed", reason="en attente depuis trop longtemps : renvoie-le toi-même")
                blocked.add(item.thread_id)
                continue
            why = self._not_ready()
            if why:
                self._outbox_update(item, reason=why)
                return
            self._outbox_update(item, status="sending", attempts=item.attempts + 1)
            try:
                ok = self._deliver(item.thread_id, item.text, send=True, restore=True, reply_to=item.reply_to,
                                   mentions=payload.get("mentions", ()), files=payload.get("files", ()))
            except ActionError as e:
                # « Envoi non confirmé » : peut-être parti. Jamais renvoyé seul.
                self._outbox_update(item, status="uncertain", reason=e.message)
                blocked.add(item.thread_id)
                continue
            if ok:
                self._outbox_drop(item.id)
                self._history.pop(item.thread_id, None)
                self._thread_cache.pop(item.thread_id, None)
                self.log("sent", f"Envoyé à {item.conversation} (depuis la file d'envoi){self._joined(payload.get('files', ()))}")
            elif self._transient():
                self._outbox_update(item, status="waiting", reason=self._why.reason or "Teams pas prêt")
                return
            else:
                self._outbox_update(item, status="failed", reason=self._why.reason or "refusé par Teams")
                self.log("warn", f"File d'envoi : message pour {item.conversation} refusé.{self._because()}")
                blocked.add(item.thread_id)

    def _name_of(self, thread_id: str, fallback: str) -> str:
        return next((w.display_name for w in self.state.watchlist if w.thread_id == thread_id), fallback)

    def _outbox_update(self, item: QueuedSend, **changes) -> None:
        with self._lock:
            self.state.outbox = [x.model_copy(update=changes) if x.id == item.id else x for x in self.state.outbox]

    def _outbox_drop(self, item_id: str) -> None:
        with self._lock:
            self.state.outbox = [x for x in self.state.outbox if x.id != item_id]
            self._outbox_payload.pop(item_id, None)

    def _outbox_item(self, item_id: str) -> QueuedSend:
        item = next((x for x in self.state.outbox if x.id == item_id), None)
        if item is None:
            raise ActionError(404, "Ce message n'est plus dans la file d'envoi.")
        return item

    def cancel_queued(self, item_id: str) -> None:
        item = self._outbox_item(item_id)
        if item.status == "sending":
            raise ActionError(409, "Ce message est en cours d'envoi.")
        self._outbox_drop(item_id)
        self.log("info", f"Message pour {item.conversation} retiré de la file d'envoi")

    def retry_queued(self, item_id: str) -> None:
        """Try again now, at the user's request: also for a refused or uncertain message,
        which Trame never resends by itself."""
        item = self._outbox_item(item_id)
        if item.status == "sending":
            raise ActionError(409, "Ce message est en cours d'envoi.")
        with self._lock:
            self._outbox_payload.setdefault(item_id, {})["since"] = time.monotonic()
        self._outbox_update(item, status="waiting", reason="nouvel essai demandé")
        self._outbox_wake.set()

    def send_draft(self, draft_id: str, text: Optional[str] = None, reply_to: Optional[MessageRef] = None,
                   mentions: Optional[Sequence[str]] = None, files: Sequence[Attachment] = ()) -> Optional[QueuedSend]:
        if reply_to is not None:
            self._require("reply")
        self._attach_allowed(files)
        with self._claim(draft_id) as d:
            body = text.strip() if text and text.strip() else d.proposal
            names = self._mentions_in(body, mentions)
            self._attach_allowed(files, names)
            # Teams pas prêt : le message part plus tard, par la file d'envoi.
            why = self._not_ready(d.thread_id)
            queued = None
            if why:
                queued = self._enqueue(d.thread_id, self._name_of(d.thread_id, d.from_), body, reply_to, names, files, why)
            elif not self._deliver(d.thread_id, body, send=True, restore=True, reply_to=reply_to, mentions=names,
                                   files=files):
                if self._transient():
                    queued = self._enqueue(d.thread_id, self._name_of(d.thread_id, d.from_), body, reply_to, names, files,
                                           self._why.reason)
                else:
                    with self._lock:
                        d.proposal = body
                    self.log("warn", f"Envoi à {d.from_} refusé, réponse conservée.{self._because()}")
                    raise ActionError(409, f"Rien n'a été envoyé, le brouillon est conservé.{self._because()}")
            with self._lock:
                self.state.drafts = [x for x in self.state.drafts if x is not d]
        if queued:
            return queued
        self._history.pop(d.thread_id, None)
        self._thread_cache.pop(d.thread_id, None)
        self.log("sent", f"Envoyé à {d.from_}{self._in_reply(reply_to)}{self._joined(files)}")

    def compose_draft(self, draft_id: str, text: Optional[str] = None, reply_to: Optional[MessageRef] = None) -> None:
        if reply_to is not None:
            self._require("reply")
        with self._claim(draft_id) as d:
            body = text.strip() if text and text.strip() else d.proposal
            self._typing_allowed()
            with self._lock:
                d.proposal = body
            if not self._deliver(d.thread_id, body, send=False, restore=False, reply_to=reply_to):
                self.log("warn", f"Saisie refusée : conversation de {d.from_} non confirmée")
                raise ActionError(409, f"Rien n'a été saisi dans Teams.{self._because()}")
        self.log("info", f"Brouillon saisi dans Teams pour {d.from_} (à valider dans Teams)")

    # --- manual mode: read a conversation, reply by hand, or ask for a proposal ---
    def _is_mine(self, sender: str) -> bool:
        names = self.cfg.get("triggers", {}).get("self_names", ["Damien"])
        s = (sender or "").strip().casefold()
        return s in ("you", "vous", "moi") or any(s == n.strip().casefold() for n in names if n.strip())

    def thread_messages(self, thread_id: str, last_n: int = 30, fresh: bool = False) -> list[dict]:
        return self.thread_history(thread_id, last_n, fresh)[0]

    def thread_history(self, thread_id: str, last_n: int = 30, fresh: bool = False) -> tuple[list[dict], bool]:
        """History shown in the discussion view, and whether it starts at the beginning
        of the conversation. Kept HISTORY_TTL so that clicking around the sidebar does
        not keep switching the conversation open in Teams; a longer read covers a
        shorter one. Dropped whenever a message arrives in the conversation."""
        cached = self._thread_cache.get(thread_id)
        if cached and not fresh and time.monotonic() - cached[0] < self.HISTORY_TTL:
            _, out, read_n, top = cached
            if read_n >= last_n or top:
                return out[-last_n:], top and len(out) <= last_n
        entity = self._conversation(thread_id)
        msgs, top = self._read_history_focused(thread_id, entity.display_name, last_n, purpose="Lecture")
        out = [{"id": m.id, "sender": m.sender, "text": m.text, "at": m.received_at, "mine": self._is_mine(m.sender),
                "reactions": list(m.reactions), "files": [f.model_dump() for f in m.files],
                "images": [i.model_dump() for i in m.images], "seen": m.seen} for m in msgs]
        self._thread_cache[thread_id] = (time.monotonic(), out, last_n, top)
        return out, top

    def thread_activity(self, thread_id: str) -> dict:
        """Someone typing in thread_id, and whether your last message there was seen, as
        the chat list Trame already polls shows it: nothing is opened or read in Teams."""
        return self.driver.activity(thread_id)

    def search_messages(self, query: str, limit: int = 50) -> dict:
        """Messages already read by Trame that contain `query` (case and accents ignored).
        Reads nothing in Teams: only what the engine has seen since it started."""
        names = {w.thread_id: w.display_name for w in self.state.watchlist}
        results = self.archive.search(query, names, self._is_mine, limit)
        return {"results": results, "scope": self.archive.scope()}

    @staticmethod
    def _in_reply(ref: Optional[MessageRef]) -> str:
        if ref is None:
            return ""
        who = f"{ref.sender} : " if ref.sender else ""
        return f", en réponse à « {who}{ref.text[:40]} »"

    def search_teams(self, query: str, limit: int = 25) -> dict:
        """Teams' own search, for what Trame has not read: every conversation, the whole
        history Teams keeps. Teams' results page shows for a few seconds in Trame's Teams
        window, then the chat list comes back. Nothing is typed anywhere else."""
        q = " ".join((query or "").split())
        if len(searchmod.fold(q)) < 2:
            raise ActionError(422, "Tape au moins deux caractères.")
        if not self.driver.can_search_messages:
            raise ActionError(501, f"Recherche dans Teams impossible : {self.driver.search_messages_unsupported}.")
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame ne lance pas de recherche dans Teams.")
            try:
                with telemetry.span("teams.search", limit=limit) as sp:
                    found = self.driver.search_messages(q, limit)
                    telemetry.set_attrs(sp, results=len(found))
            except Exception as e:
                self.log("warn", f"Recherche dans Teams impossible : {e}")
                raise ActionError(502, f"Recherche dans Teams impossible : {e}")
        results = []
        for r in found:
            name = r.get("conversation") or ""
            entity = next((w for w in self.state.watchlist if name and rail_label.same_name(w.display_name, name)), None)
            if entity is None and not name:
                # Your own message in a private chat: Teams does not name the other person,
                # but Trame may have read that very message already.
                tid = self.archive.thread_of(r.get("text") or "")
                entity = next((w for w in self.state.watchlist if w.thread_id == tid), None)
                name = entity.display_name if entity else ""
            results.append(searchmod.hit(entity.thread_id if entity else None, name or "Conversation privée",
                                         r.get("sender") or "", r.get("at") or "", bool(r.get("mine")),
                                         r.get("text") or "", q))
        self.log("info", f"Recherche dans Teams : {len(results)} message{'s' if len(results) > 1 else ''} trouvé"
                         f"{'s' if len(results) > 1 else ''}")
        return {"results": results}

    def _attach_allowed(self, files: Sequence[Attachment], mentions: Optional[Sequence[str]] = None) -> None:
        if files and not self.driver.can_attach:
            raise ActionError(501, f"Pièce jointe impossible : {self.driver.attach_unsupported}.")
        if files and mentions:
            raise ActionError(422, "Pièce jointe et mention dans le même message : pas encore pris en charge. "
                                   "Envoie le fichier dans un message sans mention.")

    @staticmethod
    def _joined(files: Sequence[Attachment]) -> str:
        return f" avec {attachmod.describe(list(files))}" if files else ""

    def attachments_info(self) -> dict:
        """What the conversation view needs to offer « Joindre » (or say why not)."""
        return {"can_attach": bool(self.driver.can_attach),
                "unsupported": None if self.driver.can_attach else self.driver.attach_unsupported,
                **attachmod.limits()}

    def send_manual(self, thread_id: str, text: str, reply_to: Optional[MessageRef] = None,
                    mentions: Optional[Sequence[str]] = None, files: Sequence[Attachment] = ()) -> Optional[QueuedSend]:
        entity = self._conversation(thread_id)
        body = text.strip()
        if not body and not files:
            raise ActionError(422, "Le message est vide.")
        if reply_to is not None:
            self._require("reply")
        names = self._mentions_in(body, mentions)
        self._attach_allowed(files, names)
        # Teams pas prêt : le message part plus tard, par la file d'envoi.
        why = self._not_ready(thread_id)
        if why:
            return self._enqueue(thread_id, entity.display_name, body, reply_to, names, files, why)
        if not self._deliver(thread_id, body, send=True, restore=True, reply_to=reply_to, mentions=names,
                             files=files):
            if self._transient():
                return self._enqueue(thread_id, entity.display_name, body, reply_to, names, files, self._why.reason)
            self.log("warn", f"Envoi à {entity.display_name} refusé.{self._because()}")
            raise ActionError(409, f"Rien n'a été envoyé à « {entity.display_name} ».{self._because()}")
        self._history.pop(thread_id, None)
        self._thread_cache.pop(thread_id, None)
        quoted = f" : « {body[:60]} »" if body else ""
        self.log("sent", f"Envoyé à {entity.display_name}{self._in_reply(reply_to)}{quoted}{self._joined(files)}")

    def react(self, thread_id: str, target: MessageRef, reaction: str) -> None:
        """One click reaction on a precise message. Same guards as typing: screen share,
        UI lock, conversation confirmed by its title, message checked by author and text.
        Success only once Teams shows the reaction: never a false « fait »."""
        entity = self._conversation(thread_id)
        if reaction not in REACTIONS:
            raise ActionError(422, "Réaction inconnue.")
        self._require("react")
        self._typing_allowed()
        emoji = REACTIONS[reaction]
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : aucune action dans Teams.")
            try:
                with telemetry.span("teams.react", conversation=thread_id, reaction=reaction) as sp:
                    focus = self.driver.react_focused(thread_id, target, reaction, restore=True)
                    telemetry.set_attrs(sp, confirmed=focus.ok, restored=focus.restored)
            except ReactUncertain as e:
                self.log("warn", f"Réaction {emoji} non confirmée dans « {entity.display_name} » : {e}")
                raise ActionError(409, f"Réaction non confirmée : vérifie dans Teams avant de recommencer. ({e})")
            except NotSupported as e:
                raise ActionError(501, str(e))
            except Exception as e:
                self.log("warn", f"Réaction impossible dans « {entity.display_name} » : {e}")
                raise ActionError(409, f"Aucune réaction posée. Raison : {e}.")
        self._warn_if_not_restored(focus)
        if not focus.ok:
            reason = focus.reason or "conversation non confirmée dans Teams"
            self.log("warn", f"Réaction refusée dans « {entity.display_name} » : {reason}")
            raise ActionError(409, f"Aucune réaction posée. Raison : {reason}.")
        with self._lock:
            cached = self._thread_cache.get(thread_id)
            for m in reversed(cached[1] if cached else []):
                if (m.get("id") == target.id) if target.id else same_message(target, m["sender"], m["text"]):
                    if reaction not in m.setdefault("reactions", []):
                        m["reactions"].append(reaction)
                    break
        who = f" de {target.sender}" if target.sender else ""
        self.log("info", f"Réaction {emoji} au message{who} dans « {entity.display_name} »")

    def _locate(self, msgs: list[IncomingMessage], target: MessageRef) -> Optional[int]:
        for i in range(len(msgs) - 1, -1, -1):
            m = msgs[i]
            if (not target.id or m.id == target.id) and same_message(target, m.sender, m.text):
                return i
        return None

    @contextmanager
    def _reflect(self, action: str, thread_id: Optional[str] = None) -> Iterator[reflection.Run]:
        """Follow a reply-box action in the reflection panel. An action the user
        cancelled answers 409 « Action annulée. », whatever the brain raised."""
        name = None
        if thread_id:
            entity = next((w for w in self.state.watchlist if w.thread_id == thread_id), None)
            name = entity.display_name if entity else None
        provider = self.brain.label or self.state.brain
        model = getattr(self.brain, "model", "") or "modèle par défaut"
        run: Optional[reflection.Run] = None
        try:
            with self.reflections.track(action, provider, model, thread_id, name) as run:
                yield run
        except Exception as e:
            if run is not None and run._cancel.is_set():
                raise ActionError(409, CANCELLED) from e
            raise

    def _brain_call(self, what: str) -> None:
        reflection.step(f"Appel envoyé à {self.brain.label or self.state.brain} : {what}")

    def suggest_reply(self, thread_id: str, last_n: int = 15, target: Optional[MessageRef] = None) -> str:
        """Proposal for the last message from someone else, or for target: the brain
        then answers that very message, with the thread up to it as context."""
        with self._reflect("suggest", thread_id):
            reply = self._suggest_reply(thread_id, last_n, target)
            reflection.step(f"Réponse reçue et nettoyée ({len(reply)} caractères)")
            reflection.result(reply)
            return reply

    def _suggest_reply(self, thread_id: str, last_n: int, target: Optional[MessageRef]) -> str:
        entity = self._conversation(thread_id)
        reflection.step(f"Lecture du fil ({last_n} derniers messages au plus)")
        msgs = self._read_focused(thread_id, entity.display_name, last_n, purpose="Proposition")
        reflection.check_cancelled()
        if target is not None:
            idx = self._locate(msgs, target)
            if idx is None:
                # Older than the read window: answer it with the recent thread as context.
                last = IncomingMessage(thread_id=thread_id, sender=target.sender or entity.display_name, text=target.text,
                                       received_at=target.at, surface=entity.surface, id=target.id)
                before = msgs
            else:
                last, before = msgs[idx], msgs[:idx]
            summary = "\n".join(f"{m.sender}: {m.text}" for m in before)
            summary += f"\n(La réponse cite et répond précisément au message suivant de {last.sender}, pas au dernier du fil.)"
            people = self._people_context(last, summary)
            reflection.step(_gathered(len(before), people))
            self._brain_call(f"réponse au message cité de {last.sender}")
            try:
                reply = self.brain.draft(self.soul, summary.strip(), last.text, "", people)
            except Exception as e:
                raise ActionError(502, f"Le cerveau n'a pas pu proposer de réponse : {e}")
            return reply.strip()
        theirs = [m for m in msgs if not self._is_mine(m.sender)]
        if not theirs:
            raise ActionError(409, "Aucun message à qui répondre dans cette conversation.")
        last = theirs[-1]
        summary = "\n".join(f"{m.sender}: {m.text}" for m in msgs[:-1])
        people = self._people_context(last, summary, entity)
        reflection.step(_gathered(len(msgs), people))
        self._brain_call(f"réponse au dernier message de {last.sender}")
        try:
            reply = self.brain.draft(self.soul, summary, last.text, "", people)
        except Exception as e:
            raise ActionError(502, f"Le cerveau n'a pas pu proposer de réponse : {e}")
        return reply.strip()

    def correct_text(self, text: str, thread_id: Optional[str] = None) -> str:
        """Spelling, grammar and typography of a message being written, by the chosen
        brain. Never sends: the user accepts or rejects the result."""
        if not text.strip():
            raise ActionError(400, "Rien à corriger : le message est vide.")
        if len(text) > CORRECT_MAX_CHARS:
            raise ActionError(413, f"Message trop long pour la correction ({CORRECT_MAX_CHARS} caractères au plus).")
        with self._reflect("correct", thread_id):
            reflection.step(f"Message à corriger : {len(text)} caractères (ni le fil ni l'entourage ne sont lus)")
            self._brain_call("correction de l'orthographe et de la typographie")
            fixed = self._correct(text)
            reflection.step("Réponse reçue et validée : liens, mentions et code intacts"
                            if fixed != text.strip() else "Réponse reçue : rien à corriger")
            reflection.result(fixed)
            return fixed

    def _correct(self, text: str) -> str:
        brain = self.brain
        try:
            fixed = brain.correct(text)
        except CorrectionError as e:
            self.log("warn", f"Correction refusée : {e}")
            raise ActionError(502, f"Correction inutilisable : {e}. Ton message n'a pas changé.")
        except Exception as e:
            self.log("warn", f"Correction impossible : le cerveau a échoué ({str(e)[:120]})")
            raise ActionError(502, f"Le cerveau n'a pas pu corriger le message : {e}. Ton message n'a pas changé.")
        return fixed

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

    def clear_compose(self, thread_id: str) -> None:
        """Empty the Teams compose box of a conversation, asked by the user after a refusal
        « zone de saisie non vide »: text, pending attachment or pasted item left there
        would otherwise block every send (and could leave with the next one)."""
        entity = self._conversation(thread_id)
        with self._ui_lock:
            if self.driver._current() != thread_id and self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame n'ouvre pas d'autre conversation dans Teams.")
            try:
                ok = self.driver.clear_compose(thread_id)
            except Exception as e:
                ok, self.driver.last_error = False, str(e)
        if not ok:
            self.log("warn", f"Zone de saisie de {entity.display_name} non vidée : {self.driver.last_error or 'refusé par Teams'}")
            raise ActionError(409, f"La zone de saisie de « {entity.display_name} » n'a pas pu être vidée dans Teams. "
                                   f"{self.driver.last_error or ''}".strip())
        self.log("info", f"Zone de saisie de {entity.display_name} vidée dans Teams")

    def mark_read(self, thread_id: str) -> None:
        """The user read the conversation in Trame: Teams shows it read too, for them and
        for their colleagues' read receipts. The conversation is not opened."""
        entity = self._conversation(thread_id)
        with self._ui_lock:
            try:
                ok = self.driver.mark_read(thread_id)
            except Exception as e:
                ok, self.driver.last_error = False, str(e)
        if not ok:
            self.log("warn", f"Marquer comme lu impossible pour {entity.display_name} : {self.driver.last_error or 'refusé par Teams'}")
            raise ActionError(409, f"« {entity.display_name} » n'a pas pu être marquée comme lue dans Teams.")
        with self._lock:
            entity.unread = False

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

    # --- new conversation with someone not in the list yet ---
    def _dm_named(self, name: str) -> Optional[WatchEntity]:
        return next((w for w in self.state.watchlist
                     if w.surface == Surface.dm and rail_label.same_name(w.display_name, name)), None)

    def people_search(self, query: str, limit: int = 8) -> dict:
        """Suggestions for « Nouvelle conversation »: the entourage first, then the people
        Teams finds (when the driver can search). An existing private chat is pointed at."""
        limit = max(1, min(20, limit))
        out: list[dict] = []
        seen: set[str] = set()

        def add(name: str, person: Optional[peoplemod.Person], source: str) -> None:
            key = peoplemod._key(name)
            if not key or key in seen:
                return
            seen.add(key)
            dm = self._dm_named(name)
            out.append({"name": name, "role": person.role if person else None, "team": person.team if person else None,
                        "manager": person.manager if person else None, "source": source,
                        "thread_id": dm.thread_id if dm else None})

        for p in self.people.search(query, limit):
            add(p.name, p, "entourage")
        teams_error = None
        if self.driver.can_search_people and (query or "").strip() and len(out) < limit:
            with self._ui_lock:
                try:
                    names = [] if self._screen_share_guarded() else self.driver.search_people(query, limit)
                except Exception as e:
                    names, teams_error = [], str(e)
            for n in names:
                add(n, self.people.find(n), "teams")
        return {"people": out[:limit], "can_start": bool(self.driver.can_start_chat),
                "teams_search": bool(self.driver.can_search_people), "teams_error": teams_error,
                "unsupported": None if self.driver.can_start_chat else self.driver.start_chat_unsupported}

    def start_conversation(self, name: str) -> WatchEntity:
        """Open (or create) the private chat with `name` in Teams and add it to the list,
        unfollowed. Nothing is typed. Refused unless Teams shows that very name."""
        name = " ".join((name or "").split())
        if not name:
            raise ActionError(422, "Choisis une personne.")
        known = self._dm_named(name)
        if known is not None:
            return known
        if not self.driver.can_start_chat:
            raise ActionError(501, f"Nouvelle conversation impossible : {self.driver.start_chat_unsupported}. "
                                   "Écris-lui une première fois dans Teams, la conversation apparaîtra ici.")
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : aucune conversation ouverte dans Teams.")
            self.driver.last_error = None
            try:
                entity = self.driver.start_chat(name)
            except Exception as e:
                entity, self.driver.last_error = None, str(e)
        if entity is None or not rail_label.same_name(entity.display_name, name):
            reason = self.driver.last_error or (f"Teams affiche « {entity.display_name} »" if entity else None)
            self.log("warn", f"Nouvelle conversation avec {name} refusée : {reason or 'non confirmée'}")
            raise ActionError(409, f"Conversation avec « {name} » non ouverte : {reason or 'non confirmée dans Teams'}.")
        with self._lock:
            entity = next((w for w in self.state.watchlist if w.thread_id == entity.thread_id), None) or entity
            if entity not in self.state.watchlist:
                self.state.watchlist = [entity, *self.state.watchlist]
            self._started.add(entity.thread_id)
        self._persist_watchlist()
        self._thread_cache.pop(entity.thread_id, None)
        self.log("info", f"Conversation ouverte avec {entity.display_name}")
        return entity

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
            cfg["watchlist"] = [json.loads(w.model_dump_json(exclude={"rank", "last_activity", "unread", "is_self", "own_preview", "presence"}))
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
            if numbers or digest.search_queries or gh.linked_refs(transcript):
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

    # --- fact check of a message about to be sent ---
    FACT_CHECK_MESSAGES = 30

    def _people_cards(self, names: Iterable[str], text: str) -> list[str]:
        """Cards of the people speaking, then of those named in full in the message."""
        found: list[peoplemod.Person] = []
        for p in [self.people.find(n) for n in names if n.strip()] + self.people.mentioned(text):
            if p and p not in found:
                found.append(p)
        return [peoplemod.Directory.card(p) for p in found[:12]]

    def _github_facts(self, text: str) -> str:
        """State of the PR / issues the message names, read-only; "" when GitHub is off."""
        prefs = self.get_settings()
        if not prefs.github.enabled or not gh.is_relevant(text):
            return ""
        try:
            repos = gh.scope(prefs.github.all_repos, self.cfg.get("context", {}).get("github", {}).get("repos_allowlist", []))
            with telemetry.span("github.fetch", repos=len(repos), purpose="Vérification"):
                return gh.fetch(text, repos, True)
        except Exception as e:
            self.log("warn", f"GitHub illisible pour la vérification : {e}")
            return ""

    def _check_claims(self, text: str, transcript: str, people: str, github: str) -> list[Claim]:
        """One brain call; raises on failure or unusable answer. Never sends anything."""
        timeout = max(self.BRIEF_TIMEOUT, 2 * float(getattr(self.brain, "timeout", 0) or 0))
        with telemetry.span("brain.factcheck", provider=self.state.brain, history_chars=len(transcript),
                            github=bool(github)):
            raw = self.brain.complete(build_factcheck_prompt(text, transcript, people, github, _today()), timeout=timeout)
        return parse_factcheck(raw)

    def fact_check(self, thread_id: str, text: str, target: Optional[MessageRef] = None) -> FactCheck:
        """Check a message against what Trame already knows: the thread, the entourage
        and, when connected, GitHub. Read-only: never blocks nor sends anything."""
        entity = self._conversation(thread_id)
        body = (text or "").strip()
        if not body:
            raise ActionError(422, "Le message à vérifier est vide.")
        with self._reflect("check", thread_id):
            check = self._fact_check(entity, body, target)
            bad = sum(c.verdict == "contredit" for c in check.claims)
            reflection.result(f"{len(check.claims)} affirmation(s) relevée(s), {bad} contredite(s)" if check.claims
                              else "Rien à signaler")
            return check

    def _fact_check(self, entity: WatchEntity, body: str, target: Optional[MessageRef]) -> FactCheck:
        thread_id, name = entity.thread_id, entity.display_name
        reflection.step(f"Lecture du fil ({self.FACT_CHECK_MESSAGES} derniers messages au plus)")
        msgs, _top = self.thread_history(thread_id, self.FACT_CHECK_MESSAGES)
        reflection.check_cancelled()
        lines = [f"[{m['at']}] {m['sender']}: {m['text']}" if m.get("at") else f"{m['sender']}: {m['text']}" for m in msgs]
        if target is not None:
            when = f" ({target.at})" if target.at else ""
            lines.append(f"(Le message à vérifier répond à {target.sender or 'ce message'}{when} : « {target.text} »)")
        senders = [m["sender"] for m in msgs if not m.get("mine")]
        if entity.surface == Surface.dm:
            senders.insert(0, name)
        cards = self._people_cards(senders, body)
        github = self._github_facts(body)
        reflection.step(f"Contexte rassemblé : fil ({len(msgs)} message(s)), entourage ({len(cards)} fiche(s)), "
                        + (f"GitHub ({len(github.splitlines())} ligne(s))" if github else "GitHub (rien à lire)"))
        self._brain_call("vérification des affirmations du message")
        try:
            claims = self._check_claims(body, "\n".join(lines), "\n".join(cards), github)
        except FactCheckParseError as e:
            self.log("warn", f"Vérification impossible pour {name} : {e}")
            raise ActionError(502, "Réponse du cerveau inexploitable pour la vérification. Ton message est intact, tu peux réessayer.")
        except Exception as e:
            self.log("warn", f"Vérification impossible pour {name} : le cerveau a échoué ({str(e)[:120]})")
            raise ActionError(502, "Le cerveau n'a pas pu vérifier le message. Ton message est intact, tu peux réessayer.")
        reflection.step(f"Réponse reçue et validée : {len(claims)} affirmation(s) exploitable(s)")
        bad = sum(c.verdict == "contredit" for c in claims)
        verdict = f"{bad} affirmation(s) contredite(s)" if bad else "rien de contredit"
        self.log("info", f"Message vérifié pour {name} : {verdict}")
        return FactCheck(
            thread_id=thread_id,
            checked_at=datetime.now().strftime("%H:%M"),
            claims=claims,
            sources=FactCheckSources(messages=len(msgs), people=len(cards), github=len(github.splitlines()) if github else 0),
        )

    def _auto_fact_check(self, msg: IncomingMessage, proposal: str, summary: str, gh_ctx: str) -> Optional[Claim]:
        """Before an automatic send: the first contradicted claim, if any. A failed check
        changes nothing (the send goes on as before): it only ever holds a send back."""
        senders = [msg.sender] + [line.split(":", 1)[0] for line in summary.splitlines() if ":" in line]
        transcript = summary if msg.text in summary else "\n".join(p for p in (summary, f"{msg.sender}: {msg.text}") if p)
        try:
            claims = self._check_claims(proposal, transcript, "\n".join(self._people_cards(senders, proposal)), gh_ctx)
        except Exception as e:
            self.log("info", f"Vérification avant envoi automatique impossible ({str(e)[:80]}) : envoi maintenu")
            return None
        return next((c for c in claims if c.verdict == "contredit"), None)

    def _read_focused(self, thread_id: str, name: str, last_n: int, purpose: str = "Résumé") -> list[IncomingMessage]:
        # For the brain (brief, proposal): text only. A message with only an image or a
        # file says so in words, without the image data.
        return [self._as_text(m) for m in self._read_history_focused(thread_id, name, last_n, purpose)[0]
                if m.text or m.files or m.images]

    @staticmethod
    def _as_text(m: IncomingMessage) -> IncomingMessage:
        extra = [f"[fichier joint : {f.name}]" for f in m.files] + ["[image]"] * len(m.images)
        if not extra:
            return m
        return m.model_copy(update={"text": "\n".join([m.text, *extra]).strip(), "images": []})

    def _read_history_focused(self, thread_id: str, name: str, last_n: int,
                              purpose: str = "Résumé") -> tuple[list[IncomingMessage], bool]:
        """Open the conversation just long enough to read it, then reopen the previous one.
        Also tells whether the start of the conversation was reached."""
        with self._ui_lock:
            if self.driver._current() != thread_id and self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame n'ouvre pas d'autre conversation dans Teams.")
            msgs: list[IncomingMessage] = []
            top = False
            try:
                with telemetry.span("teams.read", conversation=name, purpose=purpose, last_n=last_n) as sp, \
                        self.driver.focused(thread_id, restore=True) as focus:
                    if focus.ok:
                        msgs, top = self.driver.read_history(thread_id, last_n)
                        self.archive.add(thread_id, msgs)
                    telemetry.set_attrs(sp, confirmed=focus.ok, messages=len(msgs), top=top)
            except Exception as e:
                self.log("warn", f"{purpose} impossible pour {name} : lecture de la conversation échouée ({e})")
                raise ActionError(502, "Lecture de la conversation impossible dans Teams. Rien n'a été perdu, tu peux réessayer.")
        self._warn_if_not_restored(focus)
        if not focus.ok:
            self.log("warn", f"{purpose} impossible pour {name} : {focus.reason or 'conversation non confirmée dans Teams'}")
            raise ActionError(409, f"Impossible d'ouvrir la conversation « {name} » dans Teams.")
        return msgs, top

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
    def _people_context(self, msg: IncomingMessage, summary: str, entity: Optional[WatchEntity] = None) -> str:
        """Cards of the sender, then of the other people speaking in the thread; plus,
        in a 1:1 chat, a word on the sender being in a meeting (shorter reply)."""
        names = [msg.sender] + [line.split(":", 1)[0] for line in summary.splitlines() if ":" in line]
        cards = self.people.context(n for n in names if n.strip())
        hint = presencemod.brain_hint(msg.sender, entity.presence) if entity and entity.surface == Surface.dm else ""
        return "\n".join(p for p in (cards, hint) if p)

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
            self.archive.clear()
            self._sent_recent.clear()
            self.state.drafts = []
            self.state.notices = []
            self.state.logs = []
            self.journal.clear()
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
        self.archive.add(thread_id, msgs)
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
        # A chat started from Trame under its name, now listed by Teams with its id.
        moved: set[str] = set()
        for w in self.state.watchlist:
            if w.thread_id in self._started and w.thread_id.startswith("name:"):
                target = by_name.get(w.thread_id[5:].casefold())
                if target and target != w.thread_id:
                    by_id.setdefault(target, w)
                    moved.add(w.thread_id)
                    self._started.discard(w.thread_id)
                    self._started.add(target)
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
            if w.thread_id in moved:
                continue
            if w.thread_id not in found and w.thread_id not in legacy and (w.watch or w.thread_id in self._started):
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

    def export_activity(self, q: str, levels: list[str], since: Optional[str]) -> str:
        """The Activité lines the panel's search and filters keep, as text (Copier /
        Exporter on a filtered view). Message text quoted « … » stays masked unless allowed."""
        res = self.journal.query(q, levels, since, limit=self.journal.max_entries)
        crit = [f"recherche « {q.strip()} »" if q.strip() else "",
                "niveaux : " + ", ".join(levels) if set(levels) != set(journalmod.LEVELS) else "",
                f"depuis le {datetime.fromisoformat(since):%d/%m/%Y %H:%M}" if since else ""]
        out = ["# Trame : activité filtrée",
               f"Exporté le {datetime.now():%d/%m/%Y %H:%M:%S} · {res['total']} ligne(s) · " + (" · ".join(c for c in crit if c)),
               ""]
        out += [f"{datetime.fromisoformat(l.ts):%d/%m/%Y %H:%M:%S}  {l.level:<5}  {telemetry.redact(l.text)}"
                for l in res["items"]] or ["(aucune ligne)"]
        return "\n".join(out) + "\n"

    def log(self, level, text: str) -> None:
        telemetry.event(level, text)
        item = journalmod.now_item(level, text)
        self.journal.append(item)
        self.state.logs = [item, *self.state.logs][:200]
