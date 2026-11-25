from __future__ import annotations
import subprocess
from brain.base import Brain, build_prompt
from brain.isolation import sandbox_dir

DEFAULT_ARGS = ["copilot", "--", "-p"]


class CopilotBrain(Brain):
    """Alternative brain via the GitHub Copilot CLI (`gh copilot`). Separate channel
    from Claude, same interface. Exact invocation is version-dependent — A CALER."""

    def __init__(self, command: str = "gh", args: list[str] | None = None, timeout: float = 60.0):
        self.command = command
        # `gh copilot suggest` (old extension) is an interactive shell-command helper that
        # hangs until the timeout: older configs carrying it get the non-interactive form.
        self.args = list(args) if args and "suggest" not in args else list(DEFAULT_ARGS)
        self.timeout = timeout

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "") -> str:
        return self.complete(build_prompt(soul, thread_summary, incoming, github_context))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        proc = subprocess.run(
            [self.command, *self.args, prompt],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            cwd=sandbox_dir(),
            text=True,
            timeout=timeout or self.timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"gh copilot a échoué: {proc.stderr.strip()[:200]}")
        return proc.stdout.strip()
