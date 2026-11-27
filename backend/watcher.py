from __future__ import annotations
import json
import os
import re
import shutil
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from contextlib import contextmanager
from typing import Iterator, Callable, Iterable, Optional, Sequence

import archiving
import attachments as attachmod
import config as cfgmod
import follow_ups as followmod
import safety
import people as peoplemod
import persona as personamod
import presence as presencemod
import search as searchmod
import journal as journalmod
import outbox_store as outboxstore
import reflection
import reports as reportsmod
import skills as skillsmod
import telemetry
import teams_check as teamscheck
import transcripts as transcriptsmod
from drivers import rail_label
import settings as settingsmod
from github import context as gh
from github import knowledge as ghknow
from github import publish as ghpublish
from models import (DELETED_TEXT, REACTIONS, AppState, Archived, Brief, BriefSources, Capabilities, CardRef, Claim, Draft, FactCheck,
                    FactCheckSources, FollowUp, IncomingMessage, LinkRef, LogItem, MessageRef, Notice, QueuedSend, QuoteRef, Surface,
                    UndoableSend, WatchEntity, AutoSent, brain_text)
from drivers.base import DeleteUncertain, Focus, NeedsView, NotSupported, ReactUncertain, SendUncertain, TeamsDriver, same_message
from attachments import Attachment
from brain.base import Brain
from brain.brief import BriefParseError, build_brief_prompt, parse_brief
from brain.correct import MAX_CHARS as CORRECT_MAX_CHARS, CorrectionError
from brain.factcheck import FactCheckParseError, build_factcheck_prompt, parse_factcheck

_DAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
           "novembre", "décembre")


CANCELLED = "Action annulée."
# self_names shipped in config.json by earlier versions: replaced by the name Teams gives.
FORMER_SHIPPED_SELF_NAMES = ("Damien", "Damien Battistella")


def _images_seen(images: list[str]) -> str:
    """For the reflection panel: how many images the model gets to look at."""
    return f", {len(images)} image(s) montrée(s) au modèle" if images else ""


def _gathered(n_messages: int, people: str) -> str:
    who = f"entourage ({sum(1 for x in people.splitlines() if x.strip())} ligne(s))" if people else "entourage (personne de connu)"
    return f"Contexte rassemblé : fil ({n_messages} message(s)), {who}, GitHub (non utilisé pour une proposition)"


def _today() -> str:
    d = datetime.now()
    return f"{_DAYS[d.weekday()]} {d.day} {_MONTHS[d.month - 1]} {d.year}"


def _unique(ids: Iterable[str]) -> list[str]:
    """Sans doublon, dans l'ordre de première apparition."""
    return list(dict.fromkeys(ids))


