from __future__ import annotations
from abc import ABC, abstractmethod
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Iterable, Iterator, Optional, Sequence
from models import IncomingMessage, MessageRef, WatchEntity

if TYPE_CHECKING:
    from attachments import Attachment


class SendUncertain(RuntimeError):
    """Send was pressed but could not be confirmed: the message may have left."""


class ReactUncertain(RuntimeError):
    """The reaction was clicked but Teams did not show it: it may or may not be there."""


class DeleteUncertain(RuntimeError):
    """« Supprimer » was clicked but Teams did not show the message as deleted."""


class NotSupported(RuntimeError):
    """The active Teams driver cannot do this gesture (reaction, reply to a message)."""


@dataclass
class Focus:
    """Outcome of a temporary focus: whether the target was confirmed active, the
    conversation that was open before, and whether it was put back (None: nothing to restore)."""

    ok: bool
    previous: Optional[str] = None
    restored: Optional[bool] = None
    reason: Optional[str] = None


def _flat(s: str) -> str:
    return " ".join((s or "").replace(" ", " ").split()).casefold()


def same_message(ref: MessageRef, sender: str, text: str) -> bool:
    """The message read in Teams is the one the user picked: same author (when both are
    known) and same text, compared on its first 80 characters, spaces and case aside."""
    if ref.sender.strip() and sender.strip() and _flat(ref.sender) != _flat(sender):
        return False
    want, got = _flat(ref.text)[:80], _flat(text)[:80]
    return bool(want) and want == got


