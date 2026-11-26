from __future__ import annotations
import shutil
import subprocess

from winproc import _creationflags
from brain.base import Brain, build_prompt
from brain.isolation import sandbox_dir

# Teams messages are untrusted input: the model only writes text. No tools, no MCP
# server, no saved session, whatever the user's Claude Code settings allow.
HARDENING = ["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]


class ClaudeBrain(Brain):
    """Drives Claude Code headless (`claude -p`). Uses the user's own authenticated
    Claude session (Ultra OAuth — their documented choice; the API would be the
    cleaner programmatic path). No key handling here: `claude` is already logged in."""

    # Higher effort thinks longer: the wait grows with it.
    TIMEOUTS = {"": 60.0, "low": 45.0, "medium": 60.0, "high": 90.0, "xhigh": 150.0, "max": 240.0}

    def __init__(self, command: str = "claude", args: list[str] | None = None, timeout: float | None = None,
                 model: str = "", effort: str = ""):
        self.command = command
        base = list(args or ["-p"])
        if "-p" not in base and "--print" not in base:
            base.insert(0, "-p")
        if model and "--model" not in base:
            base += ["--model", model]
        if effort and "--effort" not in base:
            base += ["--effort", effort]
        self.model, self.effort = model, effort
        self.args = base + [a for a in HARDENING if a not in base or a == ""]
        self.timeout = timeout or self.TIMEOUTS.get(effort, 60.0)

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "", people_context: str = "") -> str:
        return self.complete(build_prompt(soul, thread_summary, incoming, github_context, people_context))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        proc = subprocess.run(
            [shutil.which(self.command) or self.command, *self.args],
            input=prompt,
            capture_output=True,
            cwd=sandbox_dir(),
            creationflags=_creationflags(),
            text=True, encoding="utf-8", errors="replace",
            timeout=timeout or self.timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"claude a échoué: {proc.stderr.strip()[:200]}")
        return proc.stdout.strip()
