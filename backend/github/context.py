from __future__ import annotations
import re
import subprocess

# Read-only GitHub context. Consulted only when a message looks repo/code related.
# Never writes (no comment, issue or commit). Uses `gh` with the poste's tokens.

_TRIGGERS = re.compile(
    r"\b(PR|pull request|issue|#\d+|repo|branch|merge|commit|CI|pipeline|bug|déploiement|deploy)\b",
    re.IGNORECASE,
)
_PR_RE = re.compile(r"#(\d+)")


def is_relevant(text: str) -> bool:
    return bool(_TRIGGERS.search(text))


def fetch(text: str, repos: list[str], enabled: bool) -> str:
    if not enabled or not is_relevant(text):
        return ""
    refs: list[str] = []
    for num in _PR_RE.findall(text):
        for repo in repos[:5]:
            out = _gh(["pr", "view", num, "--repo", repo, "--json", "title,body,state", "-q", ".title"])
            if out:
                refs.append(f"{repo} • PR #{num} : {out}")
                break
    return "\n".join(refs)


def list_repos() -> list[str]:
    out = _gh(["repo", "list", "--limit", "100", "--json", "nameWithOwner", "-q", ".[].nameWithOwner"])
    return [r for r in out.splitlines() if r] if out else []


def _gh(args: list[str]) -> str:
    try:
        proc = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=20)
        return proc.stdout.strip() if proc.returncode == 0 else ""
    except Exception:
        return ""
