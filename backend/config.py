from __future__ import annotations
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
    HOME.mkdir(parents=True, exist_ok=True)
    for name in ("config.json", "SOUL.md"):
        target = HOME / name
        source = BUNDLE / name
        if not target.exists() and source.exists():
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


def load_soul() -> str:
    active = load().get("persona", {}).get("active_soul", "SOUL.md")
    path = HOME / active
    if path.exists():
        return path.read_text(encoding="utf-8")
    return "Assistant Teams. Réponds brièvement, dans un ton cordial et professionnel."
