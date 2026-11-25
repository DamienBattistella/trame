from __future__ import annotations
import os
import sys
import threading

import uvicorn

# Import the app object statically (not as an "app:app" string) so PyInstaller's
# dependency analysis bundles app.py and its whole import graph into the sidecar.
from app import app


def _exit_with_parent() -> None:
    """The desktop shell keeps our stdin open. When it quits or crashes, stdin hits
    EOF and the engine stops at once — a PyInstaller --onefile child would otherwise
    survive its parent and keep acting on Teams with no window to pause it."""
    try:
        while sys.stdin.buffer.read(4096):
            pass
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    if os.environ.get("TRAME_EXIT_WITH_PARENT") == "1" and sys.stdin is not None:
        threading.Thread(target=_exit_with_parent, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8731, reload=False)
