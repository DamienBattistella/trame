from pathlib import Path

import config as cfgmod

FORMER = Path(__file__).parent / "fixtures" / "former_shipped_soul.md"


def test_shipped_soul_names_nobody():
    """Trame is installed by anyone: the default persona must not be someone's."""
    text = (cfgmod.BUNDLE / "SOUL.md").read_text(encoding="utf-8")
    assert "Damien" not in text and "Dedalus" not in text


def test_untouched_former_default_follows_the_new_one(fresh_home):
    (fresh_home / "SOUL.md").write_bytes(FORMER.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    cfgmod._refresh_shipped_soul()
    assert (fresh_home / "SOUL.md").read_bytes() == (cfgmod.BUNDLE / "SOUL.md").read_bytes()
    assert not cfgmod.soul_is_custom()


def test_user_soul_is_never_replaced(fresh_home):
    (fresh_home / "SOUL.md").write_text(FORMER.read_text(encoding="utf-8") + "\n- Ma ligne\n", encoding="utf-8")
    before = (fresh_home / "SOUL.md").read_bytes()
    cfgmod._refresh_shipped_soul()
    assert (fresh_home / "SOUL.md").read_bytes() == before
