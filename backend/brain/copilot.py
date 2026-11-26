from __future__ import annotations
import subprocess

from winproc import _creationflags
from brain.base import Brain, build_prompt
from brain.isolation import sandbox_dir

DEFAULT_ARGS = ["copilot", "--", "-p"]


class CopilotBrain(Brain):
    """Alternative brain via the GitHub Copilot CLI (`gh copilot`). Separate channel
    from Claude, same interface. Exact invocation is version-dependent — A CALER."""

    TIMEOUTS = {"": 60.0, "low": 45.0, "medium": 60.0, "high": 90.0, "xhigh": 150.0, "max": 240.0}

    def __init__(self, command: str = "gh", args: list[str] | None = None, timeout: float | None = None,
                 model: str = "", effort: str = ""):
        self.command = command
        # `gh copilot suggest` (old extension) is an interactive shell-command helper that
        # hangs until the timeout: older configs carrying it get the non-interactive form.
        args = list(args) if args and "suggest" not in args else list(DEFAULT_ARGS)
        # Before -p, whose value is the prompt appended last.
        extra = (["--model", model] if model and "--model" not in args else []) + \
                (["--reasoning-effort", effort] if effort and "--reasoning-effort" not in args else [])
        i = args.index("-p") if "-p" in args else len(args)
        args[i:i] = extra
        self.model, self.effort = model, effort
        self.args = args
        self.timeout = timeout or self.TIMEOUTS.get(effort, 60.0)

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "", people_context: str = "") -> str:
        return self.complete(build_prompt(soul, thread_summary, incoming, github_context, people_context))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        proc = subprocess.run(
            [self.command, *self.args, prompt],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            cwd=sandbox_dir(),
            creationflags=_creationflags(),
            text=True, encoding="utf-8", errors="replace",
            timeout=timeout or self.timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"gh copilot a échoué: {proc.stderr.strip()[:200]}")
        return proc.stdout.strip()
