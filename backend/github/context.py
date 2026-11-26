from __future__ import annotations
import json
import re
import subprocess
import threading
import time
from datetime import datetime
from typing import Optional

from models import GithubHit
from winproc import _creationflags

# Read-only GitHub context. Consulted only when a message looks repo/code related.
# Never writes (no comment, issue or commit). Uses `gh` with the poste's tokens.

_TRIGGERS = re.compile(
    r"\b(PR|pull request|issue|#\d+|repo|branch|merge|commit|CI|pipeline|bug|déploiement|deploy)\b",
    re.IGNORECASE,
)
_PR_RE = re.compile(r"#(\d+)")
# A pasted link names its repo exactly: https://github.com/owner/repo/pull/42 (or /issues/42).
_URL_RE = re.compile(r"github\.com/([\w.-]+/[\w.-]+)/(pull|issues)/(\d+)", re.IGNORECASE)


def linked_refs(text: str) -> list[tuple[str, str, int]]:
    """(kind, repo, number) for each GitHub PR / issue link in the text, de-duplicated."""
    out: list[tuple[str, str, int]] = []
    for repo, path, num in _URL_RE.findall(text):
        ref = ("pr" if path.lower() == "pull" else "issue", repo, int(num))
        if all((r[1].lower(), r[2]) != (repo.lower(), ref[2]) for r in out):
            out.append(ref)
    return out[:MAX_NUMBERS]


def is_relevant(text: str) -> bool:
    return bool(_TRIGGERS.search(text) or _URL_RE.search(text))


def fetch(text: str, repos: list[str], enabled: bool) -> str:
    """Facts for the draft: who, what state, who reviews. Linked repos first, then #N
    looked up in the account's repos. Lets the brain answer instead of promising to look."""
    if not enabled or not is_relevant(text):
        return ""
    refs: list[str] = []
    seen: set[tuple[str, int]] = set()
    for kind, repo, num in linked_refs(text):
        line = describe(kind, repo, num)
        if line:
            refs.append(line)
            seen.add((repo.lower(), num))
    for num in mentioned_numbers(text):
        if any(n == num for _, n in seen):
            continue
        for repo in repos[:MAX_LOOKUP_REPOS]:
            line = describe("pr", repo, num)
            if line:
                refs.append(line)
                break
    return "\n".join(refs)


_PR_FIELDS = "number,title,state,isDraft,author,assignees,reviewRequests,latestReviews,mergedAt,url"
_ISSUE_FIELDS = "number,title,state,author,assignees,url"
_STATES = {"OPEN": "ouverte", "MERGED": "mergée", "CLOSED": "fermée"}
_REVIEWS = {"APPROVED": "approuvée", "CHANGES_REQUESTED": "changements demandés", "COMMENTED": "commentée",
            "DISMISSED": "avis retiré"}


def describe(kind: str, repo: str, num: int) -> str:
    """One line of facts on a PR or an issue, or "" when gh cannot read it."""
    sub = "pr" if kind == "pr" else "issue"
    data = _json(_gh([sub, "view", str(num), "--repo", repo, "--json", _PR_FIELDS if sub == "pr" else _ISSUE_FIELDS],
                     timeout=CALL_TIMEOUT))
    if not isinstance(data, dict) or not data.get("url"):
        return ""
    state = _STATES.get(str(data.get("state", "")).upper(), str(data.get("state", "")).lower())
    if sub == "pr" and data.get("isDraft") and state == "ouverte":
        state = "brouillon"
    if data.get("mergedAt"):
        state += f" le {_local(data['mergedAt'])}"
    facts = [f"état : {state}", f"auteur : {_login(data.get('author')) or 'inconnu'}",
             f"assignés : {', '.join(filter(None, map(_login, data.get('assignees') or []))) or 'aucun'}"]
    if sub == "pr":
        asked = ", ".join(filter(None, map(_login, data.get("reviewRequests") or [])))
        reviews = ", ".join(f"{_login(r.get('author'))} ({_REVIEWS.get(r.get('state', ''), str(r.get('state', '')).lower())})"
                            for r in data.get("latestReviews") or [] if isinstance(r, dict) and _login(r.get("author")))
        facts.append(f"revue demandée à : {asked or 'personne'}")
        if reviews:
            facts.append(f"avis : {reviews}")
    label = "PR" if sub == "pr" else "Issue"
    return f"{repo} • {label} #{num} « {str(data.get('title', '')).strip()} » — {' ; '.join(facts)} ({data['url']})"


def _login(who) -> str:
    """A user ({login}) or a team ({name} / {slug}) as gh returns them."""
    if not isinstance(who, dict):
        return ""
    return str(who.get("login") or who.get("name") or who.get("slug") or "")


def _local(iso: str) -> str:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone().strftime("%d/%m à %H:%M")
    except ValueError:
        return str(iso)


LINK_TTL = 300.0
LINK_CACHE_MAX = 200
_REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
_link_cache: dict[tuple[str, str, int], tuple[float, Optional[GithubHit]]] = {}
_link_lock = threading.Lock()


def link_info(kind: str, repo: str, num: int) -> Optional[GithubHit]:
    """Title and state of a PR / issue whose link is shown in a message, cached 5 min:
    the conversation view asks for each GitHub link it draws. None when gh cannot read it."""
    if kind not in ("pr", "issue") or not _REPO_RE.match(repo) or num <= 0:
        return None
    key = (kind, repo.lower(), num)
    now = time.monotonic()
    with _link_lock:
        cached = _link_cache.get(key)
        if cached and now - cached[0] < LINK_TTL:
            return cached[1]
    data = _json(_gh([kind, "view", str(num), "--repo", repo, "--json", "number,title,state,url"], timeout=CALL_TIMEOUT))
    hit = _hit(kind, repo, data, "Lien dans la conversation") if isinstance(data, dict) and data.get("url") else None
    with _link_lock:
        if len(_link_cache) >= LINK_CACHE_MAX:
            _link_cache.pop(next(iter(_link_cache)))
        _link_cache[key] = (now, hit)
    return hit


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
    Links (github.com/owner/repo/pull/N) are looked up first, in the repo they name.
    Capped at MAX_HITS, de-duplicated, bounded by DEADLINE overall."""
    links = linked_refs(transcript)
    if not repos and not links:
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

    for _kind, repo, num in links:
        if full():
            return hits
        add(_lookup(repo, num, why=f"#{num} lié dans la conversation"))
    linked = {num for _, _, num in links}

    named = named_repos(repos, transcript)
    others = [r for r in repos if r not in named]
    for num in numbers:
        if num in linked:
            continue
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


def _lookup(repo: str, num: int, why: str = "") -> Optional[GithubHit]:
    why = why or f"#{num} cité dans la conversation"
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
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          stdin=subprocess.DEVNULL, creationflags=_creationflags())


def _gh(args: list[str], timeout: float = 20) -> str:
    try:
        proc = _run(["gh", *args], timeout)
    except Exception:
        return ""
    ok = proc.returncode == 0
    _track_sso(args, ok, proc.stderr or "")
    return (proc.stdout or "").strip() if ok else ""
