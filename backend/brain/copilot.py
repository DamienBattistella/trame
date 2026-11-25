from __future__ import annotations
import subprocess
from brain.base import Brain, build_prompt


class CopilotBrain(Brain):
    """Alternative brain via the GitHub Copilot CLI (`gh copilot`). Separate channel
    from Claude, same interface. Exact invocation is version-dependent — A CALER."""

    def __init__(self, command: str = "gh", args: list[str] | None = None, timeout: float = 60.0):
        self.command = command
        self.args = args or ["copilot", "-p"]
        self.timeout = timeout

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "") -> str:
        return self.complete(build_prompt(soul, thread_summary, incoming, github_context))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        proc = subprocess.run(
            [self.command, *self.args, prompt],
            capture_output=True,
            text=True,
            timeout=timeout or self.timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"gh copilot a échoué: {proc.stderr.strip()[:200]}")
        return proc.stdout.strip()