class TeamsDriver(ABC):
    last_error: Optional[str] = None
    # Gestes en plus de la saisie : réagir à un message, répondre à un message précis.
    supports_reactions: bool = False
    supports_reply: bool = False
    supports_mentions: bool = False
    # Supprimer un de ses propres messages (jamais celui d'un autre).
    supports_delete: bool = False
    delete_unsupported: str = "Ce pilote Teams ne sait pas supprimer un message."
    """Abstraction over the Teams client. Implemented by MockTeamsDriver (any OS,
    for development) and WindowsUIADriver (real UIA driving, Windows only)."""

    @abstractmethod
    def selftest(self) -> bool:
        """Verify selectors resolve: compose box, message list, chat rail. Gates auto mode."""

    @abstractmethod
    def list_conversations(self) -> list[WatchEntity]:
        """Enumerate the left-rail conversations with stable thread-id + display name."""

    @abstractmethod
    def is_screen_sharing(self) -> bool:
        """True while a Teams screen share is active (auto-pause trigger)."""

    @abstractmethod
    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        """Read the last N messages of a thread (sender carried forward across runs)."""

    def read_history(self, thread_id: str, last_n: int) -> tuple[list[IncomingMessage], bool]:
        """Like read_context, going back further when the driver can, plus whether the
        start of the conversation was reached (nothing older to fetch)."""
        msgs = self.read_context(thread_id, last_n)
        return msgs, len(msgs) < last_n

    @abstractmethod
    def open_thread(self, thread_id: str) -> bool:
        """Make thread_id the active conversation. True only once it is confirmed active."""

    @abstractmethod
    def active_thread(self) -> Optional[str]:
        """Thread id of the conversation currently open in Teams, None if none or unknown."""

    def _current(self) -> Optional[str]:
        try:
            return self.active_thread()
        except Exception:
            return None

    @contextmanager
    def focused(self, thread_id: str, restore: bool = True) -> Iterator[Focus]:
        """Open thread_id for the duration of the block, then (restore=True) reopen the
        conversation the user was looking at. Callers must check `focus.ok` before acting."""
        previous = self._current()
        focus = Focus(ok=False, previous=previous)
        self.last_error = None
        try:
            focus.ok = bool(self.open_thread(thread_id))
        except Exception as e:
            focus.ok = False
            self.last_error = str(e)
        if not focus.ok:
            focus.reason = self.last_error or "conversation pas ouverte ou pas confirmée dans Teams"
        try:
            yield focus
        finally:
            if restore and previous is not None and previous != thread_id and self._current() != previous:
                try:
                    focus.restored = bool(self.open_thread(previous))
                except Exception:
                    focus.restored = False

    def mark_read(self, thread_id: str) -> bool:
        """Mark the conversation as read in Teams, without opening it. True once Teams
        no longer shows it unread (or it already was read); False with last_error otherwise."""
        self.last_error = "marquer comme lu n'est pas pris en charge par ce pilote"
        return False

    def clear_compose(self, thread_id: str) -> bool:
        """Empty the compose box of thread_id (text, pending attachments, pasted items), at
        the user's explicit request: a leftover there blocks every send. Opens the
        conversation, then puts back the previous one. True only once it is empty."""
        with self.focused(thread_id, restore=True) as focus:
            if not focus.ok:
                return False
            try:
                return bool(self._clear_active(thread_id))
            except Exception as e:
                self.last_error = str(e)
                return False

    def _clear_active(self, thread_id: str) -> bool:
        self.last_error = "vider la zone de saisie n'est pas pris en charge par ce pilote"
        return False

    def show_thread(self, thread_id: str) -> bool:
        """Bring Teams to the front on this conversation, for the user to read it there.
        Nothing is typed, so no strict confirmation is needed. False if not found."""
        return bool(self.open_thread(thread_id))

    # --- presence ---
    PRESENCE_TTL = 90.0
    """A status read longer ago than this is dropped: Teams stopped saying (window
    closed, relay gone), and no dot beats a stale one."""

    def _note_presence(self, thread_id: str, value: Optional[str]) -> None:
        """Record what Teams shows for thread_id right now (None: nothing recognised)."""
        cache = self.__dict__.setdefault("_presence_cache", {})
        if value:
            cache[thread_id] = (time.monotonic(), value)
        else:
            cache.pop(thread_id, None)

    def presence(self) -> dict[str, str]:
        """Presence of the people of 1:1 chats, by thread id, as last seen in the chat
        list the driver already polls (no extra reading of Teams). Empty when the
        driver cannot tell: the UI then shows no status at all."""
        cache = self.__dict__.get("_presence_cache", {})
        now = time.monotonic()
        return {tid: value for tid, (at, value) in list(cache.items()) if now - at <= self.PRESENCE_TTL}

    # --- activity: someone typing, your last message seen ---
    TYPING_TTL = 12.0
    """« En train d'écrire » read longer ago than this is dropped: the chat list is
    polled every few seconds, a missed poll must not leave the dots on for good."""

    def _note_activity(self, thread_id: str, typing: bool, typing_text: Optional[str] = None,
                       seen: Optional[bool] = None) -> None:
        """Record what Teams shows for thread_id right now. typing_text and seen come
        only from the conversation open in Teams' window (None for the others): a read
        receipt is kept only while that conversation stays open there."""
        cache = self.__dict__.setdefault("_activity_cache", {})
        now = time.monotonic()
        if typing:
            cache[("typing", thread_id)] = (now, (typing_text or "").strip() or None)
        else:
            cache.pop(("typing", thread_id), None)
        if seen is not None:
            for key in [k for k in cache if k[0] == "seen" and k[1] != thread_id]:
                cache.pop(key, None)
            cache[("seen", thread_id)] = (now, seen)

    def activity(self, thread_id: str) -> dict:
        """What the chat list already polled says about thread_id (no extra reading of
        Teams): typing (bool), typing_text (« Ana est en train d'écrire », only for the
        conversation open in Teams' window), seen (your last message read: True / False,
        None when Teams' window shows another conversation)."""
        cache = self.__dict__.get("_activity_cache", {})
        now = time.monotonic()
        typing = cache.get(("typing", thread_id))
        seen = cache.get(("seen", thread_id))
        live = typing is not None and now - typing[0] <= self.TYPING_TTL
        return {"typing": live, "typing_text": typing[1] if live else None,
                "seen": seen[1] if seen is not None and now - seen[0] <= self.TYPING_TTL else None}

    # --- the user's own status (Disponible, Ne pas déranger…) ---
    can_set_status: bool = False
    """True when the driver can read and change the user's own Teams status."""
    status_unsupported = "ce pilote Teams ne sait pas lire ni changer ton statut"

    def my_status(self, with_message: bool = False) -> dict:
        """The user's own status as Teams shows it: {"presence": canonical or None,
        "message": the status message (with_message only; "" when none)}.
        Raises with the reason when the driver cannot tell."""
        raise NotSupported(self.status_unsupported)

    def set_my_status(self, choice: str, duration: Optional[str] = None) -> Optional[str]:
        """Pick choice (presence.CHOICES) in Teams' status menu, for duration
        (presence.DURATIONS: Teams puts the status back afterwards) or until changed.
        Returns the status Teams shows afterwards, checked against the choice by the
        caller. Raises with the reason when the menu could not be used; menus are closed
        in any case."""
        raise NotSupported(self.status_unsupported)

    def set_status_message(self, text: str) -> str:
        """Set (or, empty, clear) the status message. Returns the message Teams shows
        afterwards, checked by the caller. Raises when it could not be done."""
        raise NotSupported(self.status_unsupported)

    # --- new conversation: someone who is not in the list yet ---
    can_start_chat: bool = False
    """True when the driver can open a private chat with someone by name."""
    can_search_people: bool = False
    """True when the driver can search people in Teams (beyond the entourage)."""
    start_chat_unsupported = "ce pilote Teams ne sait pas démarrer une conversation"

    def search_people(self, query: str, limit: int = 8) -> list[str]:
        """Names Teams suggests for query (only when can_search_people)."""
        return []

    def start_chat(self, name: str) -> Optional[WatchEntity]:
        """Open (or create) the private chat with `name` and leave it active. Returns the
        conversation only once Teams shows it under that name (title check), None
        otherwise with the reason in last_error. Nothing is typed."""
        self.last_error = self.start_chat_unsupported
        return None

    # --- Teams' own search: messages older than what Trame has read ---
    can_search_messages: bool = False
    """True when the driver can run Teams' own message search."""
    search_messages_unsupported = "ce pilote Teams ne sait pas lancer la recherche de Teams"

    def search_messages(self, query: str, limit: int = 25) -> list[dict]:
        """Messages Teams' own search finds for query, as Teams lists them: dicts with
        conversation, sender, mine, at and text. Teams' view is put back afterwards.
        Raises with the reason when the search could not run."""
        raise RuntimeError(self.search_messages_unsupported)

    def diagnose(self, thread_id: Optional[str] = None) -> dict:
        """Calibration report (structure only, no message text)."""
        return {"driver": type(self).__name__}

    @abstractmethod
    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        """Type into the compose box of the active conversation, which must still be
        thread_id (re-checked by the driver). False if it cannot confirm it."""

    # --- attachments: files the user chose in the Trame UI, sent by their click only ---
    can_attach: bool = False
    """True when the driver can attach a file to a message in Teams."""
    attach_unsupported = "ce pilote Teams ne sait pas joindre de fichier"

    def _send_files_into_active(self, thread_id: str, text: str, files: "Sequence[Attachment]",
                                reply_to: Optional[MessageRef] = None) -> bool:
        """Attach files, then type text (may be empty), in the compose box of the active
        conversation (still thread_id), quoting reply_to first if given, and send. True only
        once Teams shows the message; SendUncertain when it may have left unconfirmed."""
        raise NotSupported(self.attach_unsupported)

    def type_reply(self, thread_id: str, text: str, send: bool, restore: bool = False) -> bool:
        """Open thread_id, then type text (send=True also presses Enter). Refuses (False)
        whenever the target conversation cannot be confirmed: never types blind.
        restore=True reopens the previously active conversation afterwards."""
        return self.type_focused(thread_id, text, send, restore).ok

    def type_focused(self, thread_id: str, text: str, send: bool, restore: bool,
                     reply_to: Optional[MessageRef] = None, mentions: Sequence[str] = (),
                     files: "Sequence[Attachment]" = ()) -> Focus:
        """Like type_reply but returns the Focus; `ok` is True only if the text was typed.
        reply_to: answer that precise message (Teams « Répondre »), not just the thread.
        mentions: names written « @Nom » in text that Teams must turn into real mentions.
        files: attached and sent with the text (send only, never typed and left there)."""
        if reply_to is not None and not self.supports_reply:
            raise NotSupported("Ce pilote Teams ne sait pas répondre à un message précis.")
        if mentions and not self.supports_mentions:
            raise NotSupported("Ce pilote Teams ne sait pas mentionner quelqu'un.")
        if files and not send:
            raise NotSupported("Une pièce jointe part seulement avec un envoi.")
        if files and not self.can_attach:
            raise NotSupported(self.attach_unsupported)
        if files and mentions:
            raise NotSupported("Pièce jointe et mention dans le même message : pas encore pris en charge.")
        with self.focused(thread_id, restore=restore) as focus:
            if focus.ok:
                try:
                    if files:
                        focus.ok = bool(self._send_files_into_active(thread_id, text, files, reply_to))
                    elif mentions:
                        focus.ok = bool(self._type_with_mentions(thread_id, text, send, list(mentions), reply_to))
                    elif reply_to is None:
                        focus.ok = bool(self._type_into_active(thread_id, text, send))
                    else:
                        focus.ok = bool(self._reply_in_active(thread_id, reply_to, text, send))
                    if not focus.ok:
                        focus.reason = "pièce jointe non envoyée dans Teams" if files else "texte non saisi dans Teams"
                except SendUncertain:
                    raise
                except Exception as e:
                    focus.ok, focus.reason = False, str(e)
        return focus

    def _reply_in_active(self, thread_id: str, target: MessageRef, text: str, send: bool) -> bool:
        """Quote target in the compose box of the active conversation (which must still
        be thread_id), then type text. The driver must first find target and check its
        sender and text: never quote another message. Empty compose box required."""
        raise NotSupported("Ce pilote Teams ne sait pas répondre à un message précis.")

    def _type_with_mentions(self, thread_id: str, text: str, send: bool, mentions: list[str],
                            reply_to: Optional[MessageRef] = None) -> bool:
        """Type text where each « @Nom » of mentions becomes a real Teams mention (picked
        in Teams' own suggestions, one person of exactly that name). On any doubt the
        compose box is cleared and nothing is sent."""
        raise NotSupported("Ce pilote Teams ne sait pas mentionner quelqu'un.")

    def react_focused(self, thread_id: str, target: MessageRef, reaction: str, restore: bool = True) -> Focus:
        """Open thread_id, then put `reaction` on target. `ok` only once Teams shows it.
        A reaction already there is left alone (clicking it again would remove it)."""
        if not self.supports_reactions:
            raise NotSupported("Ce pilote Teams ne sait pas réagir à un message.")
        with self.focused(thread_id, restore=restore) as focus:
            if focus.ok:
                try:
                    focus.ok = bool(self._react_in_active(thread_id, target, reaction))
                    if not focus.ok:
                        focus.reason = "réaction non posée dans Teams"
                except ReactUncertain:
                    raise
                except Exception as e:
                    focus.ok, focus.reason = False, str(e)
        return focus

    def _react_in_active(self, thread_id: str, target: MessageRef, reaction: str) -> bool:
        """Put reaction on target in the active conversation (still thread_id). The
        driver finds target and checks its sender and text before clicking."""
        raise NotSupported("Ce pilote Teams ne sait pas réagir à un message.")

    def delete_focused(self, thread_id: str, target: MessageRef, restore: bool = True) -> Focus:
        """Open thread_id, then delete target, one of the user's own messages. `ok` only
        once Teams shows it deleted. The driver finds target, checks its author and text,
        and that Teams offers to delete it (only on one's own messages): on any doubt,
        nothing is deleted."""
        if not self.supports_delete:
            raise NotSupported(self.delete_unsupported)
        with self.focused(thread_id, restore=restore) as focus:
            if focus.ok:
                try:
                    focus.ok = bool(self._delete_in_active(thread_id, target))
                    if not focus.ok:
                        focus.reason = "message non supprimé dans Teams"
                except DeleteUncertain:
                    raise
                except Exception as e:
                    focus.ok, focus.reason = False, str(e)
        return focus

    def _delete_in_active(self, thread_id: str, target: MessageRef) -> bool:
        """Delete target in the active conversation (still thread_id)."""
        raise NotSupported(self.delete_unsupported)

    @abstractmethod
    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        """Unread incoming messages, optionally restricted to thread_ids (catch-up)."""

    @abstractmethod
    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        """Block, delivering new messages on watched threads to on_message until should_stop()."""
