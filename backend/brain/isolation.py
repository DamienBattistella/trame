from __future__ import annotations
import tempfile
from pathlib import Path

_SANDBOX: Path | None = None


def sandbox_dir() -> str:
    """Empty working directory for the brain CLIs: a message cannot make them read the
    user's files, because there is nothing next to them and their tools are off."""
    global _SANDBOX
    if _SANDBOX is None or not _SANDBOX.is_dir():
        _SANDBOX = Path(tempfile.mkdtemp(prefix="trame-brain-"))
    return str(_SANDBOX)
