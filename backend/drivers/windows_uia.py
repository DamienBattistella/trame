from __future__ import annotations
import re
import time
from typing import Callable, Iterable, Optional
from models import IncomingMessage, Surface, WatchEntity
from drivers.base import TeamsDriver
from drivers import rail_label

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
    def _label_of(item) -> "rail_label.RailLabel":
        return rail_label.parse(item.Name or "")

    @classmethod
    def _display_name_of(cls, item) -> str:
        # The item label also carries presence and the last message: keep the name only,
        # so the name-based id stays stable when someone goes from Away to Offline.
        return cls._label_of(item).name

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
        for rank, item in enumerate(self._rail_items(rail)):
            label = self._label_of(item)
            thread_id = self._thread_id_of(item)
            self._names[thread_id] = label.name
            own = label.preview if label.preview_sender == "You" else None
            out.append(WatchEntity(thread_id=thread_id, display_name=label.name, surface=label.surface,
                                   rank=rank, last_activity=label.last_time, unread=label.unread,
                                   is_self=label.is_self, own_preview=own))
        return out

    def _rail_item_for(self, rail, thread_id: str):
        items = self._rail_items(rail)
        if not thread_id.startswith("name:"):
            # A real id is matched by id only: the rail is virtualized, and falling back
            # to the display name could pick another chat with the same name.
            by_id = [i for i in items if thread_id in (getattr(i, "AutomationId", "") or "")]
            return by_id[0] if len(by_id) == 1 else None
        name = rail_label.parse(thread_id[5:]).name
        by_name = [i for i in items if self._display_name_of(i) == name]
        return by_name[0] if len(by_name) == 1 else None

    @staticmethod
    def _selection_signals(item) -> dict:
        """Every way a WebView2 list item can say "I am the open conversation": UIA
        SelectionItem, ARIA selected / current, legacy MSAA selected state."""
        out = {"uia_selected": None, "aria": "", "msaa_selected": None}
        try:
            pattern = item.GetSelectionItemPattern()
            out["uia_selected"] = bool(pattern.IsSelected) if pattern is not None else None
        except Exception:
            pass
        try:
            out["aria"] = (getattr(item, "AriaProperties", "") or "").lower()
        except Exception:
            pass
        try:
            legacy = item.GetLegacyIAccessiblePattern()
            out["msaa_selected"] = bool(legacy.State & 0x2) if legacy is not None else None
        except Exception:
            pass
        return out

    @classmethod
    def _is_selected(cls, item) -> bool:
        sig = cls._selection_signals(item)
        aria = sig["aria"]
        return bool(
            sig["uia_selected"]
            or "selected=true" in aria
            or re.search(r"current=(?!false)\w+", aria)
            or sig["msaa_selected"]
        )

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

    def show_thread(self, thread_id: str) -> bool:
        try:
            win = self._window()
            try:
                if win.IsMinimize():
                    win.ShowWindow(self.auto.SW.Restore)
            except Exception:
                pass
            try:
                win.SetActive()
            except Exception:
                pass
            rail = self._find_rail(win)
            item = self._rail_item_for(rail, thread_id) if rail is not None else None
            if item is None:
                return False
            item.Click(simulateMove=False, waitTime=0.1)
            return True
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

    # Placeholder Teams shows in an empty compose box (A CALER per language/build).
    _PLACEHOLDERS = ("", "tapez un message", "type a message", "écrivez un message", "envoyer un message")

    def _compose_text(self, box) -> Optional[str]:
        """Current content of the compose box, or None when it cannot be read."""
        for getter in ("GetValuePattern", "GetLegacyIAccessiblePattern"):
            try:
                pattern = getattr(box, getter)()
                if pattern is not None:
                    return (pattern.Value or "").strip()
            except Exception:
                continue
        return None

    def _keyboard_goes_to(self, win, box) -> bool:
        """Keystrokes are global: they reach the foreground window. Teams must be the
        foreground window and its compose box must hold the keyboard focus."""
        try:
            import ctypes
            if ctypes.windll.user32.GetForegroundWindow() != win.NativeWindowHandle:
                return False
            focused = self.auto.GetFocusedControl()
            return focused is not None and focused.GetRuntimeId() == box.GetRuntimeId()
        except Exception:
            return False

    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        win = self._window()
        box = self._find_compose(win)
        if box is None:
            raise RuntimeError("Zone de composition introuvable (sélecteur à caler).")
        try:
            win.SetActive()
        except Exception:
            pass
        box.SetFocus()
        time.sleep(0.15)
        if not self._is_active(win, thread_id):
            return False
        existing = self._compose_text(box)
        if existing is None or existing.lower() not in self._PLACEHOLDERS:
            # Something is already typed (the user's own words, or an earlier draft):
            # it would be sent along with the reply. Refuse rather than mix them.
            return False
        if not self._keyboard_goes_to(win, box):
            return False
        # Paste via clipboard: robust for arbitrary text (SendKeys would mangle
        # {}()+^%~). The compose box is a contenteditable, so ValuePattern is
        # unreliable for writing; keyboard paste is the dependable path.
        try:
            saved = self.auto.GetClipboardText()
        except Exception:
            saved = None
        try:
            self.auto.SetClipboardText(text)
            self.auto.SendKeys("{Ctrl}v", waitTime=0.02)
        finally:
            time.sleep(0.1)
            if saved is not None:
                try:
                    self.auto.SetClipboardText(saved)
                except Exception:
                    pass
        if send:
            time.sleep(0.2)
            if not self._is_active(win, thread_id) or not self._keyboard_goes_to(win, box):
                return False
            self.auto.SendKeys("{Enter}")  # A CALER: guard the "Enter sends" setting.
        return True

    def _is_unread(self, item) -> bool:
        return self._label_of(item).unread

    def _rail_preview(self, item) -> Optional[tuple[str, str]]:
        """(sender, last message) read from the rail label, without opening the chat.
        None when the last message is the user's own."""
        label = self._label_of(item)
        if not label.preview or label.preview_sender in (None, "You"):
            return None
        return label.preview_sender, label.preview

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
                out.append(IncomingMessage(thread_id=thread_id, sender=sender, text=text, received_at="",
                                           surface=self._label_of(item).surface))
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

    def diagnose(self, thread_id: Optional[str] = None) -> dict:
        """Structure of the Teams window for calibration: control types, selection
        signals, header candidates. Conversation names only, never message text."""
        report: dict = {"driver": "windows_uia"}
        try:
            win = self._window()
        except Exception as e:
            return {**report, "window": f"introuvable : {e}"}
        report["window"] = {"name": win.Name, "class": win.ClassName}
        rail = self._find_rail(win)
        compose = self._find_compose(win)
        msglist = self._find_message_list(win)

        def desc(c):
            if c is None:
                return None
            return {"type": c.ControlTypeName, "class": c.ClassName, "automation_id": (c.AutomationId or "")[:60],
                    "aria_role": getattr(c, "AriaRole", "") or ""}

        report["rail"], report["compose"], report["message_list"] = desc(rail), desc(compose), desc(msglist)
        items = self._rail_items(rail) if rail is not None else []
        report["rail_items"] = len(items)
        report["rail_sample"] = [
            {**desc(i), "name": self._display_name_of(i), "signals": self._selection_signals(i)} for i in items[:8]
        ]
        selected = [self._display_name_of(i) for i in items if self._is_selected(i)]
        report["selected_now"] = selected

        def header_candidates():
            names = set(selected)
            out = []
            for c, depth in self.auto.WalkControl(win, includeTop=False, maxDepth=18):
                if len(out) >= 6:
                    break
                n = (c.Name or "").strip()
                if n and n in names and c.ControlTypeName not in ("TreeItemControl", "ListItemControl"):
                    out.append({**desc(c), "depth": depth})
            return out

        report["header_candidates"] = header_candidates()
        if thread_id:
            item = self._rail_item_for(rail, thread_id) if rail is not None else None
            test = {"thread_id": thread_id, "rail_item_found": item is not None}
            if item is not None:
                try:
                    item.Click(simulateMove=False, waitTime=0.1)
                    time.sleep(1.5)
                    test["signals_after_click"] = self._selection_signals(item)
                    test["selected_after_click"] = [self._display_name_of(i) for i in self._rail_items(rail) if self._is_selected(i)]
                    test["confirmed"] = self._is_active(win, thread_id)
                except Exception as e:
                    test["error"] = repr(e)
            report["open_test"] = test
        return report

    def _poll_new(self) -> list[IncomingMessage]:
        return []  # A CALER: rail badge diff + open-thread fingerprint diff.
