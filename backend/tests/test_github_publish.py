"""Publishing a meeting report to GitHub as a draft pull request. No real gh process:
the GitHub API is simulated by a fake runner, and every meeting / repo here is made up."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace

import pytest

from drivers.mock import MockTeamsDriver
from github import publish as pub
from github.auth import GithubStatus
from watcher import ActionError, Watcher
from conftest import FakeBrain


# --- pure helpers -----------------------------------------------------------------

def test_slug_and_paths():
    assert pub.slugify("Point interop HL7 — réunion") == "point-interop-hl7-reunion"
    assert pub.report_path("docs/comptes-rendus/{date}-{slug}.md", "2026-11-26", "Point interop") \
        == "docs/comptes-rendus/2026-11-26-point-interop.md"
    assert pub.branch_for("docs/comptes-rendus/2026-11-26-point-interop.md") \
        == "trame/compte-rendu/2026-11-26-point-interop"
    # {date} missing stays usable, never an absolute path.
    assert not pub.report_path("docs/{slug}.md", None, "Réu").startswith("/")


def test_resolve_repo_prefers_link_then_map_then_name():
    repos = ["acme/interop", "acme/portail"]
    # A GitHub link in the transcript wins.
    g = pub.resolve_repo("Weekly", "voir https://github.com/acme/portail/pull/12", repos, {})
    assert g and g.repo == "acme/portail" and g.confident
    # A remembered mapping wins even without a link, even if not in the list.
    g = pub.resolve_repo("Weekly interop", "", repos, {pub.title_key("Weekly interop"): "acme/outils"})
    assert g and g.repo == "acme/outils" and g.confident
    # A single named repo is a candidate, but not confident.
    g = pub.resolve_repo("Réunion portail", "", repos, {})
    assert g and g.repo == "acme/portail" and not g.confident
    # Nothing sure → None (the UI then asks the user to pick).
    assert pub.resolve_repo("Réunion", "", repos, {}) is None


# --- a simulated GitHub, driven through the gh CLI --------------------------------

class FakeGh:
    """Simulates the `gh api` / `gh pr list` calls GithubWriter makes."""

    def __init__(self, *, default_branch="main", base_sha="basesha", files=None, refs=None,
                 open_prs=None, no_draft=False, deny_write=False):
        self.default_branch = default_branch
        self.base_sha = base_sha
        self.files = dict(files or {})          # path -> html_url (on the default branch)
        self.refs = set(refs or [])             # existing branch names
        self.open_prs = dict(open_prs or {})    # branch -> pr json
        self.no_draft = no_draft
        self.deny_write = deny_write
        self.created_refs: list[dict] = []
        self.put_files: list[dict] = []
        self.created_prs: list[dict] = []
        self.pr_attempts: list[dict] = []

    def run(self, cmd, timeout, stdin):
        out, err, code = self._dispatch(cmd, stdin)
        return CompletedProcess(args=cmd, returncode=code, stdout=out, stderr=err)

    def _dispatch(self, cmd, stdin):
        if cmd[:1] == ["repo"]:
            return json.dumps([{"nameWithOwner": "acme/portail", "viewerPermission": "WRITE"},
                               {"nameWithOwner": "acme/readonly", "viewerPermission": "READ"}]), "", 0
        if cmd[:1] == ["pr"]:
            branch = cmd[cmd.index("--head") + 1]
            pr = self.open_prs.get(branch)
            return json.dumps([pr] if pr else []), "", 0
        # gh api …
        endpoint = cmd[3]
        method = cmd[cmd.index("--method") + 1] if "--method" in cmd else "GET"
        body = json.loads(stdin) if stdin else {}
        return self._api(endpoint, method, body)

    def _api(self, endpoint, method, body):
        if self.deny_write and method != "GET":
            return "", "HTTP 403: Resource not accessible by personal access token", 1
        if "/git/ref/heads/" in endpoint:
            branch = endpoint.split("/git/ref/heads/", 1)[1]
            if branch == self.default_branch or branch in self.refs:
                return json.dumps({"object": {"sha": self.base_sha}}), "", 0
            return "", "gh: Not Found (HTTP 404)", 1
        if endpoint.endswith("/git/refs") and method == "POST":
            ref = body["ref"].split("refs/heads/", 1)[1]
            if ref in self.refs:
                return "", "HTTP 422: Reference already exists", 1
            self.refs.add(ref)
            self.created_refs.append(body)
            return json.dumps({"ref": body["ref"]}), "", 0
        if "/contents/" in endpoint and method == "GET":
            path = endpoint.split("/contents/", 1)[1].split("?", 1)[0]
            ref = endpoint.split("ref=", 1)[1] if "ref=" in endpoint else self.default_branch
            # The file only exists on the default branch here.
            if path in self.files and ref == self.default_branch:
                return json.dumps({"html_url": self.files[path]}), "", 0
            return "", "gh: Not Found (HTTP 404)", 1
        if "/contents/" in endpoint and method == "PUT":
            path = endpoint.split("/contents/", 1)[1]
            self.put_files.append({"path": path, "branch": body.get("branch"), "content": body.get("content")})
            return json.dumps({"content": {"html_url": f"https://github.com/x/blob/{body.get('branch')}/{path}"}}), "", 0
        if endpoint.endswith("/pulls") and method == "POST":
            self.pr_attempts.append(body)
            if self.no_draft and body.get("draft"):
                return "", "HTTP 422: Draft pull requests are not supported in this repository.", 1
            num = 100 + len(self.created_prs)
            pr = {"html_url": f"https://github.com/acme/portail/pull/{num}", "number": num, "draft": bool(body.get("draft"))}
            self.created_prs.append(body)
            return json.dumps(pr), "", 0
        if endpoint.startswith("repos/") and len(endpoint.split("/")) == 3 and method == "GET":
            return json.dumps({"default_branch": self.default_branch}), "", 0
        return "", f"unexpected {method} {endpoint}", 1


def writer(**kwargs):
    gh = FakeGh(**kwargs)
    return pub.GithubWriter(run=gh.run), gh


def test_create_report_pr_opens_a_draft_branch_file_pr():
    w, gh = writer()
    res = w.create_report_pr("acme/portail", "docs/comptes-rendus/2026-11-26-point.md",
                             "Point interop", "# CR\n\nTexte.", draft=True)
    assert res["url"].endswith("/pull/100") and res["draft"] is True
    # Exactly one new branch, cut from the base tip, never the base itself.
    assert len(gh.created_refs) == 1
    branch = gh.created_refs[0]["ref"].split("refs/heads/", 1)[1]
    assert branch == "trame/compte-rendu/2026-11-26-point" and branch != gh.default_branch
    assert gh.created_refs[0]["sha"] == gh.base_sha
    # The file is written only on that branch — never a push to main.
    assert len(gh.put_files) == 1 and gh.put_files[0]["branch"] == branch
    assert base64.b64decode(gh.put_files[0]["content"]).decode().startswith("# CR")
    # The PR targets the default branch from the new branch; it is a draft.
    pr = gh.created_prs[0]
    assert pr["base"] == "main" and pr["head"] == branch and pr["draft"] is True


def test_never_overwrites_an_existing_file():
    w, gh = writer(files={"docs/comptes-rendus/2026-11-26-point.md": "https://github.com/acme/portail/blob/main/x.md"})
    with pytest.raises(pub.PublishError) as e:
        w.create_report_pr("acme/portail", "docs/comptes-rendus/2026-11-26-point.md", "Point", "# CR", draft=True)
    assert e.value.status == 409
    assert gh.created_refs == [] and gh.put_files == [] and gh.created_prs == []


def test_branch_made_unique_when_it_already_exists():
    w, gh = writer(refs={"trame/compte-rendu/2026-11-26-point"})
    w.create_report_pr("acme/portail", "docs/comptes-rendus/2026-11-26-point.md", "Point", "# CR", draft=True)
    branch = gh.created_refs[0]["ref"].split("refs/heads/", 1)[1]
    assert branch == "trame/compte-rendu/2026-11-26-point-2"


def test_draft_unsupported_falls_back_to_normal_pr():
    w, gh = writer(no_draft=True)
    res = w.create_report_pr("acme/portail", "docs/c/point.md", "Point", "# CR", draft=True)
    assert res["draft"] is False and len(gh.pr_attempts) == 2  # draft attempt, then normal
    assert gh.pr_attempts[0]["draft"] is True and gh.pr_attempts[1]["draft"] is False


def test_missing_write_scope_is_a_clear_403():
    w, _gh = writer(deny_write=True)
    with pytest.raises(pub.PublishError) as e:
        w.create_report_pr("acme/portail", "docs/c/point.md", "Point", "# CR", draft=True)
    assert e.value.status == 403 and "repo" in e.value.message


def test_report_state_detects_merged_file_and_open_pr():
    path = "docs/comptes-rendus/2026-11-26-point.md"
    branch = pub.branch_for(path)
    w, _gh = writer(files={path: "https://github.com/acme/portail/blob/main/" + path})
    st = w.report_state("acme/portail", path)
    assert st.exists and st.url.endswith(path)

    w, _gh = writer(open_prs={branch: {"number": 7, "url": "https://github.com/acme/portail/pull/7", "isDraft": True}})
    st = w.report_state("acme/portail", path)
    assert not st.exists and st.pr_number == 7 and st.pr_draft is True

    w, _gh = writer()
    st = w.report_state("acme/portail", path)
    assert st.repo == "acme/portail" and not st.exists and not st.pr_url


# --- watcher wiring: gating, enforcement, remembering -----------------------------

def _watcher(monkeypatch, write_cfg):
    w = Watcher(MockTeamsDriver(), FakeBrain())
    cfg = json.loads(json.dumps(w.cfg))
    cfg.setdefault("context", {}).setdefault("github", {})["write"] = write_cfg
    w.cfg = cfg
    monkeypatch.setattr("config.save", lambda _c: None)
    return w


def _session(**kw):
    base = dict(id="cr1", title="Point interop HL7", vtt="voir https://github.com/acme/portail/pull/3",
                vtt_path=Path("2026-11-26 Point interop HL7.vtt"), cues=5, meeting_id="m1",
                skill=SimpleNamespace(name="meeting-report"), report="# Compte-rendu\n\nOK.",
                published=None, rev=0)
    base.update(kw)
    return SimpleNamespace(**base)


STATUS_OK = GithubStatus(installed=True, logged_in=True, account="me", scopes=["repo"])
WRITE_ON = {"enabled": True, "repos": "allowlist", "repos_allowlist": ["acme/portail"],
            "path_template": "docs/comptes-rendus/{date}-{slug}.md", "draft": True, "repo_map": {}}
WRITE_OFF = {**WRITE_ON, "enabled": False}


def test_publish_refused_when_write_disabled(monkeypatch):
    w = _watcher(monkeypatch, WRITE_OFF)
    monkeypatch.setattr(w.reports, "get", lambda _id: _session())
    with pytest.raises(ActionError) as e:
        w.github_publish("cr1", "acme/portail", None, None, STATUS_OK)
    assert e.value.status == 409 and "désactivée" in e.value.message


def test_publish_refused_for_unlisted_repo(monkeypatch):
    w = _watcher(monkeypatch, WRITE_ON)
    monkeypatch.setattr(w.reports, "get", lambda _id: _session())
    with pytest.raises(ActionError) as e:
        w.github_publish("cr1", "acme/secret", None, None, STATUS_OK)
    assert e.value.status == 403 and "non autorisé" in e.value.message


def test_publish_opens_pr_marks_session_and_remembers_repo(monkeypatch):
    w = _watcher(monkeypatch, WRITE_ON)
    s = _session()
    monkeypatch.setattr(w.reports, "get", lambda _id: s)
    monkeypatch.setattr(w.reports, "snapshot", lambda _id: {"id": "cr1"})
    gh = FakeGh()
    w.github_writer = pub.GithubWriter(run=gh.run)

    out = w.github_publish("cr1", "acme/portail", None, True, STATUS_OK)
    assert out["published"]["url"].endswith("/pull/100")
    # The session now carries the PR, and nothing was pushed to main.
    assert s.published and s.published["repo"] == "acme/portail"
    assert gh.put_files[0]["branch"].startswith("trame/compte-rendu/")
    assert gh.created_prs[0]["base"] == "main"
    # The meeting → repo mapping is remembered for next time.
    saved = w.cfg["context"]["github"]["write"]["repo_map"]
    assert saved[pub.title_key("Point interop HL7")] == "acme/portail"


def test_plan_blocked_when_write_off_and_guesses_repo_when_on(monkeypatch):
    off = _watcher(monkeypatch, WRITE_OFF)
    monkeypatch.setattr(off.reports, "get", lambda _id: _session())
    plan = off.github_publish_plan("cr1", STATUS_OK)
    assert plan["writeEnabled"] is False and "désactivée" in plan["blocked"]

    on = _watcher(monkeypatch, WRITE_ON)
    monkeypatch.setattr(on.reports, "get", lambda _id: _session())
    on.github_writer = pub.GithubWriter(run=FakeGh().run)
    plan = on.github_publish_plan("cr1", STATUS_OK)
    assert plan["blocked"] == "" and plan["repo"] == "acme/portail" and plan["repoConfident"]
    assert plan["path"] == "docs/comptes-rendus/2026-11-26-point-interop-hl7.md"


def test_report_state_none_when_no_repo_resolved(monkeypatch):
    w = _watcher(monkeypatch, WRITE_ON)
    out = w.github_report_state("m9", "Réunion sans indice", "2026-11-26", None, STATUS_OK)
    assert out["repo"] is None
