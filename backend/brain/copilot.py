from __future__ import annotations
import subprocess

import reflection

from winproc import _creationflags
from brain.base import Brain, build_prompt, clean_reply
from brain.isolation import sandbox_dir

DEFAULT_ARGS = ["copilot", "--", "-p"]


class CopilotBrain(Brain):
    """Alternative brain via the GitHub Copilot CLI (`gh copilot`). Separate channel
    from Claude, same interface. Exact invocation is version-dependent — A CALER."""

    label = "Copilot"

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
        return clean_reply(self.complete(build_prompt(soul, thread_summary, incoming, github_context, people_context)))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        if reflection.active():
            return self._cancellable(prompt, timeout or self.timeout)
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

    def _cancellable(self, prompt: str, timeout: float) -> str:
        """Copilot gives no reasoning: the panel shows Trame's steps only. The process
        can still be stopped from the panel."""
        proc = subprocess.Popen(
            [self.command, *self.args, prompt],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=sandbox_dir(), creationflags=_creationflags(),
            text=True, encoding="utf-8", errors="replace",
        )
        unhook = reflection.on_cancel(proc.kill)
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise
        finally:
            unhook()
        reflection.check_cancelled()
        if proc.returncode != 0:
            raise RuntimeError(f"gh copilot a échoué: {(err or '').strip()[:200]}")
        return (out or "").strip()
