from __future__ import annotations
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = Path(getattr(sys, "_MEIPASS", ROOT))


def _home() -> Path:
    if os.environ.get("TRAME_HOME"):
        return Path(os.environ["TRAME_HOME"])
    if getattr(sys, "frozen", False):
        base = os.environ.get("APPDATA") or str(Path.home() / ".config")
        return Path(base) / "Trame"
    return ROOT


HOME = _home()
CONFIG_PATH = HOME / "config.json"


def _seed() -> None:
    """First launch gets the shipped files. The org chart (ENTOURAGE.json) only comes
    with a fresh config: an entourage removed later must stay removed."""
    HOME.mkdir(parents=True, exist_ok=True)
    first_launch = not (HOME / "config.json").exists()
    for name in ("config.json", "SOUL.md", *(["ENTOURAGE.json"] if first_launch else [])):
        target = HOME / name
        source = BUNDLE / name
        if not target.exists() and source.exists():
            shutil.copyfile(source, target)
    _refresh_shipped_soul()


# SHA-256 (LF line endings) of SOUL.md files shipped by earlier versions. A copy still
# identical to one of them was never touched by the user: it follows the new default.
_FORMER_SHIPPED_SOULS = {
    "6d45f6159cd8b57f973f731855f02946dc623e58f3408b0b21824326a218f1e4",  # written for Damien
}


def _soul_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _refresh_shipped_soul() -> None:
    source, target = BUNDLE / "SOUL.md", HOME / "SOUL.md"
    if not (source.exists() and target.exists()) or source.resolve() == target.resolve():
        return
    if _soul_digest(target) in _FORMER_SHIPPED_SOULS:
        shutil.copyfile(source, target)


_seed()


def load() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def save(cfg: dict) -> None:
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def factory_reset() -> dict:
    """Back to the shipped config and SOUL.md (onboarding to redo, nothing followed)."""
    with open(BUNDLE / "config.json", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["onboarded"] = False
    cfg["watchlist"] = []
    cfg["favorites"] = []
    cfg["archived"] = {}
    save(cfg)
    source, target = BUNDLE / "SOUL.md", HOME / "SOUL.md"
    if source.exists() and source.resolve() != target.resolve():
        shutil.copyfile(source, target)
    return cfg


def load_soul() -> str:
    active = load().get("persona", {}).get("active_soul", "SOUL.md")
    path = HOME / active
    if path.exists():
        return path.read_text(encoding="utf-8")
    return "Assistant Teams. Réponds brièvement, dans un ton cordial et professionnel."


SOUL_MAX_BYTES = 64 * 1024


def soul_is_custom() -> bool:
    """True when the user dropped their own SOUL.md (not the shipped default)."""
    path, shipped = HOME / "SOUL.md", BUNDLE / "SOUL.md"
    if not path.exists():
        return False
    if not shipped.exists() or path.resolve() == shipped.resolve():
        return path.resolve() != shipped.resolve()
    return path.read_bytes() != shipped.read_bytes()


def save_soul(content: str) -> Path:
    path = HOME / "SOUL.md"
    tmp = path.with_suffix(".md.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)
    return path
