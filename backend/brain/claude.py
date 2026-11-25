from __future__ import annotations
import subprocess
from brain.base import Brain, build_prompt
from brain.isolation import sandbox_dir

# Teams messages are untrusted input: the model only writes text. No tools, no MCP
# server, no saved session, whatever the user's Claude Code settings allow.
HARDENING = ["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]


class ClaudeBrain(Brain):
    """Drives Claude Code headless (`claude -p`). Uses the user's own authenticated
    Claude session (Ultra OAuth — their documented choice; the API would be the
    cleaner programmatic path). No key handling here: `claude` is already logged in."""

    def __init__(self, command: str = "claude", args: list[str] | None = None, timeout: float = 60.0):
        self.command = command
        base = list(args or ["-p"])
        if "-p" not in base and "--print" not in base:
            base.insert(0, "-p")
        self.args = base + [a for a in HARDENING if a not in base or a == ""]
        self.timeout = timeout

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "") -> str:
        return self.complete(build_prompt(soul, thread_summary, incoming, github_context))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        proc = subprocess.run(
            [self.command, *self.args],
            input=prompt,
            capture_output=True,
            cwd=sandbox_dir(),
            text=True,
            timeout=timeout or self.timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"claude a échoué: {proc.stderr.strip()[:200]}")
        return proc.stdout.strip()
