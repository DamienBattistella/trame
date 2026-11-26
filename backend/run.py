from __future__ import annotations
import os
import sys
import threading


def _log_to_file() -> None:
    """Packaged app: no console, so engine errors go to %APPDATA%\\Trame\\backend.log.
    Runs before the app import, which already builds the Teams driver."""
    if not getattr(sys, "frozen", False):
        return
    try:
        import config as cfgmod
        cfgmod.HOME.mkdir(parents=True, exist_ok=True)
        log = open(cfgmod.HOME / "backend.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
    except Exception:
        pass


_log_to_file()

import uvicorn  # noqa: E402

# Import the app object statically (not as an "app:app" string) so PyInstaller's
# dependency analysis bundles app.py and its whole import graph into the sidecar.
from app import app  # noqa: E402


def _exit_with_parent(pid: int) -> None:
    """Stop the engine as soon as the desktop app exits or crashes: a PyInstaller
    --onefile child would otherwise survive it and keep acting on Teams with no
    window left to pause it."""
    if os.name == "nt":
        import ctypes
        SYNCHRONIZE, INFINITE = 0x00100000, 0xFFFFFFFF
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return
        kernel32.WaitForSingleObject(handle, INFINITE)
        os._exit(0)
    import time
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            os._exit(0)
        except PermissionError:
            pass
        time.sleep(2)


if __name__ == "__main__":
    parent = os.environ.get("TRAME_PARENT_PID", "")
    if parent.isdigit():
        threading.Thread(target=_exit_with_parent, args=(int(parent),), daemon=True).start()
    # TRAME_PORT only serves the trial instance (« Trame (essai) »), beside the installed one.
    port = int(os.environ.get("TRAME_PORT") or 8731)
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False)
