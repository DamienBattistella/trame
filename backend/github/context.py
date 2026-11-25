from __future__ import annotations
import json
import re
import subprocess
import threading
import time
from typing import Optional

from models import GithubHit

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


REPOS_TTL = 600.0
_repos_cache: tuple[float, list[str]] | None = None


def list_repos() -> list[str]:
    """The account's repos, cached 10 min: `gh repo list` costs about a second and was
    paid on every message that mentions a PR or an issue."""
    global _repos_cache
    now = time.monotonic()
    if _repos_cache and now - _repos_cache[0] < REPOS_TTL:
        return list(_repos_cache[1])
    out = _gh(["repo", "list", "--limit", "100", "--json", "nameWithOwner", "-q", ".[].nameWithOwner"])
    repos = [r for r in out.splitlines() if r] if out else []
    if repos:
        _repos_cache = (now, repos)
    return repos


MAX_HITS = 8
MAX_NUMBERS = 3
MAX_LOOKUP_REPOS = 5
MAX_SEARCH_REPOS = 6
MAX_OWNERS = 5
CALL_TIMEOUT = 10.0
DEADLINE = 30.0

_SEARCH_FIELDS = "number,title,state,url,repository"


def scope(all_repos: bool, allowlist: list[str]) -> list[str]:
    """Repos a brief may search: every repo of the account, or the allowlist."""
    return list_repos() if all_repos else [r for r in allowlist if r.strip()]


def mentioned_numbers(text: str) -> list[int]:
    seen: list[int] = []
    for n in _PR_RE.findall(text):
        if int(n) not in seen:
            seen.append(int(n))
    return seen[:MAX_NUMBERS]


def named_repos(repos: list[str], transcript: str) -> list[str]:
    """Repos whose `owner/name` or bare name appears as a word in the transcript."""
    low = transcript.lower()
    out: list[str] = []
    for repo in repos:
        name = repo.rsplit("/", 1)[-1].lower()
        if any(re.search(rf"(?<![\w.-]){re.escape(t)}(?![\w-])", low) for t in {repo.lower(), name} if t):
            out.append(repo)
    return out


AMBIGUOUS_HITS = 2


def search(queries: list[str], numbers: list[int], repos: list[str], all_repos: bool, transcript: str = "") -> list[GithubHit]:
    """Read-only lookup: literal #N first, then PR / issue / commit search per query.
    A #N is looked up first in repos named in the transcript; failing that, if it exists
    in several repos, at most AMBIGUOUS_HITS are kept and flagged as ambiguous.
    Capped at MAX_HITS, de-duplicated, bounded by DEADLINE overall."""
    if not repos:
        return []
    deadline = time.monotonic() + DEADLINE
    hits: list[GithubHit] = []
    seen: set[tuple[str, str]] = set()

    def add(hit: Optional[GithubHit]) -> bool:
        if hit is None:
            return False
        key = (hit.repo.lower(), str(hit.number) if hit.number is not None else hit.url)
        if key in seen:
            return False
        seen.add(key)
        hits.append(hit)
        return True

    def full() -> bool:
        return len(hits) >= MAX_HITS or time.monotonic() > deadline

    named = named_repos(repos, transcript)
    others = [r for r in repos if r not in named]
    for num in numbers:
        found: Optional[GithubHit] = None
        for repo in named[:MAX_LOOKUP_REPOS]:
            if full():
                return hits
            found = _lookup(repo, num)
            if found is not None:
                break
        if found is not None:
            add(found)
            continue
        matches: list[GithubHit] = []
        for repo in others[:MAX_LOOKUP_REPOS]:
            if full():
                break
            hit = _lookup(repo, num)
            if hit is not None:
                matches.append(hit)
                if len(matches) >= AMBIGUOUS_HITS:
                    break
        if len(matches) > 1:
            for hit in matches:
                hit.why = f"#{num} existe dans plusieurs dépôts — vérifie lequel est concerné"
        for hit in matches:
            add(hit)
            if len(hits) >= MAX_HITS:
                return hits
        if full():
            return hits

    if all_repos:
        owners = list(dict.fromkeys(r.split("/", 1)[0] for r in repos if "/" in r))[:MAX_OWNERS]
        filters = [a for o in owners for a in ("--owner", o)]
    else:
        filters = [a for r in repos[:MAX_SEARCH_REPOS] for a in ("--repo", r)]

    for kind, limit in (("prs", 3), ("issues", 3), ("commits", 2)):
        for q in queries:
            if full():
                return hits
            for hit in _search(kind, q, filters, limit):
                add(hit)
                if len(hits) >= MAX_HITS:
                    return hits
    return hits


