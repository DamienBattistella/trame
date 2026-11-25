from __future__ import annotations
import time
from typing import Callable, Iterable, Optional
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
        self._names: dict[str, str] = {}

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

    def _rail_items(self, rail) -> list:
        # A CALER: rail entries are expected as TreeItem/ListItem descendants of the rail.
        out = []
        for ctrl, _depth in self.auto.WalkControl(rail, includeTop=False, maxDepth=4):
            if ctrl.ControlTypeName in ("TreeItemControl", "ListItemControl") and (ctrl.Name or "").strip():
                out.append(ctrl)
        return out

    @staticmethod
    def _display_name_of(item) -> str:
        return (item.Name or "").strip()  # A CALER: Name may carry the last-message preview.

    def _thread_id_of(self, item) -> str:
        # Teams rail DOM id is "chat-list-item_19:...@thread.v2"; Chromium usually
        # surfaces it as AutomationId. Fall back to the display name when absent.
        auto_id = getattr(item, "AutomationId", "") or ""
        return auto_id.replace("chat-list-item_", "") or f"name:{self._display_name_of(item)}"

    def list_conversations(self) -> list[WatchEntity]:
        win = self._window()
        rail = self._find_rail(win)
        out: list[WatchEntity] = []
        if rail is None:
            return out
        for item in self._rail_items(rail):
            name = self._display_name_of(item)
            thread_id = self._thread_id_of(item)
            self._names[thread_id] = name
            out.append(WatchEntity(thread_id=thread_id, display_name=name, surface=Surface.dm))
        return out

    def _rail_item_for(self, rail, thread_id: str):
        items = self._rail_items(rail)
        if not thread_id.startswith("name:"):
            by_id = [i for i in items if thread_id in (getattr(i, "AutomationId", "") or "")]
            if len(by_id) == 1:
                return by_id[0]
            if len(by_id) > 1:
                return None
        name = thread_id[5:] if thread_id.startswith("name:") else self._names.get(thread_id)
        if not name:
            return None
        by_name = [i for i in items if self._display_name_of(i) == name]
        return by_name[0] if len(by_name) == 1 else None

    @staticmethod
    def _is_selected(item) -> bool:
        try:
            pattern = item.GetSelectionItemPattern()  # A CALER: selected state exposed on the rail item.
            return bool(pattern is not None and pattern.IsSelected)
        except Exception:
            return False

    def active_thread(self) -> Optional[str]:
        try:
            rail = self._find_rail(self._window())
            if rail is None:
                return None
            selected = [i for i in self._rail_items(rail) if self._is_selected(i)]
            if len(selected) != 1:
                return None
            thread_id = self._thread_id_of(selected[0])
            self._names[thread_id] = self._display_name_of(selected[0])
            return thread_id
        except Exception:
            return None

    def _conversation_title(self, win) -> Optional[str]:
        return None  # A CALER: header of the open conversation (title text node).

    def _is_active(self, win, thread_id: str) -> bool:
        rail = self._find_rail(win)
        if rail is None:
            return False
        item = self._rail_item_for(rail, thread_id)
        if item is None or not self._is_selected(item):
            return False
        title = self._conversation_title(win)
        if title is not None and title.strip() != self._display_name_of(item):
            return False
        return self._find_compose(win) is not None

    def open_thread(self, thread_id: str) -> bool:
        try:
            win = self._window()
            if self._is_active(win, thread_id):
                return True
            rail = self._find_rail(win)
            item = self._rail_item_for(rail, thread_id) if rail is not None else None
            if item is None:
                return False
            item.Click(simulateMove=False, waitTime=0.1)  # A CALER: Click vs SelectionItemPattern.Select().
            for _ in range(15):
                if self._is_active(win, thread_id):
                    return True
                time.sleep(0.2)
            return False
        except Exception:
            return False

    def is_screen_sharing(self) -> bool:
        win = self._window()
        # Teams shows a "Stop sharing" / "Arrêter le partage" affordance while sharing.
        for label in ("Arrêter le partage", "Stop sharing", "Stop presenting"):
            if win.ButtonControl(searchDepth=30, Name=label).Exists(0, 0):
                return True
        return False

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        win = self._window()
        out: list[IncomingMessage] = []
        if not self._is_active(win, thread_id):
            return out
        msglist = self._find_message_list(win)
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

    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        win = self._window()
        box = self._find_compose(win)
        if box is None:
            raise RuntimeError("Zone de composition introuvable (sélecteur à caler).")
        box.SetFocus()
        time.sleep(0.15)
        if not self._is_active(win, thread_id):
            return False
        # Paste via clipboard: robust for arbitrary text (SendKeys would mangle
        # {}()+^%~). The compose box is a contenteditable, so ValuePattern is
        # unreliable; keyboard paste is the dependable path.
        self.auto.SetClipboardText(text)
        self.auto.SendKeys("{Ctrl}v", waitTime=0.02)
        if send:
            time.sleep(0.2)
            if not self._is_active(win, thread_id):
                return False
            self.auto.SendKeys("{Enter}")  # A CALER: guard the "Enter sends" setting.
        return True

    def _is_unread(self, item) -> bool:
        name = (item.Name or "").lower()
        return "non lu" in name or "unread" in name  # A CALER: real unread badge node.

    def _rail_preview(self, item) -> Optional[tuple[str, str]]:
        return None  # A CALER: (sender, last message) read from the rail item without opening it.

    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        wanted = set(thread_ids) if thread_ids is not None else None
        try:
            rail = self._find_rail(self._window())
            if rail is None:
                return []
            out: list[IncomingMessage] = []
            for item in self._rail_items(rail):
                thread_id = self._thread_id_of(item)
                if (wanted is not None and thread_id not in wanted) or not self._is_unread(item):
                    continue
                preview = self._rail_preview(item)
                if preview is None:
                    continue
                sender, text = preview
                out.append(IncomingMessage(thread_id=thread_id, sender=sender, text=text, received_at="", surface=Surface.dm))
            return out
        except Exception:
            return []

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
