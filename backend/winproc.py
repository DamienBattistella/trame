from __future__ import annotations
import os
import subprocess


def _creationflags() -> int:
    """No console window flashing on Windows for each gh / claude call."""
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