def _lookup(repo: str, num: int) -> Optional[GithubHit]:
    why = f"#{num} cité dans la conversation"
    for kind, sub in (("pr", "pr"), ("issue", "issue")):
        data = _json(_gh([sub, "view", str(num), "--repo", repo, "--json", "number,title,state,url"], timeout=CALL_TIMEOUT))
        if isinstance(data, dict) and data.get("url"):
            return _hit(kind, repo, data, why)
    return None


def _search(kind: str, query: str, filters: list[str], limit: int) -> list[GithubHit]:
    fields = "sha,commit,repository,url" if kind == "commits" else _SEARCH_FIELDS
    data = _json(_gh(["search", kind, *filters, "--limit", str(limit), "--json", fields, "--", query], timeout=CALL_TIMEOUT))
    if not isinstance(data, list):
        return []
    why = f"Recherche « {query} »"
    out: list[GithubHit] = []
    for item in data:
        if not isinstance(item, dict) or not item.get("url"):
            continue
        repo = _repo_name(item.get("repository"))
        if not repo:
            continue
        if kind == "commits":
            message = str((item.get("commit") or {}).get("message", "")).strip().splitlines()
            title = message[0] if message else str(item.get("sha", ""))[:7]
            out.append(GithubHit(kind="commit", repo=repo, number=None, title=title[:200], state=None, url=item["url"], why=why))
        else:
            hit = _hit("pr" if kind == "prs" else "issue", repo, item, why)
            if hit is not None:
                out.append(hit)
    return out


def _hit(kind: str, repo: str, data: dict, why: str) -> Optional[GithubHit]:
    try:
        number = int(data["number"])
    except (KeyError, TypeError, ValueError):
        return None
    state = str(data.get("state", "")).lower()
    return GithubHit(
        kind=kind,  # type: ignore[arg-type]
        repo=repo,
        number=number,
        title=str(data.get("title", "")).strip()[:200] or f"#{number}",
        state=state if state in ("open", "closed", "merged") else None,  # type: ignore[arg-type]
        url=str(data["url"]),
        why=why,
    )


def _repo_name(repo) -> str:
    if isinstance(repo, dict):
        return str(repo.get("nameWithOwner") or repo.get("fullName") or "")
    return str(repo or "")


def _json(out: str):
    if not out:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


_SSO_RE = re.compile(r"SAML|\bSSO\b|single sign-on", re.IGNORECASE)
_SSO_ORG_RE = re.compile(r"github\.com/orgs/([\w.-]+)/sso", re.IGNORECASE)
_sso_blocked: set[str] = set()
_sso_lock = threading.Lock()


def sso_blocked() -> list[str]:
    """Orgs whose last gh call failed on SAML/SSO enforcement (token not authorized)."""
    with _sso_lock:
        return sorted(_sso_blocked)


def _owners(args: list[str]) -> list[str]:
    out: list[str] = []
    for flag, value in zip(args, args[1:]):
        if flag in ("--repo", "-R", "--owner") and value:
            owner = value.split("/", 1)[0].strip()
            if owner and owner not in out:
                out.append(owner)
    return out


def _track_sso(args: list[str], ok: bool, stderr: str) -> None:
    owners = _owners(args)
    with _sso_lock:
        if ok:
            _sso_blocked.difference_update(owners)
        elif stderr and _SSO_RE.search(stderr):
            orgs = _SSO_ORG_RE.findall(stderr) or (owners if len(owners) == 1 else [])
            _sso_blocked.update(orgs)


def _run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _gh(args: list[str], timeout: float = 20) -> str:
    try:
        proc = _run(["gh", *args], timeout)
    except Exception:
        return ""
    ok = proc.returncode == 0
    _track_sso(args, ok, proc.stderr or "")
    return (proc.stdout or "").strip() if ok else ""
