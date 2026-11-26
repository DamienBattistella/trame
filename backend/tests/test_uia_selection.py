from drivers.windows_uia import WindowsUIADriver as D


class Item:
    def __init__(self, uia=None, aria="", msaa=None):
        self._uia, self.AriaProperties, self._msaa = uia, aria, msaa

    def GetSelectionItemPattern(self):
        if self._uia is None:
            return None
        return type("P", (), {"IsSelected": self._uia})()

    def GetLegacyIAccessiblePattern(self):
        if self._msaa is None:
            return None
        return type("L", (), {"State": 0x2 if self._msaa else 0})()


def test_selection_from_any_signal():
    assert D._is_selected(Item(uia=True))
    assert D._is_selected(Item(aria="setsize=63;selected=true;level=1"))
    assert D._is_selected(Item(aria="current=page"))
    assert D._is_selected(Item(msaa=True))
    assert not D._is_selected(Item(uia=False, aria="selected=false;current=false", msaa=False))
    assert not D._is_selected(Item())


class Win:
    def __init__(self):
        self.Name = "Chat | Autre | Microsoft Teams"
        self.activated = False

    def SetActive(self):
        self.activated = True


class Rail:
    def __init__(self, win, name, works):
        self.win, self.Name, self.works, self.clicked = win, f"Chat {name} Away Last message ok", works, False

    def GetLegacyIAccessiblePattern(self):
        rail = self

        class L:
            def DoDefaultAction(self):
                if "legacy" in rail.works:
                    rail.win.Name = f"Chat | {rail.Name.split(' Away')[0][5:]} | Microsoft Teams"
        return L()

    def GetInvokePattern(self):
        raise RuntimeError("pas d'Invoke")

    def GetSelectionItemPattern(self):
        raise RuntimeError("pas de Select")

    def Click(self, **kw):
        self.clicked = True


def test_activate_prefers_accessibility_over_mouse(monkeypatch):
    import drivers.windows_uia as w
    monkeypatch.setattr(w.time, "sleep", lambda s: None)
    d = D.__new__(D)
    win = Win()
    item = Rail(win, "Romain CUREAU", works={"legacy"})
    assert d._activate(win, item) == "legacy" and not item.clicked and not win.activated
    win2 = Win()
    stuck = Rail(win2, "Hugo Lannes", works=set())
    assert d._activate(win2, stuck) == "mouse" and stuck.clicked and win2.activated
