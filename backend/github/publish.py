"""Publishing a meeting report to GitHub as a pull request.

Trame never writes to GitHub on its own: this module is reached only from an explicit
click in the report dialog, never from the brain, a skill script or Auto mode, and never
unless the user turned write access on in the settings. Even then the only change it ever
makes is **one new branch + one new file + one draft pull request**:

- it never pushes to the base branch (it only opens a PR against it);
- it never overwrites a file that already exists (it refuses with a 409);
- it never merges the pull request.

Trame does not touch the GitHub token: every call goes through the local `gh` CLI, which
keeps the credentials in its own store. The process runner is injectable for tests.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import unicodedata
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Callable, Optional

from github import context as ghctx
from settings import DEFAULT_PATH_TEMPLATE
from winproc import _creationflags

# Branch a report rides in on: trame/compte-rendu/<file stem>. Deterministic, so the
# same report maps to the same branch (used to spot an already-opened PR).
BRANCH_PREFIX = "trame/compte-rendu/"
MAX_SLUG = 60
CALL_TIMEOUT = 20.0
_REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
_WORD_RE = re.compile(r"[a-z0-9]+")
# gh error text that means the token lacks the write scopes (contents + pull requests).
_SCOPE_RE = re.compile(
    r"HTTP 40[13]|Resource not accessible|Must have admin|not accessible by|requires? .*scope|Bad credentials",
    re.IGNORECASE,
)
_NOT_FOUND_RE = re.compile(r"HTTP 404|Not Found", re.IGNORECASE)


class PublishError(RuntimeError):
    def __init__(self, status: int, message: str, url: str = ""):
        super().__init__(message)
        self.status = status
        self.message = message
        self.url = url


@dataclass
class RepoGuess:
    repo: str
    reason: str
    # confident: a GitHub link or a remembered mapping; otherwise just a name match, to
    # confirm. The UI never publishes to a guessed repo without the user's confirmation.
    confident: bool = False


@dataclass
class ReportState:
    """Whether this meeting's report is already on the repo (file merged) or on its way
    (an open PR), so the user does not re-run the skill for nothing."""
    repo: Optional[str]
    path: str = ""
    branch: str = ""
    exists: bool = False
    url: str = ""
    pr_url: str = ""
    pr_number: Optional[int] = None
    pr_draft: bool = False
    reason: str = ""

    def as_dict(self) -> dict:
        return {"repo": self.repo, "path": self.path, "branch": self.branch, "exists": self.exists,
                "url": self.url, "prUrl": self.pr_url, "prNumber": self.pr_number,
                "prDraft": self.pr_draft, "reason": self.reason}


@dataclass
class PublishPlan:
    report_id: str
    write_enabled: bool
    repo: Optional[str]
    repo_reason: str
    repo_confident: bool
    path: str
    branch: str
    base: str
    draft: bool
    repos: list[str] = field(default_factory=list)
    state: Optional[ReportState] = None
    # Why publishing is impossible right now (write off, no report, missing scope…).
    blocked: str = ""

    def as_dict(self) -> dict:
        return {"reportId": self.report_id, "writeEnabled": self.write_enabled, "repo": self.repo,
                "repoReason": self.repo_reason, "repoConfident": self.repo_confident, "path": self.path,
                "branch": self.branch, "base": self.base, "draft": self.draft, "repos": self.repos,
                "state": self.state.as_dict() if self.state else None, "blocked": self.blocked}


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text).strip("-").lower()[:MAX_SLUG].strip("-")


def title_key(title: str) -> str:
    """A stable key for a meeting title (recurring meetings share one): de-accented words."""
    ascii_text = unicodedata.normalize("NFKD", str(title or "")).encode("ascii", "ignore").decode("ascii").lower()
    return " ".join(_WORD_RE.findall(ascii_text))


def report_path(template: str, date: Optional[str], title: str) -> str:
    slug = slugify(title) or "compte-rendu"
    day = (date or "").strip() or "sans-date"
    path = (template or DEFAULT_PATH_TEMPLATE).replace("{date}", day).replace("{slug}", slug).replace("{title}", slug)
    return path.lstrip("/")


def branch_for(path: str) -> str:
    stem = PurePosixPath(path).stem
    return BRANCH_PREFIX + (slugify(stem) or "compte-rendu")


def resolve_repo(title: str, transcript: str, allowed: list[str], repo_map: dict) -> Optional[RepoGuess]:
    """The repo a meeting's report belongs to: a remembered mapping first, then a GitHub
    link in the transcript, then a repo named in the title. None when nothing is sure
    enough — the UI then lets the user pick."""
    by_lower = {r.lower(): r for r in allowed}
    mapped = (repo_map or {}).get(title_key(title)) if repo_map else None
    if mapped and _REPO_RE.match(str(mapped)):
        return RepoGuess(str(mapped), "déjà associé à cette réunion", confident=True)
    for _kind, repo, _num in ghctx.linked_refs(transcript or ""):
        if not allowed or repo.lower() in by_lower:
            return RepoGuess(by_lower.get(repo.lower(), repo), f"lien GitHub vers {repo} dans la transcription", confident=True)
    named = ghctx.named_repos(allowed, f"{title}\n{transcript or ''}")
    if len(named) == 1:
        return RepoGuess(named[0], f"dépôt « {named[0].split('/')[-1]} » nommé dans la réunion", confident=False)
    return None


def _default_run(cmd: list[str], timeout: float, stdin: Optional[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *cmd], capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, input=stdin, stdin=None if stdin is not None else subprocess.DEVNULL,
                          creationflags=_creationflags())


class GithubWriter:
    """Opens a draft pull request that adds one Markdown file. All GitHub access is through
    `gh`; the runner is injectable so tests simulate the API without a real process."""

    def __init__(self, run: Callable[[list[str], float, Optional[str]], subprocess.CompletedProcess] = _default_run):
        self.run = run

    # --- raw gh calls ---
    def _call(self, cmd: list[str], stdin: Optional[str] = None) -> tuple[bool, str, str]:
        try:
            proc = self.run(cmd, CALL_TIMEOUT, stdin)
        except Exception as e:  # noqa: BLE001 — surfaced as a clean error below
            return False, "", str(e)
        return proc.returncode == 0, (proc.stdout or ""), (proc.stderr or "")

    def _api(self, endpoint: str, method: str = "GET", body: Optional[dict] = None) -> tuple[bool, object, str]:
        cmd = ["api", "-H", "Accept: application/vnd.github+json", endpoint]
        if method != "GET":
            cmd += ["--method", method]
        stdin = None
        if body is not None:
            cmd += ["--input", "-"]
            stdin = json.dumps(body)
        ok, out, err = self._call(cmd, stdin)
        if not ok:
            return False, None, err.strip() or out.strip()
        try:
            return True, json.loads(out) if out.strip() else {}, ""
        except ValueError:
            return True, {}, ""

    @staticmethod
    def _raise(err: str, default_status: int = 502) -> None:
        if _SCOPE_RE.search(err):
            raise PublishError(403, "GitHub a refusé l'écriture : le jeton gh n'a pas le droit d'écrire. "
                                    "Reconnecte-toi à GitHub avec les droits « repo » (contents + pull requests) "
                                    "— Trame ne touche jamais au jeton.")
        if _NOT_FOUND_RE.search(err):
            raise PublishError(404, "Dépôt ou branche introuvable, ou accès refusé (SSO de l'organisation ?).")
        raise PublishError(default_status, f"GitHub a répondu une erreur : {err[:200] or 'inconnue'}")

    # --- reads ---
    def default_branch(self, repo: str) -> str:
        ok, data, err = self._api(f"repos/{repo}")
        if not ok:
            self._raise(err, 404)
        branch = isinstance(data, dict) and data.get("default_branch")
        if not branch:
            raise PublishError(404, f"Branche par défaut de {repo} illisible.")
        return str(branch)

    def head_sha(self, repo: str, branch: str) -> str:
        ok, data, err = self._api(f"repos/{repo}/git/ref/heads/{branch}")
        if not ok:
            self._raise(err, 404)
        sha = (data.get("object") or {}).get("sha") if isinstance(data, dict) else None
        if not sha:
            raise PublishError(404, f"Tête de la branche {branch} introuvable sur {repo}.")
        return str(sha)

    def file_url(self, repo: str, path: str, ref: Optional[str]) -> Optional[str]:
        """The file's URL if it already exists on `ref` (default branch when None), else None."""
        endpoint = f"repos/{repo}/contents/{path}" + (f"?ref={ref}" if ref else "")
        ok, data, err = self._api(endpoint)
        if ok and isinstance(data, dict):
            return str(data.get("html_url") or data.get("url") or f"https://github.com/{repo}/blob/{ref or 'HEAD'}/{path}")
        if _NOT_FOUND_RE.search(err):
            return None
        if _SCOPE_RE.search(err):
            self._raise(err)
        return None

    def ref_exists(self, repo: str, branch: str) -> bool:
        ok, _data, _err = self._api(f"repos/{repo}/git/ref/heads/{branch}")
        return ok

    def open_pr_for_branch(self, repo: str, branch: str) -> Optional[dict]:
        ok, out, err = self._call(["pr", "list", "--repo", repo, "--head", branch, "--state", "open",
                                   "--json", "number,url,title,isDraft"])
        if not ok:
            return None
        try:
            data = json.loads(out) if out.strip() else []
        except ValueError:
            return None
        return data[0] if isinstance(data, list) and data else None

    def writable_repos(self, all_repos: bool, allowlist: list[str]) -> list[str]:
        allowed = [r for r in allowlist if r and r.strip()]
        if not all_repos:
            return allowed
        ok, out, _err = self._call(["repo", "list", "--json", "nameWithOwner,viewerPermission", "--limit", "100"])
        found: list[str] = []
        if ok:
            try:
                for item in json.loads(out) if out.strip() else []:
                    if str(item.get("viewerPermission", "")).upper() in ("ADMIN", "MAINTAIN", "WRITE"):
                        name = str(item.get("nameWithOwner") or "")
                        if name:
                            found.append(name)
            except ValueError:
                pass
        return found + [r for r in allowed if r not in found]

    def report_state(self, repo: str, path: str) -> ReportState:
        """Is this report already on `repo` — merged as a file, or waiting in an open PR?"""
        path = path.lstrip("/")
        branch = branch_for(path)
        state = ReportState(repo=repo, path=path, branch=branch)
        url = self.file_url(repo, path, None)
        if url:
            state.exists = True
            state.url = url
            state.reason = "compte-rendu déjà présent dans le dépôt"
            return state
        pr = self.open_pr_for_branch(repo, branch)
        if pr:
            state.pr_url = str(pr.get("url") or "")
            state.pr_number = pr.get("number")
            state.pr_draft = bool(pr.get("isDraft"))
            state.reason = "une pull request ouvre déjà ce compte-rendu"
        return state

    # --- the one write ---
    def create_report_pr(self, repo: str, path: str, pr_title: str, markdown: str,
                         draft: bool = True, base: Optional[str] = None,
                         commit_message: Optional[str] = None, pr_body: str = "") -> dict:
        """Branch + new file + draft PR. Refuses to overwrite; never pushes to `base`."""
        if not _REPO_RE.match(repo or ""):
            raise PublishError(422, "Dépôt invalide (attendu : owner/nom).")
        path = (path or "").lstrip("/")
        if not path or ".." in path.split("/") or "\\" in path or not path.lower().endswith(".md"):
            raise PublishError(422, "Chemin de fichier invalide (relatif, sans « .. », terminé par .md).")
        if not markdown.strip():
            raise PublishError(422, "Compte-rendu vide : rien à publier.")

        base = base or self.default_branch(repo)
        sha = self.head_sha(repo, base)
        # Never overwrite: if the file is already there, stop and point to it.
        existing = self.file_url(repo, path, base)
        if existing:
            raise PublishError(409, f"Un fichier existe déjà à « {path} » sur {repo} : rien n'est écrasé.",
                               url=existing)

        branch = branch_for(path)
        unique, n = branch, 2
        while self.ref_exists(repo, unique):
            unique = f"{branch}-{n}"
            n += 1
        branch = unique

        ok, _data, err = self._api(f"repos/{repo}/git/refs", "POST",
                                   {"ref": f"refs/heads/{branch}", "sha": sha})
        if not ok:
            self._raise(err)

        content = base64.b64encode(markdown.rstrip().encode("utf-8") + b"\n").decode("ascii")
        ok, _data, err = self._api(f"repos/{repo}/contents/{path}", "PUT",
                                   {"message": commit_message or f"docs: compte-rendu « {pr_title} »",
                                    "content": content, "branch": branch})
        if not ok:
            self._raise(err)

        payload = {"title": pr_title, "head": branch, "base": base, "body": pr_body, "draft": bool(draft)}
        ok, data, err = self._api(f"repos/{repo}/pulls", "POST", payload)
        draft_used = bool(draft)
        if not ok and draft and re.search(r"draft", err, re.IGNORECASE):
            # Some repos / plans do not allow draft PRs: fall back to a normal PR, and say so.
            payload["draft"] = False
            draft_used = False
            ok, data, err = self._api(f"repos/{repo}/pulls", "POST", payload)
        if not ok or not isinstance(data, dict) or not data.get("html_url"):
            self._raise(err)

        return {"url": str(data["html_url"]), "number": data.get("number"),
                "draft": bool(data.get("draft", draft_used)), "branch": branch, "path": path, "base": base}