class ActionError(Exception):
    """An API-triggered action failed; carries the HTTP status and a French message."""

    def __init__(self, status: int, message: str, code: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.message = message
        # Pour l'interface : « maybe_sent », un envoi identique est peut-être déjà parti.
        self.code = code


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
        # Versions du SOUL.md et ce que Trame apprend de tes réponses (sur ce poste).
        self.soul_history = personamod.History()
        self.soul_signals = personamod.Signals()
        if not self.soul_history.list():
            self.soul_history.snapshot(self.soul, "initial", "Version trouvée au démarrage")
        self._proposed: dict[str, str] = {}
        self._suggested: dict[str, tuple[float, str, str]] = {}
        self._learning = False
        self.people = peoplemod.Directory.load()
        self._why = threading.local()
        self.telemetry_error = telemetry.configure(self.cfg.get("telemetry"))
        self.state = AppState(
            onboarded=bool(self.cfg.get("onboarded", False)),
            brain=self.cfg.get("brain", {}).get("provider", "claude"),
            watchlist=[WatchEntity(**w) for w in self.cfg.get("watchlist", [])],
            favorites=_unique(str(t) for t in self.cfg.get("favorites", []) if t),
            archived=_archived(self.cfg.get("archived")),
            capabilities=Capabilities(react=bool(getattr(driver, "supports_reactions", False)),
                                      reply=bool(getattr(driver, "supports_reply", False)),
                                      mentions=bool(getattr(driver, "supports_mentions", False)),
                                      own_status=bool(getattr(driver, "can_set_status", False)),
                                      delete=bool(getattr(driver, "supports_delete", False))),
        )
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._ui_lock = threading.Lock()
        self._briefs: dict[str, Brief] = {}
        # Dernier message vu passer, par conversation : complète l'heure de la liste Teams.
        self._seen_at: dict[str, datetime] = {}
        self._history: dict[str, tuple[float, str]] = {}
        # Images joined to the cached summary (same key, same lifetime as `_history`).
        self._history_images: dict[str, list[str]] = {}
        # Images shown to the brain by the last proposal, per conversation (MCP suggest_reply).
        self.images_shown: dict[str, int] = {}
        # thread id -> (read at, messages, how many were asked, start of the conversation reached)
        self._thread_cache: dict[str, tuple[float, list[dict], int, bool]] = {}
        # Organisateur des réunions dont la transcription a été relue (par meeting_id).
        self._meeting_owners: dict[str, str] = {}
        self.archive = searchmod.MessageArchive()
        self.journal = journalmod.Journal(cfgmod.HOME / "journal.jsonl")
        self._in_flight: set[str] = set()
        # What the model does during the reply-box actions, for the reflection panel.
        self.reflections = reflection.Reflections()
        # Agent skills offered to the brain (Réglages › Skills).
        self.skills = skillsmod.Registry(cfgmod.HOME, lambda: self.cfg)
        skillsmod.install(self.skills)
        # Comptes-rendus de réunion (un skill appliqué à un .vtt, en plusieurs tours).
        self.reports = reportsmod.Reports(self.reflections, lambda: self.brain, self.log)
        # Ouverture de pull requests GitHub pour publier un compte-rendu (écriture, coupée
        # par défaut). Jamais appelée par le cerveau ni un script : seulement sur un clic.
        self.github_writer = ghpublish.GithubWriter()
        # État « déjà publié ? » d'une réunion, mis en cache court (évite d'interroger gh à
        # chaque rendu de la liste des réunions).
        self._report_state_cache: dict[str, tuple[float, dict]] = {}
        self._sent_recent: dict[str, list[tuple[float, str]]] = {}
        # Conversations started from Trame: kept in the list even unfollowed, until Teams
        # lists them itself (a brand-new chat only shows up there after its first message).
        self._started: set[str] = set()
        # File d'envoi : pièces jointes et mentions des messages en attente (hors de l'état
        # diffusé à l'interface), et réveil du renvoi.
        self._outbox_payload: dict[str, dict] = {}
        # Dernier envoi à la main resté « non confirmé », par conversation : (heure, texte,
        # noms des fichiers). Un nouvel essai du même contenu relit d'abord la conversation.
        self._unconfirmed: dict[str, tuple[float, str, tuple[str, ...]]] = {}
        self._outbox_wake = threading.Event()
        # Réponses envoyées seules (horodatage, conversation, nom, texte) : plafond et « aujourd'hui ».
        self._auto_sent: list[tuple[float, str, str, str]] = []
        # Dernier échec du cerveau (heure et raison), pour la page Santé.
        self._brain_error: Optional[str] = None
        self._started_at = time.time()
        # Un seul passage à la fois sur la file : deux passages simultanés (boucle de fond
        # et nouvel essai demandé) enverraient le même message deux fois.
        self._outbox_flush = threading.Lock()
        self.outbox_auto = True  # renvoi en arrière-plan ; coupé par les tests
        # Contrôle des repères de la page Teams : au démarrage, à la connexion, toutes les
        # heures, et peu après une opération refusée par Teams (réveil par le pilote).
        self._check_wake = threading.Event()
        self._check_lock = threading.Lock()
        self._landmark_marks: dict[str, dict] = {}
        driver.on_page_failure = self._check_wake.set
        # Favoris : ceux de Teams (section « Favoris »), relus à chaque coup d'œil à la liste.
        driver.on_favorites = self._sync_teams_favorites
        # Liste vivante : non-lu, heure et ordre suivis à chaque coup d'œil du pilote.
        driver.on_conversations = self._apply_live_list
        # Relances : tes questions restées sans réponse (suivi gardé sur disque).
        self.follow_ups = followmod.Tracker(cfgmod.HOME / "follow_ups.json")
        self._follow_up_failed: dict[str, float] = {}
        self.follow_up_auto = True  # passage périodique ; coupé par les tests
        self._sync_follow_ups()
        # La file survit à un redémarrage : relue ici, réécrite à chaque changement.
        self._outbox_store = outboxstore.OutboxStore(cfgmod.HOME / "outbox")
        self._outbox_restore()

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
        self._check_wake.set()
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
        if self.state.selftest_ok:
            self._check_wake.set()
        threading.Thread(target=self._check_loop, daemon=True).start()
        threading.Thread(target=self._follow_up_loop, daemon=True).start()
        threading.Thread(target=self._archive_loop, daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        self.driver.watch(self._on_message, self._stop.is_set)

    # --- Contrôle de la page Teams (teams_check) ---
    CHECK_EVERY = 3600.0
    # Après un réveil (connexion, opération refusée) : laisser Teams se poser, et ne faire
    # qu'un contrôle pour plusieurs échecs rapprochés.
    CHECK_SETTLE = 3.0

    def _check_loop(self) -> None:
        while not self._stop.is_set():
            woke = self._check_wake.wait(self.CHECK_EVERY)
            if woke and self._stop.wait(self.CHECK_SETTLE):
                return
            if self._stop.is_set():
                return
            self._check_wake.clear()
            self.check_teams()

    def check_teams(self) -> Optional[teamscheck.TeamsCheck]:
        """Contrôle les repères de la page Teams dont dépend le pilote, sans rien y changer.
        None quand le pilote ne sait pas le faire ou que Teams n'est pas affiché : le
        dernier contrôle reste alors en place."""
        with self._check_lock:
            try:
                raw = self.driver.probe_page()
            except Exception:
                return None
            if not isinstance(raw, dict) or not raw.get("ready"):
                return None
            self._landmark_marks = teamscheck.merge_marks(self._landmark_marks, raw.get("marks"))
            # Ce que le pilote fait par l'API Teams web n'a plus besoin de ces repères (repli seul).
            served_by = getattr(self.driver, "api_features", None)
            try:
                served = served_by() if callable(served_by) else set()
            except Exception:
                served = set()
            check = teamscheck.evaluate(raw.get("results"), self._landmark_marks, served=served)
            before = self.state.teams_check
            self.state.teams_check = check
        was = {m.key for m in before.missing} if before else set()
        now = {m.key for m in check.missing}
        # Le journal ne garde que les changements : un contrôle par heure sans nouveauté
        # n'y écrit rien.
        if now and now != was:
            self.log("warn", f"{check.summary} Repères absents : {', '.join(sorted(now))}"
                             " (détail dans Réglages › Général).")
        elif was and not now:
            self.log("info", "Teams : les repères qui manquaient sont revenus, tout remarche.")
        elif before is None and not now:
            self.log("info", f"Contrôle de Teams : {check.verified} repères présents, rien n'a changé.")
        return check

    PRESENCE_REFRESH = 20.0
    # The profile photo rarely changes: read hourly, retried sooner while unknown.
    PHOTO_REFRESH = 3600.0
    PHOTO_RETRY = 300.0
    _photo_at: Optional[float] = None

    def _presence_loop(self) -> None:
        """Copy the drivers' presence onto the conversations every PRESENCE_REFRESH s.
        The drivers read it from the chat list they already poll: this never asks
        Teams anything more."""
        while True:
            self.apply_presence()
            self.apply_my_photo()
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

    def apply_my_photo(self, force: bool = False) -> None:
        """The user's own profile photo, for the avatar at the bottom of the rail."""
        now = time.monotonic()
        wait = self.PHOTO_REFRESH if self.state.my_photo else self.PHOTO_RETRY
        if not force and self._photo_at is not None and now - self._photo_at < wait:
            return
        self._photo_at = now
        try:
            photo = self.driver.my_photo()
        except Exception:
            return  # Teams unreachable: keep the photo already shown
        with self._lock:
            self.state.my_photo = photo

    def apply_own_status(self) -> None:
        """The user's own status, read on Teams' profile button (no menu opened)."""
        if not self.state.capabilities.own_status:
            return
        try:
            mine = self.driver.my_status().get("presence")
        except Exception:
            mine = None
        with self._lock:
            was = self.state.my_presence
            self.state.my_presence = mine
            # Kept current for the UI: notifications hide message text while presenting.
            # Only from the status just read: the driver is not asked again here.
            guard = self.cfg.get("safety", {}).get("auto_pause_on_screen_share", True)
            if guard and mine == "presenting":
                self.state.screen_sharing = True
            elif was == "presenting":
                self.state.screen_sharing = False
        if mine == "presenting" and was != "presenting":
            self.log("info", "Présentation en cours dans Teams : Trame ne tape rien et masque le texte des notifications")
        elif was == "presenting" and mine != "presenting":
            self.log("info", "Présentation terminée : Trame reprend")
            self._outbox_wake.set()

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

    def set_my_status(self, choice: str, duration: Optional[str] = None, until: Optional[str] = None) -> dict:
        """Pick a status in Teams' menu, then check Teams shows it: never a false
        success. « reset » lets Teams decide again; whatever it then shows is reported.
        duration: Teams puts the status back afterwards (« Rétablir le statut après »).
        until: the same, at a local date and time (« Personnalisé »), "AAAA-MM-JJTHH:MM"."""
        self._require_own_status()
        if choice not in presencemod.CHOICES:
            raise ActionError(422, f"Statut inconnu : {choice}.")
        if duration is not None and (duration not in presencemod.DURATIONS or choice == "reset"):
            raise ActionError(422, "Durée impossible pour ce statut.")
        end: Optional[datetime] = None
        if until is not None:
            if duration is not None or choice == "reset":
                raise ActionError(422, "Une heure de fin se choisit seule, et pas pour « Réinitialiser ».")
            try:
                end = presencemod.parse_until(until, datetime.now())
            except ValueError as e:
                raise ActionError(422, str(e))
        wanted = presencemod.LABELS.get(choice, "Réinitialiser")
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame ne touche pas à Teams.")
            try:
                shown = (self.driver.set_my_status(choice, until=end) if end
                         else self.driver.set_my_status(choice, duration) if duration
                         else self.driver.set_my_status(choice))
            except Exception as e:
                self.log("warn", f"Statut « {wanted} » non appliqué : {e}")
                raise ActionError(502, f"Statut non changé : {e}")
        with self._lock:
            self.state.my_presence = shown
        if choice != "reset" and shown != choice:
            seen = presencemod.LABELS.get(shown or "", "aucun statut lisible")
            self.log("warn", f"Statut « {wanted} » demandé, Teams affiche « {seen} »")
            raise ActionError(409, f"Teams affiche « {seen} » au lieu de « {wanted} ». Vérifie dans Teams.")
        if end:
            how = f" jusqu'à {presencemod.until_label(end, datetime.now())}"
        else:
            how = f" pour {presencemod.DURATION_LABELS[duration]}" if duration else ""
        self.log("info", f"Statut Teams : {presencemod.LABELS.get(shown or '', 'réinitialisé')}{how}")
        extra = {"until": end.strftime("%Y-%m-%dT%H:%M")} if end else {"duration": duration} if duration else {}
        return {"presence": shown, **extra}

    def suggest_status_message(self, previous: str = "") -> dict:
        """A status message proposed by the brain, in the user's voice, different each time.
        Only a proposal: nothing is sent to Teams. If the brain cannot answer, a short
        ready-made message is offered instead, and said so."""
        from brain.status_note import FALLBACK, build_status_prompt, parse_status_note
        presence = self.state.my_presence
        label = {"available": "Disponible", "busy": "Occupé", "dnd": "Ne pas déranger", "brb": "De retour bientôt",
                 "away": "Absent", "offline": "Hors ligne"}.get(presence or "", "")
        text = ""
        try:
            text = parse_status_note(self.brain.complete(build_status_prompt(self.soul, label, previous), timeout=60),
                                     presencemod.MESSAGE_MAX)
        except Exception as e:
            self.log("warn", f"Message de statut : le cerveau n'a pas répondu ({e}), message tout prêt proposé")
        if text and text != " ".join(previous.split()):
            return {"text": text, "source": "brain"}
        import random
        choices = [m for m in FALLBACK if m != previous.strip()] or list(FALLBACK)
        return {"text": random.choice(choices), "source": "fallback"}

    # --- réunions : transcriptions enregistrées en .vtt (lecture seule dans Teams) ---
    _TRANSCRIPT_REASONS = {
        "none": (404, "Pas de transcription pour cette réunion."),
        "denied": (403, "Accès refusé : Teams ne te montre pas cette transcription."),
        "not_found": (404, "Réunion introuvable dans Teams."),
        "empty": (404, "La transcription est vide."),
        "frame": (504, "La transcription ne s'est pas affichée dans Teams."),
        "timeout": (504, "La transcription a mis trop de temps à se charger."),
    }

    def _transcripts_ready(self) -> None:
        if not getattr(self.driver, "supports_transcripts", False):
            raise ActionError(501, f"Transcriptions indisponibles : {self.driver.transcripts_unsupported}.")

    def meetings(self, transcript_only: bool = False) -> dict:
        """Réunions terminées des conversations de réunion récentes, et le dossier où les
        transcriptions sont enregistrées."""
        self._transcripts_ready()
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame ne touche pas à Teams.")
            try:
                found = self.driver.list_meetings()
            except NotSupported as e:
                raise ActionError(501, str(e))
            except Exception as e:
                self.log("warn", f"Réunions non lues : {e}")
                raise ActionError(502, f"Réunions non lues : {e}")
        home = cfgmod._home()
        fresh = []
        for m in found:
            when = m.get("when") or ""
            day = transcriptsmod.parse_meeting_date(when)
            start, end = transcriptsmod.parse_meeting_slot(when)
            mid = transcriptsmod.meeting_id(m["thread_id"], m["mid"])
            fresh.append({**m, "meeting_id": mid, "date": day.isoformat() if day else None, "start": start, "end": end,
                          "organizer": self._meeting_owners.get(mid, "")})
        # Gardée dans %APPDATA%\Trame : la liste survit au redémarrage et aux mises à jour,
        # et une réunion sortie de la fenêtre récente de Teams reste dans la liste.
        known, _ = transcriptsmod.load_meetings(home)
        read_at = datetime.now().astimezone().isoformat(timespec="seconds")
        merged = transcriptsmod.merge_meetings(known, fresh)
        transcriptsmod.store_meetings(home, merged, read_at)
        if transcript_only:
            merged = [m for m in merged if m.get("transcript")]
        return self._meetings_view(home, merged, read_at)

    def known_meetings(self) -> dict:
        """La liste de la dernière lecture, gardée sur le poste : rien n'est lu dans Teams."""
        home = cfgmod._home()
        known, read_at = transcriptsmod.load_meetings(home)
        return self._meetings_view(home, known, read_at)

    @staticmethod
    def _meetings_view(home, items: list[dict], read_at: Optional[str]) -> dict:
        """Chaque réunion avec son .vtt déjà sur le disque (relu à chaque fois, jamais gardé)."""
        folder = transcriptsmod.chosen_dir(home)
        out = []
        for m in items:
            day = date.fromisoformat(m["date"]) if m.get("date") else None
            saved = transcriptsmod.saved_file(folder, str(m.get("title") or "Réunion"), day) if m.get("transcript") else None
            out.append({**m, "organizer": m.get("organizer") or "",
                        "saved": {"path": str(saved), "name": saved.name} if saved else None})
        return {"meetings": out, "directory": str(folder), "read_at": read_at}

    def save_transcript(self, thread_id: str, mid: str, directory: Optional[str] = None,
                        save: bool = True, content: bool = False) -> dict:
        """Relit la transcription d'une réunion dans Teams et en fait un .vtt, enregistré
        sur le poste (save) et/ou rendu tel quel (content). Rien n'est envoyé ailleurs ni
        fait dans la réunion."""
        self._transcripts_ready()
        home = cfgmod._home()
        try:
            folder = transcriptsmod.check_dir(directory) if directory else transcriptsmod.chosen_dir(home)
        except transcriptsmod.TranscriptError as e:
            raise ActionError(422, str(e))
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : Trame ne touche pas à Teams.")
            try:
                with telemetry.span("teams.transcript", conversation=thread_id) as sp:
                    res = self.driver.meeting_transcript(thread_id, str(mid)) or {}
                    telemetry.set_attrs(sp, ok=bool(res.get("ok")), entries=len(res.get("entries") or []))
            except NotSupported as e:
                raise ActionError(501, str(e))
            except Exception as e:
                self.log("warn", f"Transcription non lue : {e}")
                raise ActionError(502, f"Transcription non lue : {e}")
        title = str(res.get("title") or "Réunion")
        if not res.get("ok"):
            status, message = self._TRANSCRIPT_REASONS.get(str(res.get("reason")), (502, "Transcription non lue."))
            detail = f" ({res['error']})" if res.get("error") and status >= 500 else ""
            self.log("warn", f"Transcription de « {title} » non récupérée : {message}{detail}")
            raise ActionError(status, message + detail)
        cues = transcriptsmod.cues_from_entries(res.get("entries") or [])
        if not cues:
            raise ActionError(404, self._TRANSCRIPT_REASONS["empty"][1])
        when = str(res.get("recap_when") or res.get("when") or "")
        day = transcriptsmod.parse_meeting_date(when)
        organizer = transcriptsmod.owner_name(str(res.get("owner") or ""))
        key = transcriptsmod.meeting_id(thread_id, str(mid))
        if organizer:
            self._meeting_owners[key] = organizer
            known, read_at = transcriptsmod.load_meetings(home)
            if any(m["meeting_id"] == key and m.get("organizer") != organizer for m in known):
                transcriptsmod.store_meetings(home, [{**m, "organizer": organizer} if m["meeting_id"] == key else m
                                                     for m in known], read_at or "")
        vtt = transcriptsmod.build_vtt(cues, title=title, day=day, when=when, organizer=organizer)
        transcriptsmod.parse_vtt(vtt)
        complete = bool(res.get("complete", True)) and not res.get("gaps")
        out = {"meeting_id": key, "title": title, "date": day.isoformat() if day else None, "organizer": organizer,
               "cues": len(cues), "speakers": sorted({c.speaker for c in cues if c.speaker}), "complete": complete}
        if save:
            try:
                path = transcriptsmod.save(folder, transcriptsmod.file_name(title, day), vtt)
            except OSError as e:
                raise ActionError(500, f"Fichier non enregistré dans {folder} : {e.strerror or e}")
            if directory:
                transcriptsmod.remember_dir(home, folder)
            out.update(path=str(path), name=path.name, directory=str(folder))
            self.log("info", f"Transcription de « {title} » enregistrée : {path.name} ({len(cues)} prise(s) de parole"
                             f"{'' if complete else ', relecture incomplète'})")
        else:
            self.log("info", f"Transcription de « {title} » relue ({len(cues)} prise(s) de parole)")
        if content:
            out["vtt"] = vtt
        return out

    def probe_transcript(self, thread_id: str, mid: str) -> dict:
        """Diagnostic : la forme de la page de transcription (balises, rôles, longueurs),
        jamais son texte. Rien n'est enregistré."""
        self._transcripts_ready()
        with self._ui_lock:
            try:
                res = self.driver.meeting_transcript(thread_id, str(mid), probe=True) or {}
            except Exception as e:
                raise ActionError(502, f"Diagnostic impossible : {e}")
        return {"probe": res.get("probe"), "reason": res.get("reason"), "error": res.get("error")}

    def open_transcripts_folder(self, directory: Optional[str] = None) -> dict:
        try:
            folder = transcriptsmod.check_dir(directory) if directory else transcriptsmod.chosen_dir(cfgmod._home())
            folder.mkdir(parents=True, exist_ok=True)
        except transcriptsmod.TranscriptError as e:
            raise ActionError(422, str(e))
        except OSError as e:
            raise ActionError(500, f"Dossier non créé : {e.strerror or e}")
        if os.name == "nt":
            os.startfile(str(folder))  # type: ignore[attr-defined]
        return {"directory": str(folder)}

    def transcripts_folder(self) -> dict:
        """Le dossier des transcriptions (choisi, sinon celui par défaut), sans rien lire ni ouvrir."""
        return {"directory": str(transcriptsmod.chosen_dir(cfgmod._home()))}

    def set_transcripts_folder(self, directory: str) -> dict:
        """Change le dossier des transcriptions, retenu pour les suivantes."""
        try:
            folder = transcriptsmod.check_dir(directory)
        except transcriptsmod.TranscriptError as e:
            raise ActionError(422, str(e))
        transcriptsmod.remember_dir(cfgmod._home(), folder)
        return {"directory": str(folder)}

    def open_transcript_file(self, path: str, reveal: bool = False) -> dict:
        """Ouvre un .vtt enregistré (application associée, sinon le Bloc-notes) ou le montre
        sélectionné dans l'Explorateur. Rien d'autre qu'un fichier .vtt existant."""
        try:
            file = transcriptsmod.check_vtt_file(path)
        except transcriptsmod.TranscriptError as e:
            raise ActionError(422 if "introuvable" not in str(e) else 404, str(e))
        if os.name == "nt":
            import subprocess

            if reveal:
                # Un nom de fichier Windows ne peut contenir de guillemet : citation sûre.
                subprocess.Popen(f'explorer.exe /select,"{file}"')
            else:
                try:
                    os.startfile(str(file))  # type: ignore[attr-defined]
                except OSError:
                    subprocess.Popen(["notepad.exe", str(file)])
        return {"path": str(file)}

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
        # Un message reçu ramène une conversation archivée, comme Teams pour un chat masqué.
        self._seen_at[msg.thread_id] = datetime.now()
        if msg.thread_id in self.state.archived:
            self._unarchive(msg.thread_id, "nouveau message")
        # Followed or not, an open discussion view rereads the conversation: its cached
        # copy lacks this message (one of the user's own, typed in Teams, included).
        self._touch(msg.thread_id)
        self._track(msg.thread_id, [msg])
        self._notice(msg)
        self._process(msg)

    def _notice(self, msg: IncomingMessage) -> None:
        """Announce a received message, followed conversation or not. Never the user's
        own messages nor the replies Trame just sent."""
        try:
            if self._is_own_message(msg, self._self_names()):
                return
            entity = next((w for w in self.state.watchlist if w.thread_id == msg.thread_id), None)
            names = [n.strip().casefold() for n in self._self_names() if n.strip()]
            mentioned = any(m.strip().casefold() in names or any(m.strip().casefold().startswith(n + " ") for n in names)
                            for m in msg.mentions)
            notice = Notice(id=str(uuid.uuid4())[:8], thread_id=msg.thread_id,
                            conversation=entity.display_name if entity else msg.sender,
                            **{"from": msg.sender}, text=msg.text, at=msg.received_at, surface=msg.surface,
                            mentioned=mentioned, followed=bool(entity and entity.watch))
            with self._lock:
                self.state.notices = [notice, *self.state.notices][: self.MAX_NOTICES]
        except Exception:
            pass

    def _process(self, msg: IncomingMessage, force_draft: bool = False, research: bool = True) -> Optional[str]:
        self.archive.add(msg.thread_id, [msg])
        with telemetry.span("message", conversation=msg.thread_id, surface=msg.surface.value, force_draft=force_draft,
                            text=telemetry.content(msg.text)) as sp:
            outcome = self._process_inner(msg, force_draft, research)
            telemetry.set_attrs(sp, outcome=outcome or "ignored")
            return outcome

    def _process_inner(self, msg: IncomingMessage, force_draft: bool = False, research: bool = True) -> Optional[str]:
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
        self_names = self._self_names()
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
        images = self._history_images.get(msg.thread_id, []) if summary else []
        if gh_thread is not None:
            gh_thread.join()
        gh_ctx = gh_result[0]

        # The reply Trame drafts by itself shows in the reflection panel too, like the
        # reply-box actions: what was gathered, the model's reasoning, the proposal.
        try:
            with self._reflect("reply", msg.thread_id), \
                    telemetry.span("brain.draft", provider=self.state.brain, history_chars=len(summary),
                                   github=bool(gh_ctx)):
                reflection.step(f"Message reçu de {msg.sender} ({len(msg.text)} caractères), "
                                f"mode {'auto' if entity.mode == 'auto' and not force_draft else 'brouillon'}")
                knowledge = self._knowledge(msg.text, summary) if research else ""
                reflection.step(f"Contexte : fil ({summary.count(chr(10)) + 1 if summary else 0} ligne(s))"
                                f"{', GitHub' if gh_ctx else ''}{', dépôts' if knowledge else ''}{_images_seen(images)}")
                gh_ctx = ghknow.with_knowledge(gh_ctx, knowledge)
                self._brain_call("rédiger la réponse")
                proposal = self._draft_reply(summary, msg.text or self._as_text(msg).text, gh_ctx,
                                             self._people_context(msg, summary, entity), images)
                reflection.step(f"Réponse reçue ({len(proposal)} caractères)")
                reflection.result(proposal)
        except Exception as e:
            self._brain_error = f"{datetime.now():%H:%M} · {str(e)[:160]}"
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
            guard = self._auto_guard(msg.thread_id)
            if guard:
                self._queue_draft(msg, proposal, entity.mode, gh_ref)
                self.log("warn", f"Envoi automatique à {msg.sender} retenu : {guard}. Réponse gardée en brouillon")
                return "draft"
            when = "tout de suite" if not secs else f"dans {secs} s (la pause l'annule)"
            self.log("info", f"Réponse à {msg.sender} envoyée {when} : « {outgoing} »")
            if not self._countdown_ok(secs):
                self._queue_draft(msg, proposal, entity.mode, gh_ref)
                self.log("warn", f"Envoi à {msg.sender} annulé : réponse gardée en brouillon")
                return "draft"
            if self._deliver(msg.thread_id, outgoing, send=True, restore=True, auto=True):
                self.log("sent", f"Envoyé à {msg.sender} : « {outgoing[:60]} »")
                self._offer_undo(msg.thread_id, entity.display_name, outgoing)
                self._record_auto(msg.thread_id, entity.display_name, outgoing)
                return "sent"
            self._queue_draft(msg, proposal, entity.mode, gh_ref)
            self.log("warn", f"Envoi à {msg.sender} non effectué : réponse gardée en brouillon")
            return "draft"
        self._queue_draft(msg, proposal, entity.mode, gh_ref)
        self.log("draft", f"Réponse à relire pour {msg.sender}")
        return "draft"

    # --- Auto mode guards ---
    def _auto_guard(self, thread_id: str, now: Optional[datetime] = None) -> Optional[str]:
        """Why an automatic reply must wait for the user now, None when it may leave."""
        s = self.cfg.get("safety", {})
        now = now or datetime.now()
        if not s.get("auto_weekends", True) and now.weekday() >= 5:
            return "pas d'envoi automatique le week-end"
        if s.get("auto_quiet_hours", False):
            def mins(v: str, d: int) -> int:
                try:
                    h, m = v.split(":")
                    return int(h) * 60 + int(m)
                except Exception:
                    return d
            start, end = mins(s.get("auto_quiet_from", "19:00"), 19 * 60), mins(s.get("auto_quiet_to", "08:00"), 8 * 60)
            t = now.hour * 60 + now.minute
            if start != end and ((start < end and start <= t < end) or (start > end and (t >= start or t < end))):
                return f"heures de silence ({s.get('auto_quiet_from', '19:00')} – {s.get('auto_quiet_to', '08:00')})"
        cap = int(s.get("auto_max_per_hour", 5) or 0)
        if cap:
            hour_ago = now.timestamp() - 3600
            sent = sum(1 for ts, tid, *_ in self._auto_sent if tid == thread_id and ts >= hour_ago)
            if sent >= cap:
                return f"plafond atteint ({cap} réponses automatiques en une heure dans cette conversation)"
        return None

    def _record_auto(self, thread_id: str, conversation: str, text: str) -> None:
        """Keep the automatic replies of the last day: for the cap, and for « today »."""
        now = datetime.now()
        with self._lock:
            self._auto_sent = [x for x in self._auto_sent if x[0] >= now.timestamp() - 86400]
            self._auto_sent.append((now.timestamp(), thread_id, conversation, text))
            today = now.date()
            self.state.auto_today = [AutoSent(at=datetime.fromtimestamp(ts).strftime("%H:%M"), thread_id=tid,
                                              conversation=conv, text=txt)
                                     for ts, tid, conv, txt in self._auto_sent
                                     if datetime.fromtimestamp(ts).date() == today]

    # --- undo an automatic reply ---
    UNDO_WINDOW = 30.0

    def _offer_undo(self, thread_id: str, conversation: str, text: str) -> UndoableSend:
        """An automatic reply just left: it stays undoable for UNDO_WINDOW seconds."""
        item = UndoableSend(id=str(uuid.uuid4())[:8], thread_id=thread_id, conversation=conversation, text=text,
                            sent_at=datetime.now().strftime("%H:%M:%S"),
                            expires_at_ms=int((time.time() + self.UNDO_WINDOW) * 1000))
        with self._lock:
            self.state.undoable = [*self.state.undoable, item]
        timer = threading.Timer(self.UNDO_WINDOW + 1, self._drop_undo, args=(item.id,))
        timer.daemon = True
        timer.start()
        return item

    def _drop_undo(self, undo_id: str) -> None:
        with self._lock:
            self.state.undoable = [u for u in self.state.undoable if u.id != undo_id]

    def undo_auto(self, undo_id: str) -> None:
        """Take back an automatic reply: Trame deletes it in Teams. Same guards as a
        delete asked by hand (UI lock, screen share, the message found by its text and
        checked as the user's own by Teams offering « Modifier »). Only inside the window."""
        item = next((u for u in self.state.undoable if u.id == undo_id), None)
        if item is None or time.time() * 1000 > item.expires_at_ms:
            raise ActionError(410, "Trop tard pour annuler : supprime le message depuis la discussion si besoin.")
        self._require("delete")
        excerpt = f"« {item.text[:60]}{'…' if len(item.text) > 60 else ''} »"
        target = MessageRef(sender="", text=item.text)
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : aucune action dans Teams.")
            try:
                focus = self.driver.delete_focused(item.thread_id, target, restore=True)
            except DeleteUncertain as e:
                self._drop_undo(undo_id)
                self._touch(item.thread_id)
                self.log("warn", f"Annulation non confirmée dans « {item.conversation} » : {excerpt} ({e})")
                raise ActionError(409, f"Annulation non confirmée : vérifie dans Teams. ({e})")
            except NotSupported as e:
                raise ActionError(501, str(e))
            except Exception as e:
                self.log("warn", f"Annulation impossible dans « {item.conversation} » : {e}")
                raise ActionError(409, f"Le message n'a pas été retiré. Raison : {e}.")
        self._warn_if_not_restored(focus)
        if not focus.ok:
            reason = focus.reason or "conversation non confirmée dans Teams"
            self.log("warn", f"Annulation refusée dans « {item.conversation} » : {reason}")
            raise ActionError(409, f"Le message n'a pas été retiré. Raison : {reason}.")
        self._drop_undo(undo_id)
        self._touch(item.thread_id)
        self.log("info", f"Réponse automatique retirée dans « {item.conversation} » : {excerpt}")

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

    def _self_names(self) -> list[str]:
        return [n for n in self.cfg.get("triggers", {}).get("self_names", []) if n.strip()]

    def _learn_self_name(self, discovered: list[WatchEntity]) -> None:
        """Teams marks the user's own chat (« (You) ») with their name: it fills
        self_names when empty, or when it still holds the names shipped by older
        versions (written for Damien) and Teams says the user is someone else."""
        name = next((c.display_name.strip() for c in discovered if c.is_self and c.display_name.strip()), None)
        if not name:
            return
        with self._lock:
            current = self._self_names()
            known = {n.strip().casefold() for n in current}
            former = known == {n.casefold() for n in FORMER_SHIPPED_SELF_NAMES}
            if current and not (former and name.casefold() not in known):
                return
            first = name.split()[0]
            names = [name] + ([first] if first.casefold() != name.casefold() else [])
            cfg = dict(self.cfg)
            cfg["triggers"] = {**cfg.get("triggers", {}), "self_names": names}
            self.cfg = cfg
            try:
                cfgmod.save(cfg)
            except Exception as e:
                self.log("warn", f"Sauvegarde de ton nom impossible: {e}")
                return
        self.log("info", f"Ton nom dans Teams : {name}")

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
        self._track(thread_id, [followmod.Seen(sender="moi", text=text, mine=True)])

    UNCONFIRMED_TTL = 2 * 3600.0

    @staticmethod
    def _same_text(text: str) -> str:
        return " ".join((text or "").split())

    def _not_sent_already(self, thread_id: str, text: str, files: Sequence[Attachment]) -> None:
        """Before sending again what was left « non confirmé » in this conversation: reread it.
        If one of the user's last messages shows the same text and files, say so instead of
        sending a duplicate (the UI offers « Renvoyer quand même »). Not there: send."""
        rec = self._unconfirmed.get(thread_id)
        if not rec or time.monotonic() - rec[0] > self.UNCONFIRMED_TTL:
            return
        _at, before_text, before_names = rec
        names = tuple(f.name for f in files)
        if before_text != self._same_text(text) or sorted(before_names) != sorted(names):
            return
        what = ("Ces fichiers semblent déjà partis" if len(names) > 1 else "Ce fichier semble déjà parti") if names \
            else "Ce message semble déjà parti"
        try:
            msgs = self.thread_messages(thread_id, 10, fresh=True)
        except ActionError as e:
            raise ActionError(409, f"Ton envoi précédent n'a pas été confirmé et Teams n'a pas pu être relu ({e.message}) : "
                                   "vérifie dans Teams, puis renvoie quand même si besoin.", code="maybe_sent") from None
        sent = next((m for m in reversed(msgs) if m.get("mine") and attachmod.shows(m, text, names)), None)
        if sent is None:
            # Finalement pas parti : on envoie.
            self._unconfirmed.pop(thread_id, None)
            return
        at = f" à {sent['at']}" if sent.get("at") else ""
        self.log("warn", f"Envoi identique retenu : {what[0].lower() + what[1:]}{at} dans Teams.")
        raise ActionError(409, f"{what}{at} : renvoyer quand même ?", code="maybe_sent")

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
                self._unconfirmed[thread_id] = (time.monotonic(), self._same_text(text), tuple(f.name for f in files))
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
            if focus.ok and send:
                self._unconfirmed.pop(thread_id, None)
                self._touch(thread_id)
        self._warn_if_not_restored(focus)
        return focus.ok

    def _touch(self, thread_id: str) -> None:
        """The conversation changed (message received, or sent by Trame): its cached
        history is stale, and the open discussion view rereads it."""
        self._thread_cache.pop(thread_id, None)
        self._history.pop(thread_id, None)
        with self._lock:
            self.state.thread_updates = {**self.state.thread_updates,
                                         thread_id: self.state.thread_updates.get(thread_id, 0) + 1}

    def _warn_if_not_restored(self, focus: Focus) -> None:
        if focus.restored is False:
            self.log("warn", "Impossible de rouvrir la conversation que tu regardais dans Teams.")

    def _screen_sharing(self) -> bool:
        """A screen share is on. The driver may see it (Teams desktop window); Teams
        intégré cannot, since the meeting runs in the user's own Teams. Then Teams'
        own status says it: « En présentation » while the user shares their screen."""
        try:
            if self.driver.is_screen_sharing():
                return True
        except Exception:
            pass
        return self.state.my_presence == "presenting"

    def _queue_draft(self, msg: IncomingMessage, proposal: str, mode: str, gh_ref: str | None,
                     reply_to: Optional[MessageRef] = None) -> None:
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
                used_github=gh_ref, sender_label=self._sender_label(msg.sender), reply_to=reply_to,
            ))
            self.state.drafts = drafts
            live = {d.id for d in drafts}
            self._proposed = {k: v for k, v in self._proposed.items() if k in live}
            self._proposed[draft_id] = proposal
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
        if gesture == "delete" and not caps.delete:
            raise ActionError(501, getattr(self.driver, "delete_unsupported", "")
                              or "Supprimer un message n'est pas possible avec ce pilote Teams.")
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
            used = sum(f.get("size", 0) for p in self._outbox_payload.values() for f in p.get("meta", ()))
            try:
                meta = self._outbox_store.add_files(item.id, files, used)
            except outboxstore.OutboxFull:
                raise ActionError(413, "File d'envoi pleine : trop de pièces jointes attendent déjà. Rien n'a été "
                                       "envoyé ; retire un message en attente ou réessaie quand Teams est prêt.")
            except OSError as e:
                meta = []
                self._outbox_disk_warn(e)
            self._outbox_payload[item.id] = {"mentions": list(mentions), "files": list(files), "meta": meta,
                                             "since": time.monotonic()}
            self.state.outbox = [*self.state.outbox, item]
            self._outbox_save()
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
            self._outbox_save()

    def _outbox_drop(self, item_id: str) -> None:
        with self._lock:
            self.state.outbox = [x for x in self.state.outbox if x.id != item_id]
            self._outbox_payload.pop(item_id, None)
            self._outbox_save()
            # Parti ou retiré : ses pièces jointes ne restent pas sur le disque.
            try:
                self._outbox_store.remove_files(item_id)
            except OSError as e:
                self._outbox_disk_warn(e)

    def _outbox_save(self) -> None:
        """Réécrit la file sur le disque (appelé sous self._lock, à chaque changement).
        Un échec n'empêche pas l'envoi : le message attend en mémoire, comme avant."""
        try:
            self._outbox_store.save(self.state.outbox, self._outbox_payload)
            self._outbox_disk_warned = False
        except OSError as e:
            self._outbox_disk_warn(e)

    def _outbox_disk_warn(self, e: OSError) -> None:
        if getattr(self, "_outbox_disk_warned", False):
            return
        self._outbox_disk_warned = True
        self.log("warn", f"File d'envoi : enregistrement sur le disque impossible ({e.strerror or type(e).__name__}). "
                         "Les messages en attente seront perdus si Trame est quitté avant leur envoi.")

    def _outbox_restore(self) -> None:
        """Au démarrage : reprend les messages qui attendaient quand Trame a été quitté.
        Un message « en cours d'envoi » à l'arrêt devient « à vérifier », jamais renvoyé seul."""
        try:
            restored = self._outbox_store.load()
        except OSError as e:
            self._outbox_disk_warn(e)
            return
        if restored.corrupt:
            self.log("warn", "File d'envoi enregistrée illisible : ignorée.")
        if not restored.items:
            return
        with self._lock:
            self.state.outbox = restored.items
            self._outbox_payload = restored.payload
            self._outbox_save()
        n = len(restored.items)
        self.log("info", f"File d'envoi : {n} message{'s' if n > 1 else ''} repris après le redémarrage")

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
        if self._outbox_payload.get(item_id, {}).get("lost_files"):
            raise ActionError(409, "Pièce jointe perdue au redémarrage : renvoie ce message toi-même, puis "
                                   "retire-le de la file.")
        with self._lock:
            self._outbox_payload.setdefault(item_id, {})["since"] = time.monotonic()
        self._outbox_update(item, status="waiting", reason="nouvel essai demandé")
        self._outbox_wake.set()

    def send_draft(self, draft_id: str, text: Optional[str] = None, reply_to: Optional[MessageRef] = None,
                   mentions: Optional[Sequence[str]] = None, files: Sequence[Attachment] = (),
                   force: bool = False, learn: bool = False) -> Optional[QueuedSend]:
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
            else:
                if not force:
                    self._not_sent_already(d.thread_id, body, files)
                if not self._deliver(d.thread_id, body, send=True, restore=True, reply_to=reply_to, mentions=names,
                                     files=files):
                    if self._transient():
                        queued = self._enqueue(d.thread_id, self._name_of(d.thread_id, d.from_), body, reply_to, names,
                                               files, self._why.reason)
                    else:
                        with self._lock:
                            d.proposal = body
                        self.log("warn", f"Envoi à {d.from_} refusé, réponse conservée.{self._because()}")
                        raise ActionError(409, f"Rien n'a été envoyé, le brouillon est conservé.{self._because()}")
            with self._lock:
                self.state.drafts = [x for x in self.state.drafts if x is not d]
        if learn:
            self._observe_reply(d.from_, d.incoming, self._proposed.pop(d.id, d.proposal), body)
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

    # --- relances : tes questions restées sans réponse ---
    FOLLOW_UP_EVERY = 300.0
    # Cerveau en échec sur une question : on n'y revient qu'après ce délai.
    FOLLOW_UP_RETRY = 3600.0

    def _follow_up_cfg(self) -> tuple[bool, int]:
        f = self.cfg.get("follow_ups", {}) or {}
        return bool(f.get("enabled", True)), settingsmod.follow_up_delay(f)

    def _track(self, thread_id: str, msgs: Sequence) -> None:
        """Note le dernier message vu d'une conversation pour les relances. Ne lit rien
        dans Teams : seulement ce que Trame vient de recevoir, d'envoyer ou de relire.
        Les canaux sont laissés de côté (une question y attend rarement une personne)."""
        try:
            entity = next((w for w in self.state.watchlist if w.thread_id == thread_id), None)
            surface = entity.surface if entity else next((m.surface for m in msgs if hasattr(m, "surface")), None)
            if surface == Surface.channel:
                return
            seen = [m if isinstance(m, followmod.Seen) else
                    followmod.Seen(sender=m.sender, text=m.text, at=m.received_at, mine=self._is_mine(m.sender))
                    for m in msgs if not getattr(m, "deleted", False)]
            name = entity.display_name if entity else ""
            if self.follow_ups.observe(thread_id, name, seen):
                self._sync_follow_ups()
        except Exception:
            pass

    def _sync_follow_ups(self) -> None:
        items = [FollowUp(id=e.id, thread_id=e.thread_id, conversation=self._name_of(e.thread_id, e.conversation),
                          question=e.question, asked_at=e.asked_at, proposal=e.proposal)
                 for e in self.follow_ups.ready()]
        with self._lock:
            self.state.follow_ups = items

    def _follow_up_loop(self) -> None:
        while not self._stop.wait(self.FOLLOW_UP_EVERY):
            if self.follow_up_auto:
                self.scan_follow_ups()

    def scan_follow_ups(self) -> int:
        """Passe au cerveau les questions dont le délai est atteint : il confirme qu'elles
        attendent une réponse et propose une relance. Ne tape et n'envoie jamais rien.
        Renvoie le nombre de relances proposées."""
        enabled, delay = self._follow_up_cfg()
        if not enabled or self.state.paused:
            return 0
        proposed = 0
        now = time.monotonic()
        for entry in self.follow_ups.due(delay):
            failed = self._follow_up_failed.get(entry.id)
            if failed is not None and now - failed < self.FOLLOW_UP_RETRY:
                continue
            context = [followmod.Seen(sender=m["sender"], text=m["text"], at=m["at"], mine=self._is_mine(m["sender"]))
                       for m in self.archive.recent(entry.thread_id, 12)]
            name = self._name_of(entry.thread_id, entry.conversation)
            prompt = followmod.build_prompt(self.soul, name, entry.question, entry.asked_at, context)
            try:
                with telemetry.span("brain.follow_up", provider=self.state.brain):
                    waiting, text = followmod.parse_answer(self.brain.ask(prompt, timeout=90), entry.question)
            except Exception as e:
                self._follow_up_failed[entry.id] = now
                self.log("warn", f"Relance pour {name} pas encore proposée : {e}")
                continue
            self._follow_up_failed.pop(entry.id, None)
            if not waiting:
                self.follow_ups.ignore(entry.id)
                self.log("info", f"{name} : ta question n'attend pas de réponse, pas de relance")
                continue
            if self.follow_ups.propose(entry.id, text):
                proposed += 1
                self.log("draft", f"Relance à relire pour {name}")
        # Toujours : un report échu revient aussi sans nouvel appel au cerveau.
        self._sync_follow_ups()
        return proposed

    def _follow_up(self, item_id: str) -> followmod.Entry:
        entry = self.follow_ups.get(item_id)
        if entry is None or entry.status != "ready":
            raise ActionError(404, "Cette relance n'est plus proposée.")
        return entry

    def send_follow_up(self, item_id: str, text: Optional[str] = None) -> Optional[QueuedSend]:
        """Envoie la relance, sur ton clic seulement, par le chemin d'un envoi à la main
        (file d'envoi comprise quand Teams n'est pas prêt)."""
        entry = self._follow_up(item_id)
        body = (text if text is not None else entry.proposal).strip()
        if not body:
            raise ActionError(422, "La relance est vide.")
        queued = self.send_manual(entry.thread_id, body)
        self.follow_ups.done(item_id)
        self._sync_follow_ups()
        return queued

    def snooze_follow_up(self, item_id: str, hours: float = 24) -> None:
        self._follow_up(item_id)
        self.follow_ups.snooze(item_id, hours)
        self._sync_follow_ups()

    def ignore_follow_up(self, item_id: str) -> None:
        self._follow_up(item_id)
        self.follow_ups.ignore(item_id)
        self._sync_follow_ups()

    # --- manual mode: read a conversation, reply by hand, or ask for a proposal ---
    def _is_mine(self, sender: str) -> bool:
        names = self._self_names()
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
                "images": [i.model_dump() for i in m.images], "seen": m.seen, "deleted": m.deleted,
                "links": [link.model_dump() for link in m.links], "cards": [c.model_dump() for c in m.cards],
                "quote": m.quote.model_dump() if m.quote else None, "mentions": list(m.mentions), "edited": m.edited}
               for m in msgs]
        self._thread_cache[thread_id] = (time.monotonic(), out, last_n, top)
        return out, top

    def thread_meeting(self, thread_id: str) -> Optional[dict]:
        """For a meeting chat, the link to join the meeting in Teams and whether it is in
        progress, as Teams showed it when the conversation was last read. Trame does not
        join anything: the UI only opens this link in the user's Teams."""
        return self.driver.meeting(thread_id)

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

    def file_link(self, url: str, thread_id: Optional[str] = None) -> dict:
        """Direct download link of a received file (video to play, file to save). Usually
        no gesture: a signed request in the page. Until Teams has itself opened a file in
        this session, the page cannot sign it: the conversation is then opened briefly (UI
        lock, screen-share rule) so Teams shows the file. The link is returned, never logged."""
        try:
            try:
                return self.driver.file_link(url, thread_id)
            except NeedsView:
                if not thread_id:
                    raise
                with self._ui_lock:
                    if self._screen_share_guarded():
                        raise ActionError(409, "Partage d'écran en cours : Trame n'ouvre pas la conversation dans Teams.")
                    return self.driver.file_link(url, thread_id, show=True)
        except ActionError:
            raise
        except NotSupported as e:
            raise ActionError(501, str(e))
        except ValueError as e:
            raise ActionError(422, str(e))
        except Exception as e:
            self.log("warn", f"Fichier joint non ouvert : {e}")
            raise ActionError(502, f"Fichier non ouvert : {e}")

    def attachments_info(self) -> dict:
        """What the conversation view needs to offer « Joindre » (or say why not)."""
        return {"can_attach": bool(self.driver.can_attach),
                "unsupported": None if self.driver.can_attach else self.driver.attach_unsupported,
                **attachmod.limits()}

    def send_manual(self, thread_id: str, text: str, reply_to: Optional[MessageRef] = None,
                    mentions: Optional[Sequence[str]] = None, files: Sequence[Attachment] = (),
                    force: bool = False, learn: bool = False) -> Optional[QueuedSend]:
        entity = self._conversation(thread_id)
        body = text.strip()
        if not body and not files:
            raise ActionError(422, "Le message est vide.")
        queued = self._send_manual(entity, thread_id, body, reply_to, mentions, files, force)
        if learn and body:
            self._observe_written(thread_id, entity.display_name, body)
        return queued

    def _send_manual(self, entity: WatchEntity, thread_id: str, body: str, reply_to: Optional[MessageRef],
                     mentions: Optional[Sequence[str]], files: Sequence[Attachment], force: bool) -> Optional[QueuedSend]:
        if reply_to is not None:
            self._require("reply")
        names = self._mentions_in(body, mentions)
        self._attach_allowed(files, names)
        # Teams pas prêt : le message part plus tard, par la file d'envoi.
        why = self._not_ready(thread_id)
        if why:
            return self._enqueue(thread_id, entity.display_name, body, reply_to, names, files, why)
        if not force:
            self._not_sent_already(thread_id, body, files)
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

    def delete_message(self, thread_id: str, target: MessageRef) -> None:
        """Delete one of the user's own messages in Teams, on their explicit request from
        the discussion view (after a confirmation there). Never called by the Auto mode,
        the brain or the MCP tools. Refused up front on a message of someone else; then
        the same guards as typing, and the driver checks the message by author and text.
        Success only once Teams shows the message deleted: never a false « fait »."""
        entity = self._conversation(thread_id)
        self._require("delete")
        if not target.sender.strip() or not self._is_mine(target.sender):
            self.log("warn", f"Suppression refusée dans « {entity.display_name} » : message d'une autre personne")
            raise ActionError(403, "Seuls tes propres messages peuvent être supprimés.")
        with self._lock:
            cached = self._thread_cache.get(thread_id)
            seen = next((m for m in reversed(cached[1] if cached else []) if target.id and m.get("id") == target.id), None)
        if seen is not None and (not self._is_mine(seen["sender"]) or seen.get("deleted")):
            raise ActionError(403 if not seen.get("deleted") else 409,
                              "Ce message est déjà supprimé." if seen.get("deleted")
                              else "Seuls tes propres messages peuvent être supprimés.")
        self._typing_allowed()
        excerpt = f"« {target.text[:60]}{'…' if len(target.text) > 60 else ''} »"
        with self._ui_lock:
            if self._screen_share_guarded():
                self.state.screen_sharing = True
                raise ActionError(409, "Partage d'écran en cours : aucune action dans Teams.")
            try:
                with telemetry.span("teams.delete", conversation=thread_id) as sp:
                    focus = self.driver.delete_focused(thread_id, target, restore=True)
                    telemetry.set_attrs(sp, confirmed=focus.ok, restored=focus.restored)
            except DeleteUncertain as e:
                self._thread_cache.pop(thread_id, None)
                self.log("warn", f"Suppression non confirmée dans « {entity.display_name} » : {excerpt} ({e})")
                raise ActionError(409, f"Suppression non confirmée : vérifie dans Teams avant de recommencer. ({e})")
            except NotSupported as e:
                raise ActionError(501, str(e))
            except Exception as e:
                self.log("warn", f"Suppression impossible dans « {entity.display_name} » : {e}")
                raise ActionError(409, f"Rien n'a été supprimé. Raison : {e}.")
        self._warn_if_not_restored(focus)
        if not focus.ok:
            reason = focus.reason or "conversation non confirmée dans Teams"
            self.log("warn", f"Suppression refusée dans « {entity.display_name} » : {reason}")
            raise ActionError(409, f"Rien n'a été supprimé. Raison : {reason}.")
        with self._lock:
            cached = self._thread_cache.get(thread_id)
            for m in reversed(cached[1] if cached else []):
                if (m.get("id") == target.id) if target.id else same_message(target, m["sender"], m["text"]):
                    m.update(text=DELETED_TEXT, deleted=True, reactions=[], files=[], images=[])
                    break
        self._history.pop(thread_id, None)
        self.log("info", f"Message supprimé dans « {entity.display_name} » : {excerpt}")

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

    def suggest_reply(self, thread_id: str, last_n: int = 15, target: Optional[MessageRef] = None,
                      learn: bool = False) -> str:
        """Proposal for the last message from someone else, or for target: the brain
        then answers that very message, with the thread up to it as context."""
        with self._reflect("suggest", thread_id):
            reply = self._suggest_reply(thread_id, last_n, target)
            reflection.step(f"Réponse reçue et nettoyée ({len(reply)} caractères)")
            reflection.result(reply)
            if learn:
                # Ce que tu en feras dans la zone de saisie dira ce qui te ressemble.
                with self._lock:
                    self._suggested[thread_id] = (time.monotonic(), reply, target.text if target else "")
            return reply

    def _suggest_reply(self, thread_id: str, last_n: int, target: Optional[MessageRef]) -> str:
        entity = self._conversation(thread_id)
        reflection.step(f"Lecture du fil ({last_n} derniers messages au plus)")
        if target is not None:
            raw = [m for m in self._read_history_focused(thread_id, entity.display_name, last_n, "Proposition")[0]
                   if m.text or m.files or m.images or m.cards]
            reflection.check_cancelled()
            return self._suggest_for(entity, raw, target)
        raw = [m for m in self._read_history_focused(thread_id, entity.display_name, last_n, "Proposition")[0]
               if m.text or m.files or m.images or m.cards]
        reflection.check_cancelled()
        msgs, images = self._brain_view(raw)
        self.images_shown[thread_id] = len(images)
        theirs = [m for m in msgs if not self._is_mine(m.sender)]
        if not theirs:
            raise ActionError(409, "Aucun message à qui répondre dans cette conversation.")
        last = theirs[-1]
        summary = "\n".join(f"{m.sender}: {m.text}" for m in msgs[:-1])
        people = self._people_context(last, summary, entity)
        reflection.step(_gathered(len(msgs), people) + _images_seen(images))
        self._brain_call(f"réponse au dernier message de {last.sender}")
        try:
            reply = self._draft_reply(summary, last.text, ghknow.with_knowledge("", self._knowledge(last.text, summary)),
                                      people, images)
        except Exception as e:
            raise ActionError(502, f"Le cerveau n'a pas pu proposer de réponse : {e}")
        return reply.strip()

    def _suggest_for(self, entity: WatchEntity, raw: list[IncomingMessage], target: MessageRef) -> str:
        """Proposal centred on one message of the thread (« Proposer une réponse à ce
        message »): its text, author and attachments, the thread around it as context.
        On one of the user's own messages, a follow-up or a complement, never a reply to
        themself. Only returns the text: nothing is queued, nothing is sent."""
        msgs, images = self._brain_view(raw)
        self.images_shown[entity.thread_id] = len(images)
        idx = next((i for i in range(len(raw) - 1, -1, -1)
                    if (not target.id or raw[i].id == target.id)
                    # Compared without the image numbers: the app names an image-only message « [image] ».
                    and (same_message(target, raw[i].sender, raw[i].text)
                         or same_message(target, raw[i].sender, self._as_text(raw[i]).text))),
                   None)
        if idx is None:
            # Older than the read window: answer it with the recent thread as context.
            reflection.step("Message ciblé hors des derniers messages lus : le fil récent sert de contexte")
            last = IncomingMessage(thread_id=entity.thread_id, sender=target.sender or entity.display_name, text=target.text,
                                   received_at=target.at, surface=entity.surface, id=target.id)
            before, after = msgs, []
        else:
            last, before, after = msgs[idx], msgs[:idx], msgs[idx + 1:]
            if raw[idx].files:
                reflection.step(f"Fichiers joints au message ciblé : {', '.join(f.name for f in raw[idx].files)} "
                                "(nommés, non lus)")
        mine = self._is_mine(last.sender)
        lines = [f"{m.sender}: {m.text}" for m in before]
        if after:
            lines.append("(Messages arrivés après le message ciblé, pour contexte seulement :)")
            lines += [f"{m.sender}: {m.text}" for m in after]
        if mine:
            lines.append("(Le message ciblé ci-dessous est le tien : propose une relance ou un complément à ce message, "
                         "dans la suite du fil, sans te répondre à toi-même.)")
        else:
            lines.append(f"(La réponse cite et répond précisément au message suivant de {last.sender}, pas au dernier du fil.)")
        summary = "\n".join(lines).strip()
        people = self._people_context(last, summary, None if mine else entity)
        reflection.step(_gathered(len(before) + len(after), people) + _images_seen(images))
        self._brain_call(f"{'relance de ton message' if mine else f'réponse au message cité de {last.sender}'}")
        try:
            reply = self._draft_reply(summary, last.text, ghknow.with_knowledge("", self._knowledge(last.text, summary)),
                                      people, images)
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

    def propose_external_reply(self, thread_id: str, text: str, target: Optional[MessageRef] = None,
                               quote: bool = False) -> Draft:
        """A reply prepared by an outside assistant (MCP): it waits in « À relire »,
        never sent without the user's click. target: the message it answers (shown on the
        card); quote: also quote that message in Teams when the reply is sent."""
        entity = self._conversation(thread_id)
        body = text.strip()
        if not body:
            raise ActionError(422, "La réponse proposée est vide.")
        if quote and target is not None:
            self._require("reply")
        msg = IncomingMessage(thread_id=thread_id, sender=target.sender if target and target.sender else entity.display_name,
                              received_at=target.at if target and target.at else datetime.now().strftime("%H:%M"),
                              text=target.text if target else "Réponse préparée par un assistant externe (MCP).",
                              surface=entity.surface)
        self._queue_draft(msg, body[:4000], "draft", None, target if quote else None)
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

    def dismiss_draft(self, draft_id: str, learn: bool = False) -> None:
        with self._lock:
            gone = next((x for x in self.state.drafts if x.id == draft_id), None)
            self.state.drafts = [x for x in self.state.drafts if x.id != draft_id]
            original = self._proposed.pop(draft_id, gone.proposal if gone else "")
        if learn and gone is not None:
            self._observe("rejeté", gone.from_, gone.incoming, original, "")

    def catchup(self) -> int:
        """Process unread messages of watched threads, always as drafts (never auto-send)."""
        if self.state.paused:
            raise ActionError(409, "Trame est en pause : rattrapage impossible.")
        watched = [w.thread_id for w in self.state.watchlist if w.watch]
        try:
            unread = self.driver.list_unread(watched)
        except Exception as e:
            raise ActionError(502, f"Lecture des non-lus impossible: {e}")
        # Without the repo search: ~30 s and 3 code searches a message would stall a batch
        # and exhaust GitHub's 10 code searches a minute.
        queued = sum(1 for m in unread if self._process(m, force_draft=True, research=False) == "draft")
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

    # --- favoris : épinglés en haut de la liste, dans l'ordre choisi ---
    def _apply_live_list(self, shown: list[WatchEntity]) -> None:
        """Ce que la liste de Teams montre à l'instant (son début seulement) : non-lu, heure
        du dernier message et ordre sont recopiés sur les conversations connues ; une
        conversation inconnue (nouveau chat) est ajoutée. Les choix de l'utilisateur (suivi,
        mode) ne bougent pas, et les conversations hors de l'écran gardent leur état, rangées
        après celles qu'on voit, dans leur ordre."""
        if not shown:
            return
        with self._lock:
            by_id = {w.thread_id: w for w in self.state.watchlist}
            seen = {e.thread_id for e in shown}
            added: list[WatchEntity] = []
            for e in shown:
                w = by_id.get(e.thread_id)
                if w is None:
                    added.append(e.model_copy())
                    continue
                w.rank, w.last_activity, w.unread = e.rank, e.last_activity, e.unread
                w.is_self, w.own_preview = e.is_self, e.own_preview
            rest = sorted((w for w in self.state.watchlist if w.thread_id not in seen and w.rank is not None),
                          key=lambda w: w.rank or 0)
            for i, w in enumerate(rest, start=len(shown)):
                w.rank = i
            if added:
                self.state.watchlist = self.state.watchlist + added
        if added:
            self._persist_watchlist()

    def _sync_teams_favorites(self, teams: list[str]) -> None:
        """Les favoris de Trame sont ceux de Teams : on retire ceux que Teams n'a plus, on
        ajoute à la suite ceux qu'il a en plus (dans son ordre). L'ordre choisi dans Trame
        est gardé pour les autres."""
        with self._lock:
            current = self.state.favorites
            wanted = set(teams)
            merged = [t for t in current if t in wanted] + [t for t in _unique(teams) if t not in current]
            if merged == current:
                return
            self.state.favorites = merged
        self._persist_favorites()
        self.log("info", f"Favoris alignés sur Teams ({len(merged)})")

    def set_favorite(self, thread_id: str, favorite: bool) -> list[str]:
        """Ajoute (en dernier) ou retire un favori. Rien à voir avec « Suivie » ni le mode.
        Avec Teams intégré, le favori est d'abord posé (ou retiré) dans Teams : refusé là-bas,
        rien ne change ici, sinon la synchro le déferait au prochain coup d'œil."""
        if favorite:
            with self._lock:
                self._entity(thread_id)
        if getattr(self.driver, "supports_teams_favorites", False):
            if not self.driver.set_teams_favorite(thread_id, favorite):
                raise ActionError(502, getattr(self.driver, "last_error", None) or "Teams a refusé le favori.")
        with self._lock:
            if favorite:
                self._entity(thread_id)
                if thread_id not in self.state.favorites:
                    self.state.favorites = [*self.state.favorites, thread_id]
            else:
                self.state.favorites = [t for t in self.state.favorites if t != thread_id]
            favorites = list(self.state.favorites)
        self._persist_favorites()
        return favorites

    def reorder_favorites(self, order: list[str]) -> list[str]:
        """Nouvel ordre des favoris. Seuls les favoris existants comptent ; ceux que l'ordre
        oublie gardent leur place relative, à la suite."""
        with self._lock:
            current = self.state.favorites
            wanted = [t for t in _unique(order) if t in current]
            self.state.favorites = wanted + [t for t in current if t not in wanted]
            favorites = list(self.state.favorites)
        self._persist_favorites()
        return favorites

    # --- archivage ---
    ARCHIVE_EVERY = 600.0

    def set_archived(self, thread_id: str, archived: bool) -> dict:
        """Archiver (ou désarchiver) à la main. Rien n'est supprimé ; dans Teams, la
        conversation n'est masquée que si l'option est active et Graph connecté."""
        with self._lock:
            entity = self._entity(thread_id)
            was = thread_id in self.state.archived
        if archived and not was:
            self._archive(entity, auto=False)
        elif not archived and was:
            self._unarchive(thread_id, None)
        return self.archived_view()

    def archived_view(self) -> dict:
        with self._lock:
            return {t: a.model_dump() for t, a in self.state.archived.items()}

    def can_hide_in_teams(self) -> bool:
        """Masquer dans Teams demande Microsoft Graph : jamais par la page Teams."""
        client = getattr(self.driver, "_client", None)
        try:
            return bool(callable(client) and client() is not None and hasattr(self.driver, "hide_chat"))
        except Exception:
            return False

    def _hide_in_teams(self, thread_id: str, hide: bool) -> bool:
        if not self.can_hide_in_teams():
            return False
        try:
            return bool(self.driver.hide_chat(thread_id, hide))
        except Exception as e:
            self.log("warn", f"Teams : conversation non {'masquée' if hide else 'réaffichée'} ({e})")
            return False

    def _archive(self, entity: WatchEntity, auto: bool) -> None:
        hide = bool((self.cfg.get("archive") or {}).get("hide_in_teams", False))
        hidden = self._hide_in_teams(entity.thread_id, True) if hide else False
        with self._lock:
            self.state.archived = {**self.state.archived, entity.thread_id: Archived(
                at=datetime.now().isoformat(timespec="seconds"), auto=auto, label=entity.last_activity, hidden=hidden)}
        self._persist_archived()
        how = "sans activité depuis longtemps" if auto else "à la main"
        self.log("info", f"Conversation archivée ({how}) : {entity.display_name}" + (" · masquée dans Teams" if hidden else ""))

    def _unarchive(self, thread_id: str, why: Optional[str]) -> None:
        with self._lock:
            info = self.state.archived.get(thread_id)
            if info is None:
                return
            self.state.archived = {t: a for t, a in self.state.archived.items() if t != thread_id}
            name = next((w.display_name for w in self.state.watchlist if w.thread_id == thread_id), thread_id)
        self._persist_archived()
        if info.hidden:
            self._hide_in_teams(thread_id, False)
        self.log("info", f"Conversation désarchivée{f' ({why})' if why else ''} : {name}")

    def _wake_from_list(self, entities: list[WatchEntity]) -> None:
        """Une conversation archivée dont la liste Teams montre une activité nouvelle (non lue,
        ou une autre heure qu'à l'archivage) revient d'elle-même."""
        for e in entities:
            info = self.state.archived.get(e.thread_id)
            if info is None:
                continue
            if e.unread or (e.last_activity and info.label and e.last_activity != info.label):
                self._unarchive(e.thread_id, "nouveau message")

    def auto_archive(self, now: Optional[datetime] = None) -> list[str]:
        """Archive les conversations sans activité depuis le nombre de jours choisi.
        Jamais un favori, une réponse à relire, une relance en cours ni le mode Auto,
        ni une conversation dont l'âge est inconnu."""
        days = settingsmod.archive_after(self.cfg.get("archive") or {})
        if not days:
            return []
        now = now or datetime.now()
        with self._lock:
            drafts = {d.thread_id for d in self.state.drafts}
            follow = {f.thread_id for f in self.state.follow_ups}
            favorites = list(self.state.favorites)
            candidates = [w for w in self.state.watchlist if w.thread_id not in self.state.archived and not w.is_self]
        done: list[str] = []
        for w in candidates:
            if archiving.protected(w.thread_id, favorites=favorites, drafts=drafts, follow_ups=follow,
                                   auto=w.watch and w.mode == "auto"):
                continue
            seen = self._seen_at.get(w.thread_id)
            if archiving.is_stale(archiving.last_activity(w.last_activity, seen, now), days, now.date()):
                self._archive(w, auto=True)
                done.append(w.thread_id)
        return done

    def _archive_loop(self) -> None:
        while not self._stop.wait(self.ARCHIVE_EVERY):
            try:
                self.auto_archive()
            except Exception as e:
                self.log("warn", f"Archivage automatique impossible : {e}")

    def _persist_archived(self) -> None:
        with self._lock:
            cfg = dict(self.cfg)
            cfg["archived"] = {t: a.model_dump() for t, a in self.state.archived.items()}
            self.cfg = cfg
            try:
                cfgmod.save(cfg)
            except Exception as e:
                self.log("warn", f"Sauvegarde des archives impossible: {e}")

    def _persist_favorites(self) -> None:
        with self._lock:
            cfg = dict(self.cfg)
            cfg["favorites"] = list(self.state.favorites)
            self.cfg = cfg
            try:
                cfgmod.save(cfg)
            except Exception as e:
                self.log("warn", f"Sauvegarde des favoris impossible: {e}")

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

    # Plafond de lecture pour une plage de temps : Teams remonte le fil jusqu'à la date,
    # jamais au-delà de ce nombre de messages.
    BRIEF_RANGE_CAP = 300

    @staticmethod
    def brief_since(range_: str, now: Optional[datetime] = None) -> Optional[datetime]:
        """Start of a brief's time range, in local time; None for "the last N messages"."""
        now = now or datetime.now()
        if range_ == "today":
            return now.replace(hour=0, minute=0, second=0, microsecond=0)
        days = {"24h": 1, "7d": 7, "30d": 30}.get(range_)
        return now - timedelta(days=days) if days else None

    def generate_brief(self, thread_id: str, last_messages: Optional[int] = None,
                       range_: Optional[str] = None) -> Brief:
        """Summarise one conversation with a single brain call, then look up related
        GitHub items read-only. Cached in memory only on success. `range_` picks the
        period read: the last N messages ("messages") or a time range (today, 24h, 7d, 30d)."""
        entity = self._conversation(thread_id)
        prefs = self.get_settings()
        if not prefs.brief.enabled:
            raise ActionError(409, "Le résumé de conversation est désactivé dans les réglages.")
        name = entity.display_name
        range_ = range_ or prefs.brief.range
        since = self.brief_since(range_)
        if since is None:
            msgs = self._read_focused(thread_id, name, last_messages or prefs.brief.last_messages)
        else:
            msgs = self._read_focused(thread_id, name, self.BRIEF_RANGE_CAP, since=since)
        if not msgs and since is not None:
            self.log("info", f"Résumé de {name} : aucun message depuis le {since:%d/%m %H:%M}")
            raise ActionError(502, "Aucun message dans Teams sur cette période : choisis une plage plus large.")
        if not msgs:
            self.log("warn", f"Résumé impossible pour {name} : aucun message lisible")
            raise ActionError(502, "Aucun message lisible dans cette conversation : rien n'a été résumé.")
        transcript = "\n".join(f"[{m.received_at}] {m.sender}: {m.text}" if m.received_at else f"{m.sender}: {m.text}" for m in msgs)

        try:
            raw = self.brain.ask(build_brief_prompt(name, transcript),
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
            sources=BriefSources(messages=len(msgs), repos_searched=repos_searched, range=range_),
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

    def _knowledge(self, text: str, summary: str) -> str:
        """What the team's repos say about the question (docs, code), read-only; "" when
        GitHub or this search (`context.github.knowledge`) is off. Never blocks a draft:
        any failure means a reply written without it."""
        prefs = self.get_settings()
        gh_cfg = self.cfg.get("context", {}).get("github", {})
        if not prefs.github.enabled or not gh_cfg.get("knowledge", True) or not text.strip():
            return ""
        try:
            repos = gh.list_repos() if prefs.github.all_repos else gh_cfg.get("repos_allowlist", [])
            with telemetry.span("github.knowledge", repos=len(repos)) as sp:
                out = ghknow.gather(lambda p, t: self.brain.complete(p, timeout=t), text, summary,
                                    repos, prefs.github.all_repos)
                telemetry.set_attrs(sp, chars=len(out))
            if out:
                read = [line[4:-4] for line in out.splitlines() if line.startswith("=== ") and line.endswith(" ===")]
                reflection.step(f"Dépôts lus : {', '.join(read)}")
            return out
        except Exception as e:
            self.log("warn", f"Recherche dans les dépôts impossible : {e}")
            return ""

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
            raw = self.brain.ask(build_factcheck_prompt(text, transcript, people, github, _today()), timeout=timeout)
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
        def said(m: dict) -> str:
            return brain_text(m["text"], [LinkRef(**x) for x in m.get("links") or []], [CardRef(**x) for x in m.get("cards") or []],
                              QuoteRef(**m["quote"]) if m.get("quote") else None)
        lines = [f"[{m['at']}] {m['sender']}: {said(m)}" if m.get("at") else f"{m['sender']}: {said(m)}" for m in msgs]
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

    def _read_focused(self, thread_id: str, name: str, last_n: int, purpose: str = "Résumé",
                      since: Optional[datetime] = None) -> list[IncomingMessage]:
        # For the brain (brief, proposal): text only. A message with only an image or a
        # file says so in words, without the image data.
        return [self._as_text(m) for m in self._read_history_focused(thread_id, name, last_n, purpose, since)[0]
                if m.text or m.files or m.images or m.cards]

    # Most images shown to the brain with one request (the most recent of the thread).
    BRAIN_IMAGES = 4

    def _brain_view(self, raw: list[IncomingMessage]) -> tuple[list[IncomingMessage], list[str]]:
        """Messages as the brain reads them, and the images it gets to see: on a brain
        with vision, the most recent images of the thread that Trame could capture, numbered
        in order ([image 1], [image 2]...). Any other image stays « [image] »."""
        picked: list[tuple[int, int, str]] = []
        if getattr(self.brain, "supports_images", False):
            for i in range(len(raw) - 1, -1, -1):
                for j in range(len(raw[i].images) - 1, -1, -1):
                    data = raw[i].images[j].data
                    if data and len(picked) < self.BRAIN_IMAGES:
                        picked.append((i, j, data))
            picked.reverse()
        number = {(i, j): n for n, (i, j, _) in enumerate(picked, 1)}
        msgs = [self._as_text(m, [number.get((i, j)) for j in range(len(m.images))]) for i, m in enumerate(raw)]
        return msgs, [data for _, _, data in picked]

    def _draft_reply(self, summary: str, incoming: str, gh_ctx: str, people: str, images: list[str]) -> str:
        """`brain.draft`, with the thread's images when there are some (a brain without
        vision never gets them: `_brain_view` only picks images for one that has it)."""
        if images:
            return self.brain.draft(self.soul, summary, incoming, gh_ctx, people, images=images)
        return self.brain.draft(self.soul, summary, incoming, gh_ctx, people)

    @staticmethod
    def _as_text(m: IncomingMessage, numbers: Optional[list[Optional[int]]] = None) -> IncomingMessage:
        # Links as « text (address) » and one line per preview card: the brain sees
        # where a link goes, never the card's labels and buttons. An image shown to the
        # brain carries its number (« [image 2] »), the others stay « [image] ».
        numbers = numbers or []
        extra = [f"[fichier joint : {f.name}]" for f in m.files] + \
            [f"[image {numbers[j]}]" if j < len(numbers) and numbers[j] else "[image]" for j in range(len(m.images))]
        if not extra and not m.links and not m.cards and not m.quote:
            return m
        return m.model_copy(update={"text": "\n".join([m.brain_text(), *extra]).strip(), "images": []})

    def _read_history_focused(self, thread_id: str, name: str, last_n: int, purpose: str = "Résumé",
                              since: Optional[datetime] = None) -> tuple[list[IncomingMessage], bool]:
        """Open the conversation just long enough to read it, then reopen the previous one.
        Also tells whether the start of the conversation was reached. A driver that can read
        a thread without opening it (service de chat de Teams) is tried first."""
        direct = self._read_direct(thread_id, name, last_n, purpose, since)
        if direct is not None:
            return direct
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
                        msgs, top = (self.driver.read_history(thread_id, last_n, since) if since is not None
                                     else self.driver.read_history(thread_id, last_n))
                        self.archive.add(thread_id, msgs)
                        self._track(thread_id, msgs)
                    telemetry.set_attrs(sp, confirmed=focus.ok, messages=len(msgs), top=top)
            except Exception as e:
                self.log("warn", f"{purpose} impossible pour {name} : lecture de la conversation échouée ({e})")
                raise ActionError(502, "Lecture de la conversation impossible dans Teams. Rien n'a été perdu, tu peux réessayer.")
        self._warn_if_not_restored(focus)
        if not focus.ok:
            self.log("warn", f"{purpose} impossible pour {name} : {focus.reason or 'conversation non confirmée dans Teams'}")
            raise ActionError(409, f"Impossible d'ouvrir la conversation « {name} » dans Teams.")
        return msgs, top

    def _read_direct(self, thread_id: str, name: str, last_n: int, purpose: str,
                     since: Optional[datetime] = None) -> Optional[tuple[list[IncomingMessage], bool]]:
        """The thread read without opening it in Teams (so neither the user's view nor the
        conversation's read state change). None when the driver cannot: read the page then."""
        read = getattr(self.driver, "read_history_direct", None)
        if not callable(read):
            return None
        with telemetry.span("teams.read", conversation=name, purpose=purpose, last_n=last_n, via="api") as sp:
            out = read(thread_id, last_n, since)
            if out is None:
                telemetry.set_attrs(sp, fallback=True)
                return None
            msgs, top = out
            self.archive.add(thread_id, msgs)
            self._track(thread_id, msgs)
            telemetry.set_attrs(sp, confirmed=True, messages=len(msgs), top=top)
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

    # --- agent skills ---
    def skills_summary(self) -> dict:
        return self.skills.summary()

    def _save_skills(self, change: Callable[[dict], None]) -> None:
        with self._lock:
            cfg = json.loads(json.dumps(self.cfg))
            section = cfg.get("skills") if isinstance(cfg.get("skills"), dict) else {}
            section.setdefault("dirs", ["~/.agents/skills"])
            section.setdefault("repos", [])
            section.setdefault("state", {})
            change(section)
            cfg["skills"] = section
            try:
                cfgmod.save(cfg)
            except Exception as e:
                raise ActionError(500, f"Sauvegarde des réglages impossible : {e}")
            self.cfg = cfg

    def set_skill_enabled(self, name: str, enabled: bool) -> dict:
        if self.skills.find(name) is None:
            raise ActionError(404, "Skill introuvable.")
        self._save_skills(lambda s: s["state"].__setitem__(name, bool(enabled)))
        self.log("info", f"Skill {name} {'activé' if enabled else 'désactivé'}")
        return self.skills.summary()

    def set_skill_dirs(self, dirs: list[str]) -> dict:
        clean = list(dict.fromkeys(d.strip() for d in dirs if d.strip()))
        if len(clean) > 10 or any(len(d) > 300 or "\n" in d for d in clean):
            raise ActionError(422, "Dix dossiers au plus, un chemin par ligne.")
        self._save_skills(lambda s: s.__setitem__("dirs", clean))
        self.skills.reload()
        return self.skills.summary()

    def reload_skills(self) -> dict:
        self.skills.reload()
        summary = self.skills.summary()
        self.log("info", f"Skills rechargés : {len(summary['skills'])} trouvé(s), {len(summary['ignored'])} ignoré(s)")
        return summary

    def sync_skill_repo(self, url: str, branch: str) -> dict:
        """Install or update a git repository of skills (shallow clone, nothing run)."""
        try:
            url, branch = skillsmod.check_repo(url, branch)
        except ValueError as e:
            raise ActionError(422, str(e))
        target = self.skills.repos_dir / skillsmod.repo_slug(url, branch)
        try:
            commit = skillsmod.sync_repo(target, url, branch)
        except Exception as e:
            self.log("warn", f"Dépôt de skills {url} : {e}")
            raise ActionError(502, f"Récupération impossible : {e}")

        def add(s: dict) -> None:
            if not any(r.get("url") == url and (r.get("branch") or "") == branch for r in s["repos"]):
                s["repos"].append({"url": url, "branch": branch})
        self._save_skills(add)
        self.skills.reload()
        self.log("info", f"Dépôt de skills {url} à jour ({commit or 'commit inconnu'})")
        return self.skills.summary()

    def remove_skill_repo(self, url: str, branch: str) -> dict:
        target = self.skills.repos_dir / skillsmod.repo_slug(url, branch)
        self._save_skills(lambda s: s.__setitem__(
            "repos", [r for r in s["repos"] if not (r.get("url") == url and (r.get("branch") or "") == branch)]))
        if target.is_dir() and target.resolve().parent == self.skills.repos_dir.resolve():
            shutil.rmtree(target, ignore_errors=True)
        self.skills.reload()
        return self.skills.summary()

    # --- meeting reports ---
    def start_meeting_report(self, thread_id: str = "", mid: str = "", title: str = "", day: Optional[str] = None,
                             skill: str = "meeting-report", path: Optional[str] = None) -> dict:
        """Apply a skill to a meeting's .vtt: the file already fetched (same name in the
        transcripts folder, or path inside it), else fetched from Teams first."""
        found = self.skills.find(skill)
        if found is None:
            raise ActionError(404, f"Skill « {skill} » introuvable : installe-le dans un dossier de skills "
                                   "(Réglages › Skills), puis recharge la liste.")
        folder = transcriptsmod.chosen_dir(cfgmod._home())
        vtt: Optional[Path] = None
        candidate = Path(path) if path else None
        # Only a .vtt of the transcripts folder: anything else is ignored (the meeting is
        # then found by name, or fetched again).
        usable = candidate is not None and candidate.suffix.lower() == ".vtt" and candidate.is_file()
        if usable and candidate.resolve().parent == folder.resolve():
            vtt = candidate
        else:
            try:
                when = date.fromisoformat(day) if day else None
            except ValueError:
                when = None
            candidate = folder / transcriptsmod.file_name(title, when)
            if title and candidate.is_file():
                vtt = candidate
            elif thread_id and mid:
                saved = self.save_transcript(thread_id, mid)
                vtt, title = Path(saved["path"]), title or saved.get("title", "")
            else:
                raise ActionError(422, "Réunion ou fichier .vtt à préciser.")
        try:
            return self.reports.start(found, vtt, title or vtt.stem,
                                      transcriptsmod.meeting_id(thread_id, mid) if thread_id and mid else "")
        except reportsmod.ReportError as e:
            raise ActionError(e.status, e.message)

    def report_call(self, fn: Callable[..., dict], *args) -> dict:
        try:
            return fn(*args)
        except reportsmod.ReportError as e:
            raise ActionError(e.status, e.message)

    # --- publishing a meeting report to GitHub (write, off by default) ---
    _ISO_PREFIX = re.compile(r"^(\d{4}-\d{2}-\d{2})")

    def _report(self, report_id: str):
        try:
            return self.reports.get(report_id)
        except reportsmod.ReportError as e:
            raise ActionError(e.status, e.message)

    def _write_cfg(self) -> tuple[settingsmod.GithubWriteSettings, dict]:
        w = self.get_settings().github.write
        raw = self.cfg.get("context", {}).get("github", {}).get("write", {}) or {}
        return w, raw if isinstance(raw, dict) else {}

    def _match_repos(self, w: settingsmod.GithubWriteSettings) -> list[str]:
        """Repos a meeting title / name match may point to: the write allowlist, plus the
        account's repos when write is set to « all »."""
        repos = list(w.repos_allowlist)
        if w.all_repos:
            try:
                repos += [r for r in gh.list_repos() if r not in repos]
            except Exception:
                pass
        return repos

    @staticmethod
    def _scope_ok(scopes: list[str]) -> bool:
        return any(s in ("repo", "public_repo") for s in scopes)

    def _publish_blocked(self, w, gh_status, has_report: bool) -> str:
        if not w.enabled:
            return "L'ouverture de pull requests est désactivée (Réglages › GitHub)."
        if gh_status is not None and not gh_status.installed:
            return "gh n'est pas installé sur ce poste."
        if gh_status is not None and not gh_status.logged_in:
            return "Connecte-toi d'abord à GitHub (Réglages › GitHub)."
        if gh_status is not None and not self._scope_ok(gh_status.scopes):
            return ("Le jeton GitHub n'a pas le droit d'écrire : reconnecte-toi à GitHub avec l'accès "
                    "« repo » (contents + pull requests). Trame ne touche jamais au jeton.")
        if not has_report:
            return "Pas encore de compte-rendu à publier."
        return ""

    def _date_of(self, s) -> Optional[str]:
        m = self._ISO_PREFIX.match(s.vtt_path.stem)
        return m.group(1) if m else None

    def github_publish_plan(self, report_id: str, gh_status=None) -> dict:
        s = self._report(report_id)
        w, raw = self._write_cfg()
        repo_map = raw.get("repo_map", {}) if isinstance(raw.get("repo_map"), dict) else {}
        guess = ghpublish.resolve_repo(s.title, s.vtt, self._match_repos(w), repo_map)
        path = ghpublish.report_path(w.path_template, self._date_of(s), s.title)
        blocked = self._publish_blocked(w, gh_status, bool(s.report))
        repos: list[str] = []
        state = None
        if w.enabled and (gh_status is None or (gh_status.logged_in and self._scope_ok(gh_status.scopes))):
            try:
                repos = self.github_writer.writable_repos(w.all_repos, w.repos_allowlist)
            except Exception:
                repos = list(w.repos_allowlist)
            if guess is not None:
                try:
                    state = self.github_writer.report_state(guess.repo, path)
                except ghpublish.PublishError:
                    state = None
        plan = ghpublish.PublishPlan(
            report_id=s.id, write_enabled=w.enabled,
            repo=guess.repo if guess else None, repo_reason=guess.reason if guess else "",
            repo_confident=bool(guess and guess.confident), path=path,
            branch=ghpublish.branch_for(path), base="", draft=w.draft, repos=repos, state=state, blocked=blocked)
        return plan.as_dict()

    def github_publish(self, report_id: str, repo: str, path: Optional[str], draft: Optional[bool], gh_status=None) -> dict:
        s = self._report(report_id)
        w, _raw = self._write_cfg()
        blocked = self._publish_blocked(w, gh_status, bool(s.report))
        if blocked:
            raise ActionError(403 if "jeton" in blocked or "Connecte" in blocked else 409, blocked)
        repo = (repo or "").strip()
        if not ghpublish._REPO_RE.match(repo):
            raise ActionError(422, "Dépôt invalide (attendu : owner/nom).")
        if not w.all_repos and repo not in w.repos_allowlist:
            raise ActionError(403, f"Dépôt « {repo} » non autorisé : ajoute-le à la liste des dépôts "
                                   "autorisés (Réglages › GitHub).")
        target = (path or "").strip() or ghpublish.report_path(w.path_template, self._date_of(s), s.title)
        use_draft = w.draft if draft is None else bool(draft)
        body = (f"Compte-rendu de la réunion « {s.title} », préparé par Trame avec le skill "
                f"`{s.skill.name}` et relu par l'utilisateur.\n\n"
                f"- Transcription : `{s.vtt_path.name}` ({s.cues} prises de parole)\n"
                f"- Brouillon : à relire et compléter avant fusion.\n")
        try:
            result = self.github_writer.create_report_pr(repo, target, s.title, s.report, draft=use_draft, pr_body=body)
        except ghpublish.PublishError as e:
            raise ActionError(e.status, e.message)
        self._remember_repo(s.title, repo)
        published = {"url": result["url"], "number": result.get("number"), "draft": result["draft"],
                     "repo": repo, "path": result["path"], "branch": result["branch"]}
        with self._lock:
            s.published = published
            s.rev += 1
        self._report_state_cache.pop(s.meeting_id, None)
        self.log("info", f"Compte-rendu de « {s.title} » publié sur {repo} : pull request #{result.get('number')}"
                         f"{' (brouillon)' if result['draft'] else ''}")
        return {"published": published, "report": self.reports.snapshot(report_id)}

    def github_report_state(self, meeting_id: str, title: str, date: Optional[str], path: Optional[str], gh_status=None) -> dict:
        if gh_status is not None and (not gh_status.installed or not gh_status.logged_in):
            return {"repo": None, "reason": "", "repoConfident": False}
        now = time.time()
        cached = self._report_state_cache.get(meeting_id) if meeting_id else None
        if cached and now - cached[0] < 120.0:
            return cached[1]
        w, raw = self._write_cfg()
        repo_map = raw.get("repo_map", {}) if isinstance(raw.get("repo_map"), dict) else {}
        transcript = ""
        if path:
            try:
                folder = transcriptsmod.chosen_dir(cfgmod._home()).resolve()
                p = Path(path)
                if p.suffix.lower() == ".vtt" and p.is_file() and p.resolve().parent == folder:
                    transcript = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                transcript = ""
        guess = ghpublish.resolve_repo(title, transcript, self._match_repos(w), repo_map)
        if guess is None:
            result = {"repo": None, "reason": "", "repoConfident": False}
        else:
            target = ghpublish.report_path(w.path_template, date, title)
            try:
                state = self.github_writer.report_state(guess.repo, target)
                result = {**state.as_dict(), "repoConfident": guess.confident, "repoReason": guess.reason}
            except ghpublish.PublishError:
                result = {"repo": guess.repo, "reason": "", "repoConfident": guess.confident, "exists": False}
        if meeting_id:
            self._report_state_cache[meeting_id] = (now, result)
        return result

    def _remember_repo(self, title: str, repo: str) -> None:
        key = ghpublish.title_key(title)
        if not key:
            return
        with self._lock:
            cfg = json.loads(json.dumps(self.cfg))
            write = cfg.setdefault("context", {}).setdefault("github", {}).setdefault("write", {})
            repo_map = write.get("repo_map")
            if not isinstance(repo_map, dict):
                repo_map = {}
            repo_map[key] = repo
            write["repo_map"] = repo_map
            try:
                cfgmod.save(cfg)
            except Exception:
                return
            self.cfg = cfg

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
            self.soul_history.clear()
            self.soul_signals.clear()
            personamod.save_state({})
            self.soul_history.snapshot(self.soul, "initial", "Persona par défaut (réinitialisation)")
            self.people = peoplemod.restore_default()
            self._briefs.clear()
            self._history.clear()
            self._thread_cache.clear()
            self.archive.clear()
            self._sent_recent.clear()
            self.follow_ups.clear()
            self.state.follow_ups = []
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
            self.state.favorites = []
            self.state.archived = {}
        self.log("info", "Trame réinitialisé : configuration à refaire")

    def set_soul(self, content: str, source: personamod.Source = "manuel", note: str = "") -> None:
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
            try:
                self.soul_history.snapshot(content, source, note)
            except OSError as e:
                self.log("warn", f"Version du persona non conservée : {e}")
        self.log("info", "Persona appris des conversations" if source == "appris" else "Persona mis à jour")

    # --- persona : lecture, versions, apprentissage ---
    SUGGESTION_TTL = 1800.0
    LEARN_SIGNALS = 40

    def _learning_cfg(self) -> tuple[bool, int]:
        learning = (self.cfg.get("persona") or {}).get("learning") or {}
        try:
            every = min(50, max(3, int(learning.get("every", personamod.LEARN_EVERY))))
        except (TypeError, ValueError):
            every = personamod.LEARN_EVERY
        return bool(learning.get("enabled", True)), every

    def soul_details(self) -> dict:
        enabled, every = self._learning_cfg()
        state = personamod.load_state()
        signals = self.soul_signals.all()
        waiting = personamod.pending(signals, str(state.get("last_at", "")))
        return {
            "content": self.soul,
            "custom": cfgmod.soul_is_custom(),
            "parsed": personamod.parse(self.soul),
            "history": self.soul_history.list(),
            "learning": {
                "enabled": enabled, "every": every, "running": self._learning,
                "pending": len(waiting), "informative": personamod.informative(waiting),
                "total": len(signals), "last_at": state.get("last_at"), "last_run_at": state.get("last_run_at"),
                "last_result": state.get("last_result"),
                "recent": [{k: s.get(k, "") for k in ("at", "kind", "conversation", "proposal", "final")}
                           for s in reversed(signals[-10:])],
            },
        }

    def soul_version(self, version_id: str) -> dict:
        entry = next((v for v in self.soul_history.list() if v["id"] == version_id), None)
        try:
            content = self.soul_history.read(version_id)
        except KeyError:
            raise ActionError(404, "Version introuvable.")
        return {**(entry or {"id": version_id}), "content": content, "parsed": personamod.parse(content)}

    def restore_soul(self, version_id: str) -> None:
        version = self.soul_version(version_id)
        try:
            when = datetime.fromisoformat(str(version.get("at"))).strftime("%d/%m/%Y à %H:%M")
        except (TypeError, ValueError):
            when = ""
        self.set_soul(version["content"], "restauré", f"Version du {when}" if when else "")

    def set_soul_learning(self, enabled: Optional[bool] = None, every: Optional[int] = None) -> None:
        with self._lock:
            cfg = json.loads(json.dumps(self.cfg))
            persona = cfg.get("persona") if isinstance(cfg.get("persona"), dict) else {}
            learning = persona.get("learning") if isinstance(persona.get("learning"), dict) else {}
            if enabled is not None:
                learning["enabled"] = bool(enabled)
            if every is not None:
                if not 3 <= every <= 50:
                    raise ActionError(422, "Apprendre tous les 3 à 50 échanges.")
                learning["every"] = every
            persona["learning"] = learning
            cfg["persona"] = persona
            try:
                cfgmod.save(cfg)
            except Exception as e:
                raise ActionError(500, f"Sauvegarde des réglages impossible: {e}")
            self.cfg = cfg

    def forget_soul_signals(self) -> None:
        self.soul_signals.clear()
        personamod.save_state({**personamod.load_state(), "last_at": None})
        self.log("info", "Persona : exemples observés oubliés")

    def _observe_reply(self, conversation: str, incoming: str, proposal: str, final: str) -> None:
        same = " ".join(proposal.split()) == " ".join(final.split())
        self._observe("accepté" if same else "corrigé", conversation, incoming, proposal, final)

    def _observe_written(self, thread_id: str, conversation: str, body: str) -> None:
        with self._lock:
            suggested = self._suggested.pop(thread_id, None)
        if suggested and time.monotonic() - suggested[0] < self.SUGGESTION_TTL:
            self._observe_reply(conversation, suggested[2], suggested[1], body)
        else:
            self._observe("écrit", conversation, "", "", body)

    def _observe(self, kind: personamod.SignalKind, conversation: str, incoming: str, proposal: str, final: str) -> None:
        """Garde ce que tu as fait d'une réponse, puis apprend quand assez s'est accumulé."""
        enabled, every = self._learning_cfg()
        if not enabled:
            return
        try:
            self.soul_signals.add(kind, conversation, incoming, proposal, final)
        except OSError:
            return
        waiting = personamod.pending(self.soul_signals.all(), str(personamod.load_state().get("last_at", "")))
        if personamod.informative(waiting) >= every and not self._learning:
            threading.Thread(target=self._learn_quietly, daemon=True).start()

    def _learn_quietly(self) -> None:
        try:
            self.learn_soul()
        except ActionError as e:
            self.log("warn", f"Persona : apprentissage reporté ({e.message})")
        except Exception as e:  # pragma: no cover - dernier filet du fil d'arrière-plan
            self.log("warn", f"Persona : apprentissage reporté ({e})")

    def learn_soul(self) -> dict:
        """Met à jour la section « Appris des conversations » d'après ce que tu as fait des
        réponses depuis la dernière fois. Le reste du SOUL.md n'est jamais réécrit."""
        with self._lock:
            if self._learning:
                raise ActionError(409, "Un apprentissage est déjà en cours.")
            self._learning = True
        try:
            state = personamod.load_state()
            waiting = personamod.pending(self.soul_signals.all(), str(state.get("last_at", "")))
            if not personamod.informative(waiting):
                raise ActionError(409, "Rien de nouveau à apprendre : corrige, écarte ou écris quelques réponses d'abord.")
            batch = waiting[-self.LEARN_SIGNALS:]
            before = personamod.learned_rules(self.soul)
            try:
                answer = self.brain.complete(personamod.build_prompt(self.soul, batch), timeout=120)
            except Exception as e:
                raise ActionError(502, f"Le cerveau n'a pas pu tirer de leçon : {e}")
            rules = personamod.parse_rules(answer or "")
            if not rules and before:
                raise ActionError(502, "Réponse du cerveau inexploitable : le persona est inchangé.")
            added = [r for r in rules if r not in before]
            removed = [r for r in before if r not in rules]
            result = {"changed": bool(added or removed), "rules": rules, "added": added, "removed": removed,
                      "signals": len(batch)}
            if result["changed"]:
                with self._lock:
                    updated = personamod.with_learned(self.soul, rules)
                note = f"{len(added)} ajoutée(s), {len(removed)} retirée(s), d'après {len(batch)} échange(s)"
                self.set_soul(updated, "appris", note)
            now = datetime.now().isoformat(timespec="seconds")
            personamod.save_state({**state, "last_at": batch[-1]["at"], "last_run_at": now,
                                   "last_result": {k: result[k] for k in ("changed", "added", "removed", "signals")}})
            return result
        finally:
            with self._lock:
                self._learning = False

    # --- helpers ---
    HISTORY_TTL = 120.0

    def _read_context_focused(self, thread_id: str, last_n: int) -> Optional[list[IncomingMessage]]:
        """The last messages read in the page: the conversation is opened just long enough,
        then the previous one reopened. None during a screen share (nothing is opened)."""
        with self._ui_lock:
            if self.driver._current() == thread_id:
                return self.driver.read_context(thread_id, last_n)
            if self._screen_share_guarded():
                return None
            msgs: list[IncomingMessage] = []
            with self.driver.focused(thread_id, restore=True) as focus:
                if focus.ok:
                    msgs = self.driver.read_context(thread_id, last_n)
            self._warn_if_not_restored(focus)
            return msgs

    def _summary(self, thread_id: str, last_n: int) -> str:
        """History for drafting. Opens the conversation just long enough to read it
        and reopens the previous one; reused for HISTORY_TTL so a burst of messages
        doesn't keep switching the user's view. Never switches during a screen share."""
        cached = self._history.get(thread_id)
        if cached and time.monotonic() - cached[0] < self.HISTORY_TTL:
            return cached[1]
        msgs: list[IncomingMessage] = []
        read = getattr(self.driver, "read_history_direct", None)
        try:
            # Lu sans ouvrir la conversation quand le pilote le peut, sinon par la page.
            direct = read(thread_id, last_n) if callable(read) else None
            if direct is not None:
                msgs = direct[0]
            else:
                msgs = self._read_context_focused(thread_id, last_n)
                if msgs is None:
                    return ""
        except Exception:
            return ""
        self.archive.add(thread_id, msgs)
        self._track(thread_id, msgs)
        seen, images = self._brain_view([m for m in msgs if m.text or m.files or m.images or m.cards])
        text = "\n".join(f"{m.sender}: {m.text}" for m in seen)
        if text:
            self._history[thread_id] = (time.monotonic(), text)
        self._history_images[thread_id] = images if text else []
        return text

    def _merge(self, discovered: list[WatchEntity]) -> list[WatchEntity]:
        """Teams is the source of names and kinds; the saved list only keeps the user's
        choices (followed, mode, named people). Entries saved by older versions under the
        raw rail label ("name:Chat X Offline Last message …") are carried over to the
        clean id, then dropped."""
        if not discovered:
            return self.state.watchlist
        self._learn_self_name(discovered)
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
        # A chat saved under its name (started from Trame, or listed without an id), now
        # listed with Teams' own id (page or Microsoft Graph): the choices follow it.
        moved: set[str] = set()
        for w in self.state.watchlist:
            if not w.thread_id.startswith("name:"):
                continue
            target = by_name.get(rail_label.parse(w.thread_id[5:]).name.casefold())
            if target and target != w.thread_id and not target.startswith("name:"):
                prev = by_id.get(target)
                if prev is None or (w.watch and not prev.watch):
                    by_id[target] = w
                moved.add(w.thread_id)
                if w.thread_id in self._started:
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
            if w.thread_id not in found and w.thread_id not in legacy and (
                    w.watch or w.thread_id in self._started or w.thread_id in self.state.favorites
                    or w.thread_id in self.state.archived):
                out.append(w)
        self._wake_from_list(out)
        return out

    def health(self) -> dict:
        """Santé de Trame : chaque point avec son état et quoi en penser (page Santé)."""
        import health as healthmod
        relay = getattr(self.driver, "relay_connected", None)
        st = self.state
        items = [
            healthmod.teams(st.selftest_ok, relay() if callable(relay) else None, type(self.driver).__name__),
            healthmod.page(st.teams_check),
            healthmod.outbox(st.outbox),
            healthmod.brain(self.brain.label or st.brain, getattr(self.brain, "model", "") or "", self._brain_error),
            healthmod.pause(st.paused, st.screen_sharing),
            healthmod.disk(cfgmod.HOME),
        ]
        return {"status": healthmod.overall(items), "items": [i.model_dump() for i in items],
                "version": os.environ.get("TRAME_VERSION", "dev"), "uptime_s": int(time.time() - self._started_at)}

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


def _archived(raw) -> dict:
    out = {}
    if isinstance(raw, dict):
        for t, a in raw.items():
            try:
                out[str(t)] = Archived(**a) if isinstance(a, dict) else Archived(at=str(a))
            except Exception:
                continue
    return out
