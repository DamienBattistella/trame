from __future__ import annotations
import uvicorn

# Import the app object statically (not as an "app:app" string) so PyInstaller's
# dependency analysis bundles app.py and its whole import graph into the sidecar.
from app import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8731, reload=False)
