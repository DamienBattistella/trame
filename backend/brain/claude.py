from __future__ import annotations
import json
import shutil
import subprocess
import threading

import reflection

from winproc import _creationflags
from brain.base import Brain, build_prompt, clean_reply
from brain.isolation import sandbox_dir

# Teams messages are untrusted input: the model only writes text. No tools, no MCP
# server, no saved session, whatever the user's Claude Code settings allow.
HARDENING = ["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]


class ClaudeBrain(Brain):
    """Drives Claude Code headless (`claude -p`). Uses the user's own authenticated
    Claude session (Ultra OAuth — their documented choice; the API would be the
    cleaner programmatic path). No key handling here: `claude` is already logged in."""

    label = "Claude"

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
        return clean_reply(self.ask(build_prompt(soul, thread_summary, incoming, github_context, people_context)))

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        if reflection.active():
            return self._stream(prompt, timeout or self.timeout)
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

    def _stream(self, prompt: str, timeout: float) -> str:
        """Same call, read as it comes (stream-json): the model's reasoning goes to the
        reflection panel while it thinks. The answer is the `result` event's text."""
        args = self.args + ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        proc = subprocess.Popen(
            [shutil.which(self.command) or self.command, *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=sandbox_dir(), creationflags=_creationflags(),
            text=True, encoding="utf-8", errors="replace",
        )
        expired = threading.Event()

        def kill() -> None:
            try:
                proc.kill()
            except OSError:
                pass

        def expire() -> None:
            expired.set()
            kill()

        timer = threading.Timer(timeout, expire)
        timer.daemon = True
        timer.start()
        unhook = reflection.on_cancel(kill)
        try:
            # Stderr is drained apart: a full pipe would block the CLI.
            err: list[str] = []
            drain = threading.Thread(target=lambda: err.append(proc.stderr.read()), daemon=True)
            drain.start()
            try:
                proc.stdin.write(prompt)
                proc.stdin.close()
            except OSError:
                pass
            answer, text, failure = parse_stream(proc.stdout)
            proc.wait()
            drain.join(timeout=1)
        finally:
            timer.cancel()
            unhook()
        reflection.check_cancelled()
        if expired.is_set():
            raise subprocess.TimeoutExpired(self.command, timeout)
        if failure:
            raise RuntimeError(f"claude a échoué: {failure[:200]}")
        if proc.returncode != 0:
            raise RuntimeError(f"claude a échoué: {''.join(err).strip()[:200]}")
        return (answer if answer is not None else text).strip()


def parse_stream(lines) -> tuple[str | None, str, str]:
    """Reads `claude -p --output-format stream-json --include-partial-messages`:
    reasoning deltas are relayed as they come. Returns (result text or None, text
    gathered from the deltas, error message)."""
    answer: str | None = None
    text: list[str] = []
    failure = ""
    answering = False
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        kind = ev.get("type")
        if kind == "system" and ev.get("subtype") == "init":
            reflection.step(f"Modèle prêt : {ev.get('model') or 'par défaut'}")
        elif kind == "system" and ev.get("subtype") == "thinking_tokens":
            # The CLI may keep the reasoning text to itself: its size is all there is.
            reflection.step(f"Le modèle réfléchit (≈ {ev.get('estimated_tokens', 0)} jetons, texte non transmis)",
                            key="thinking_tokens")
        elif kind == "stream_event":
            delta = (ev.get("event") or {}).get("delta") or {}
            if delta.get("type") == "thinking_delta":
                reflection.thinking(delta.get("thinking") or "")
            elif delta.get("type") == "text_delta":
                if not answering:
                    answering = True
                    reflection.step("Le modèle écrit sa réponse")
                text.append(delta.get("text") or "")
        elif kind == "assistant" and not text:
            # Without partial messages: whole blocks, reasoning first.
            for block in (ev.get("message") or {}).get("content") or []:
                if block.get("type") == "thinking":
                    reflection.thinking(block.get("thinking") or "")
        elif kind == "result":
            if ev.get("is_error") or ev.get("subtype") not in (None, "success"):
                failure = str(ev.get("result") or ev.get("subtype") or "erreur")
            else:
                answer = str(ev.get("result") or "")
    return answer, "".join(text), failure
