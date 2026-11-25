from __future__ import annotations
import time
from typing import Callable, Optional
from models import IncomingMessage, Surface, WatchEntity
from drivers.base import TeamsDriver

# Real driver — Windows only. Imported lazily so the backend runs on any OS with
# the mock. Teams v2 is a WebView2 (Chromium) app: the UIA tree is the web DOM
# exposed through Chromium's accessibility layer. It is lazily built (connecting
# as a UIA client switches it on) and unstable across Teams updates. Every anchor
# below goes through _find with multiple strategies and must be verified per build
# with Accessibility Insights. Markers: A CALER.


class WindowsUIADriver(TeamsDriver):
    def __init__(self, window_title: str = "Microsoft Teams", poll: float = 1.0):
        import uiautomation as auto  # noqa: F401  (Windows-only dependency)
        self.auto = auto
        self.window_title = window_title
        self.poll = poll
        self._win = None
        self._fingerprints: dict[str, str] = {}

    def _window(self):
        if self._win is None or not self._win.Exists(0, 0):
            self._win = self.auto.WindowControl(searchDepth=1, SubName=self.window_title)
            if not self._win.Exists(maxSearchSeconds=5):
                raise RuntimeError("Fenêtre Teams introuvable (Teams ouvert ?)")
            # Warm-up: WebView2 builds the a11y tree lazily once a UIA client connects.
            for _ in range(10):
                if self._win.GetFirstChildControl() is not None:
                    break
                time.sleep(0.3)
        return self._win

    def selftest(self) -> bool:
        try:
            win = self._window()
            compose = self._find_compose(win)
            msglist = self._find_message_list(win)
            rail = self._find_rail(win)
            return all(x is not None for x in (compose, msglist, rail))
        except Exception:
            return False

    # --- selector abstraction (multi-strategy, A CALER per build) ---
    def _find_compose(self, win):
        box = win.EditControl(searchDepth=25, foundIndex=1)
        return box if box.Exists(0, 0) else None

    def _find_message_list(self, win):
        lst = win.ListControl(searchDepth=25, foundIndex=1)
        return lst if lst.Exists(0, 0) else None

    def _find_rail(self, win):
        tree = win.TreeControl(searchDepth=25, foundIndex=1)
        return tree if tree.Exists(0, 0) else None

    def list_conversations(self) -> list[WatchEntity]:
        win = self._window()
        rail = self._find_rail(win)
        out: list[WatchEntity] = []
        if rail is None:
            return out
        for item in rail.GetChildren():
            name = (item.Name or "").strip()
            if not name:
                continue
            # Teams rail DOM id is "chat-list-item_19:...@thread.v2"; Chromium usually
            # surfaces it as AutomationId. Fall back to the display name when absent.
            auto_id = getattr(item, "AutomationId", "") or ""
            thread_id = auto_id.replace("chat-list-item_", "") or f"name:{name}"
            out.append(WatchEntity(thread_id=thread_id, display_name=name, surface=Surface.dm))
        return out

    def is_screen_sharing(self) -> bool:
        win = self._window()
        # Teams shows a "Stop sharing" / "Arrêter le partage" affordance while sharing.
        for label in ("Arrêter le partage", "Stop sharing", "Stop presenting"):
            if win.ButtonControl(searchDepth=30, Name=label).Exists(0, 0):
                return True
        return False

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        win = self._window()
        msglist = self._find_message_list(win)
        out: list[IncomingMessage] = []
        if msglist is None:
            return out
        last_sender = ""
        for node in msglist.GetChildren()[-last_n:]:
            text = (node.Name or "").strip()
            if not text:
                continue
            # Consecutive messages collapse the author header: carry it forward.
            sender = self._sender_of(node) or last_sender
            last_sender = sender or last_sender
            out.append(IncomingMessage(
                thread_id=thread_id, sender=sender, text=text,
                received_at="", surface=Surface.dm,
            ))
        return out

    def _sender_of(self, node) -> Optional[str]:
        return None  # A CALER: read the author sub-node when present.

    def type_reply(self, thread_id: str, text: str, send: bool) -> None:
        win = self._window()
        box = self._find_compose(win)
        if box is None:
            raise RuntimeError("Zone de composition introuvable (sélecteur à caler).")
        box.SetFocus()
        time.sleep(0.15)
        # Paste via clipboard: robust for arbitrary text (SendKeys would mangle
        # {}()+^%~). The compose box is a contenteditable, so ValuePattern is
        # unreliable; keyboard paste is the dependable path.
        self.auto.SetClipboardText(text)
        self.auto.SendKeys("{Ctrl}v", waitTime=0.02)
        if send:
            time.sleep(0.2)
            self.auto.SendKeys("{Enter}")  # A CALER: guard the "Enter sends" setting.

    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        # Poll the rail unread state for cross-conversation detection; diff the open
        # thread against stored fingerprints to confirm a real new message.
        while not should_stop():
            try:
                for msg in self._poll_new():
                    on_message(msg)
            except Exception:
                pass
            time.sleep(self.poll)

    def _poll_new(self) -> list[IncomingMessage]:
        return []  # A CALER: rail badge diff + open-thread fingerprint diff.
