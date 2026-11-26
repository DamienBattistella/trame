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
