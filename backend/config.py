from __future__ import annotations
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"


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
    path = ROOT / active
    if path.exists():
        return path.read_text(encoding="utf-8")
    return "Assistant Teams. Réponds brièvement, dans un ton cordial et professionnel."
