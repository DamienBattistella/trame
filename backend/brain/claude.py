from __future__ import annotations
import subprocess
from brain.base import Brain, build_prompt


class ClaudeBrain(Brain):
    """Drives Claude Code headless (`claude -p`). Uses the user's own authenticated
    Claude session (Ultra OAuth — their documented choice; the API would be the
    cleaner programmatic path). No key handling here: `claude` is already logged in."""

    def __init__(self, command: str = "claude", args: list[str] | None = None, timeout: float = 60.0):
        self.command = command
        self.args = args or ["-p"]
        self.timeout = timeout

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "") -> str:
        return self.complete(build_prompt(soul, thread_summary, incoming, github_context))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        proc = subprocess.run(
            [self.command, *self.args],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout or self.timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"claude a échoué: {proc.stderr.strip()[:200]}")
        return proc.stdout.strip()
