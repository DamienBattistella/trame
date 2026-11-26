from __future__ import annotations
import json
import subprocess
import threading

import pytest

from conftest import offline_auth
from github import auth as ghauth
from github import context as gh

REAL_GH = gh._gh
GH = "/usr/bin/gh"
AMBIGUOUS = "#214 existe dans plusieurs dépôts — vérifie lequel est concerné"


class ViewGh:
    """Stub of `gh pr view N --repo R`: answers for the repos listed in `has`."""

    def __init__(self, has):
        self.has = set(has)
        self.calls: list[list[str]] = []

    def __call__(self, args, timeout=20):
        self.calls.append(list(args))
        if args[:2] == ["pr", "view"] and args[4] in self.has:
            repo, num = args[4], args[2]
            return json.dumps({"number": int(num), "title": f"PR {repo}", "state": "OPEN",
                               "url": f"https://github.com/{repo}/pull/{num}"})
        return ""

    def viewed(self):
        return [c[4] for c in self.calls if c[:2] == ["pr", "view"]]


REPOS = ["acme/interop", "acme/portail", "acme/outils"]


def test_number_prefers_repo_named_in_transcript(monkeypatch):
    stub = ViewGh(REPOS)
    monkeypatch.setattr(gh, "_gh", stub)
    hits = gh.search([], [214], REPOS, True, "Lucas : la PR #214 du portail casse le build")
    assert [(h.repo, h.why) for h in hits] == [("acme/portail", "#214 cité dans la conversation")]
    assert stub.viewed() == ["acme/portail"]


def test_number_prefers_owner_slash_name(monkeypatch):
    stub = ViewGh(REPOS)
    monkeypatch.setattr(gh, "_gh", stub)
    hits = gh.search([], [214], REPOS, True, "voir acme/outils#214")
    assert [h.repo for h in hits] == ["acme/outils"]


def test_named_repo_without_the_number_falls_back(monkeypatch):
    stub = ViewGh(["acme/interop"])
    monkeypatch.setattr(gh, "_gh", stub)
    hits = gh.search([], [214], REPOS, True, "le portail et la PR #214")
    assert [(h.repo, h.why) for h in hits] == [("acme/interop", "#214 cité dans la conversation")]


def test_ambiguous_number_keeps_two_flagged_hits(monkeypatch):
    stub = ViewGh(REPOS)
    monkeypatch.setattr(gh, "_gh", stub)
    hits = gh.search([], [214], REPOS, True, "Tu peux relire la PR #214 ?")
    assert [h.repo for h in hits] == ["acme/interop", "acme/portail"]
    assert all(h.why == AMBIGUOUS for h in hits)
    assert stub.viewed() == ["acme/interop", "acme/portail"]


def test_ambiguous_numbers_respect_hit_cap(monkeypatch):
    monkeypatch.setattr(gh, "_gh", ViewGh(REPOS))
    monkeypatch.setattr(gh, "MAX_HITS", 3)
    hits = gh.search([], [214, 215, 216], REPOS, True, "#214 #215 #216")
    assert len(hits) == 3


def test_named_repos_word_boundaries():
    assert gh.named_repos(REPOS, "on parle d'interopérabilité") == []
    assert gh.named_repos(REPOS, "Le dépôt Interop, et acme/outils.") == ["acme/interop", "acme/outils"]


class Done:
    def __init__(self, code=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = code, out, err


SAML_ERR = ("GraphQL: Resource protected by organization SAML enforcement. You must grant your "
            "Personal Access token access to this organization. (repository)")


def test_sso_failure_recorded_then_cleared(monkeypatch):
    monkeypatch.setattr(gh, "_gh", REAL_GH)
    answers = [Done(1, err=SAML_ERR), Done(1, err="HTTP 404: Not Found"), Done(0, out="{}")]
    cmds = []
    monkeypatch.setattr(gh, "_run", lambda cmd, timeout: (cmds.append(cmd), answers.pop(0))[1])
    assert gh._gh(["pr", "view", "1", "--repo", "dedalus/interop"]) == ""
    assert gh.sso_blocked() == ["dedalus"]
    assert gh._gh(["pr", "view", "1", "--repo", "acme/x"]) == ""
    assert gh.sso_blocked() == ["dedalus"]
    assert gh._gh(["pr", "view", "2", "--repo", "dedalus/autre"]) == "{}"
    assert gh.sso_blocked() == []
    assert cmds[0][0] == "gh"


def test_sso_org_from_url_and_multi_owner_search(monkeypatch):
    monkeypatch.setattr(gh, "_gh", REAL_GH)
    err = "HTTP 403: SSO required. Authorize at https://github.com/orgs/dedalus-sante/sso?authorization_request=X"
    monkeypatch.setattr(gh, "_run", lambda cmd, timeout: Done(1, err=err))
    gh._gh(["search", "prs", "obx", "--owner", "a", "--owner", "b"])
    assert gh.sso_blocked() == ["dedalus-sante"]
    monkeypatch.setattr(gh, "_run", lambda cmd, timeout: Done(1, err=SAML_ERR))
    gh._gh(["search", "prs", "obx", "--owner", "a", "--owner", "b"])
    assert gh.sso_blocked() == ["dedalus-sante"]


def test_gh_exception_returns_empty(monkeypatch):
    monkeypatch.setattr(gh, "_gh", REAL_GH)

    def boom(cmd, timeout):
        raise subprocess.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(gh, "_run", boom)
    assert gh._gh(["repo", "list"]) == ""


STATUS_OLD = """github.com
  ✓ Logged in to github.com as octocat (oauth_token)
  ✓ Git operations for github.com configured to use https protocol.
  ✓ Token: gho_************************************
  ✓ Token scopes: gist, read:org, repo, workflow
"""

STATUS_OLDEST = """github.com
  ✓ Logged in to github.com as monalisa (/home/m/.config/gh/hosts.yml)
  ✓ Git operations for github.com configured to use ssh protocol.
"""

STATUS_NEW_MULTI = """github.com
  ✓ Logged in to github.com account perso (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org'

  ✓ Logged in to github.com account DamienPro (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
"""

STATUS_ENV_TOKEN = """github.com
  ✓ Logged in to github.com account ci-bot (GH_TOKEN)
  - Active account: true
  - Git operations protocol: https
  - Token: ghp_************************************
  - Token scopes: none
"""

STATUS_INVALID = """github.com
  X Failed to log in to github.com account octocat (default)
  - Active account: true
  - The token in default is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u octocat
"""

STATUS_NONE = "You are not logged into any GitHub hosts. To log in, run: gh auth login\n"

STATUS_OTHER_HOST = """ghe.example.com
  ✓ Logged in to ghe.example.com account corp (keyring)
  - Active account: true
"""


@pytest.mark.parametrize("text,expected", [
    (STATUS_OLD, (True, "octocat", ["gist", "read:org", "repo", "workflow"])),
    (STATUS_OLDEST, (True, "monalisa", [])),
    (STATUS_NEW_MULTI, (True, "DamienPro", ["gist", "read:org", "repo", "workflow"])),
    (STATUS_ENV_TOKEN, (True, "ci-bot", [])),
    (STATUS_INVALID, (False, None, [])),
    (STATUS_NONE, (False, None, [])),
    (STATUS_OTHER_HOST, (False, None, [])),
    ("", (False, None, [])),
])
def test_parse_auth_status(text, expected):
    assert ghauth.parse_auth_status(text) == expected


@pytest.mark.parametrize("line,code", [
    ("! First copy your one-time code: AB12-CD34\n", "AB12-CD34"),
    ("! Copy your one time code: wxyz-9876", "WXYZ-9876"),
    ("First copy your one-time code:   1A2B-3C4D (expires in 15 minutes)", "1A2B-3C4D"),
    ("Code: QRST-UVWX", "QRST-UVWX"),
    ("Press Enter to open https://github.com/login/device in your browser...", None),
    ("✓ Authentication complete.", None),
])
def test_parse_device_code(line, code):
    assert ghauth.parse_device_code(line) == code


class Stdin:
    def __init__(self):
        self.data = ""
        self.closed = False

    def write(self, s):
        self.data += s

    def flush(self):
        pass

    def close(self):
        self.closed = True


class FakeProc:
    """Fake `gh auth login` process: emits `lines`, then blocks (still running) until killed,
    or exits with `exit_code` once its output is exhausted."""

    def __init__(self, lines, exit_code=None):
        self.lines = list(lines)
        self.exit_code = exit_code
        self.stdin = Stdin()
        self.stdout = self
        self.returncode = None
        self.killed = False
        self._done = threading.Event()

    def readline(self):
        if self.lines:
            return self.lines.pop(0)
        if self.exit_code is not None:
            self.returncode = self.exit_code
            return ""
        self._done.wait(5)
        return ""

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9
        self._done.set()

    def wait(self, timeout=None):
        return self.returncode

    def authorize(self):
        self.returncode = 0
        self._done.set()


LOGIN_OUTPUT = ["! First copy your one-time code: AB12-CD34\n",
                "Press Enter to open https://github.com/login/device in your browser... "]


class Launcher:
    def __init__(self, *procs):
        self.procs = list(procs)
        self.cmds: list[list[str]] = []

    def __call__(self, cmd):
        self.cmds.append(cmd)
        return self.procs.pop(0)


def _status(text, code=0):
    return lambda cmd, timeout: Done(code, err=text) if cmd[1:3] == ["auth", "status"] else pytest.fail(cmd)


def _auth(status_text=STATUS_NONE, launcher=None):
    a = offline_auth(which=lambda name: GH, run=_status(status_text, 1), spawn=launcher or Launcher())
    a.LOGIN_TIMEOUT = 0.3
    return a


def test_status_gh_missing(make_client):
    gh._sso_blocked.add("dedalus")
    client, _w, _d = make_client()
    assert client.get("/api/github/status").json() == {"ok": True, "github": {
        "installed": False, "logged_in": False, "account": None, "scopes": [],
        "sso_blocked": ["dedalus"], "login_pending": False,
        "login_result": None, "login_error": None}}


def test_status_logged_in(make_client):
    client, _w, _d = make_client(github_auth=_auth(STATUS_NEW_MULTI))
    assert client.get("/api/github/status").json()["github"] == {
        "installed": True, "logged_in": True, "account": "DamienPro",
        "scopes": ["gist", "read:org", "repo", "workflow"], "sso_blocked": [], "login_pending": False,
        "login_result": None, "login_error": None}


def test_login_gh_missing(make_client):
    client, _w, _d = make_client()
    r = client.post("/api/github/login")
    assert r.status_code == 409 and r.json() == {"ok": False, "error": "La commande gh n'est pas installée sur ce poste."}


def test_login_already_logged_in(make_client):
    launcher = Launcher()
    client, _w, _d = make_client(github_auth=_auth(STATUS_OLD, launcher))
    r = client.post("/api/github/login")
    assert r.status_code == 409 and r.json()["error"] == "Déjà connecté à GitHub en tant que octocat."
    assert launcher.cmds == []


def test_login_returns_code_and_keeps_process(make_client):
    proc = FakeProc(LOGIN_OUTPUT)
    launcher = Launcher(proc)
    auth = _auth(launcher=launcher)
    client, _w, _d = make_client(github_auth=auth)
    r = client.post("/api/github/login")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "code": "AB12-CD34", "verification_url": "https://github.com/login/device"}
    assert launcher.cmds == [[GH, "auth", "login", "--hostname", "github.com", "--git-protocol", "https",
                              "--web", "--skip-ssh-key"]]
    assert proc.stdin.data == "\n" and proc.stdin.closed and not proc.killed
    assert client.get("/api/github/status").json()["github"]["login_pending"] is True

    again = client.post("/api/github/login")
    assert again.json()["code"] == "AB12-CD34" and len(launcher.cmds) == 1

    proc.authorize()
    assert client.get("/api/github/status").json()["github"]["login_pending"] is False


def test_login_cancel(make_client):
    proc = FakeProc(LOGIN_OUTPUT)
    client, _w, _d = make_client(github_auth=_auth(launcher=Launcher(proc)))
    assert client.post("/api/github/login").status_code == 200
    assert client.post("/api/github/login/cancel").json() == {"ok": True}
    assert proc.killed
    assert client.get("/api/github/status").json()["github"]["login_pending"] is False
    assert client.post("/api/github/login/cancel").json() == {"ok": True}


def test_login_no_code_in_time_is_502_and_killed(make_client):
    proc = FakeProc(["Ouverture du navigateur...\n"])
    client, _w, _d = make_client(github_auth=_auth(launcher=Launcher(proc)))
    r = client.post("/api/github/login")
    assert r.status_code == 502 and r.json()["ok"] is False and "code" in r.json()["error"]
    assert proc.killed
    assert client.get("/api/github/status").json()["github"]["login_pending"] is False


def test_login_process_exits_early(make_client):
    proc = FakeProc(["error connecting to github.com\n"], exit_code=1)
    client, _w, _d = make_client(github_auth=_auth(launcher=Launcher(proc)))
    r = client.post("/api/github/login")
    assert r.status_code == 502 and "error connecting to github.com" in r.json()["error"]


def test_login_pending_without_code_is_409(make_client):
    auth = _auth()
    auth._proc = FakeProc([])
    client, _w, _d = make_client(github_auth=auth)
    r = client.post("/api/github/login")
    assert r.status_code == 409 and r.json()["error"] == "Une connexion GitHub est déjà en cours."
    auth.cancel()


def test_login_env_disables_prompts_only():
    env = ghauth._env()
    assert env["GH_PROMPT_DISABLED"] == "1"
    assert "--web" in ghauth.LOGIN_CMD


def test_repo_list_is_cached(monkeypatch):
    calls = []

    def fake(args, timeout=20):
        calls.append(args)
        return "a/x\nb/y"

    monkeypatch.setattr(gh, "_gh", fake)
    assert gh.list_repos() == ["a/x", "b/y"] and gh.list_repos() == ["a/x", "b/y"]
    assert len(calls) == 1
    monkeypatch.setattr(gh, "_repos_cache", (gh._repos_cache[0] - gh.REPOS_TTL - 1, gh._repos_cache[1]))
    gh.list_repos()
    assert len(calls) == 2


def test_login_outcome_reported_after_gh_exits():
    ok = FakeProc(LOGIN_OUTPUT, exit_code=0)
    auth = ghauth.GithubAuth(which=lambda _n: GH, run=lambda cmd, t: subprocess.CompletedProcess(cmd, 1, "", ""),
                             spawn=Launcher(ok))
    auth.login()
    for _ in range(50):
        if auth.status().login_result:
            break
        threading.Event().wait(0.02)
    st = auth.status()
    assert st.login_pending is False and st.login_result == "ok" and st.login_error is None

    bad = FakeProc(["! First copy your one-time code: AB12-CD34\n", "error: authorization denied\n"], exit_code=1)
    auth = ghauth.GithubAuth(which=lambda _n: GH, run=lambda cmd, t: subprocess.CompletedProcess(cmd, 1, "", ""),
                             spawn=Launcher(bad))
    auth.login()
    for _ in range(50):
        if auth.status().login_result:
            break
        threading.Event().wait(0.02)
    st = auth.status()
    assert st.login_result == "failed" and "authorization denied" in st.login_error


def test_status_parsed_even_when_check_mark_is_mis_decoded():
    text = ("github.com\n  âœ“ Logged in to github.com account DamienBattistella (keyring)\n"
            "  - Active account: true\n  - Token scopes: 'gist', 'read:org', 'repo'\n")
    assert ghauth.parse_auth_status(text) == (True, "DamienBattistella", ["gist", "read:org", "repo"])


HUGO = "QUi est assigné https://github.com/Dedalus-ERP-PAS/alliage/pull/4812"


class DetailGh:
    """Stub of `gh pr|issue view N --repo R --json ...` returning full PR facts."""

    def __init__(self, repo="Dedalus-ERP-PAS/alliage"):
        self.repo = repo
        self.calls: list[list[str]] = []

    def __call__(self, args, timeout=20):
        self.calls.append(list(args))
        if args[0] == "pr" and args[1] == "view" and args[4] == self.repo:
            return json.dumps({
                "number": int(args[2]), "title": "fix(core): cache Environnement", "state": "MERGED",
                "isDraft": False, "author": {"login": "HugoLannes"}, "assignees": [],
                "reviewRequests": [{"__typename": "Team", "name": "Foundation"}],
                "latestReviews": [{"author": {"login": "alliage-factory"}, "state": "APPROVED"}],
                "mergedAt": "2026-11-26T12:10:40Z", "url": f"https://github.com/{self.repo}/pull/{args[2]}",
            })
        return ""


def test_pasted_pr_link_is_relevant_and_parsed():
    assert gh.is_relevant(HUGO)
    assert gh.linked_refs(HUGO) == [("pr", "Dedalus-ERP-PAS/alliage", 4812)]
    assert gh.linked_refs("https://github.com/a/b/issues/7 et github.com/A/B/issues/7") == [("issue", "a/b", 7)]


def test_fetch_link_gives_assignees_reviewers_and_state(monkeypatch):
    stub = DetailGh()
    monkeypatch.setattr(gh, "_gh", stub)
    out = gh.fetch(HUGO, ["acme/autre"], True)
    assert "Dedalus-ERP-PAS/alliage • PR #4812" in out
    assert "assignés : aucun" in out
    assert "auteur : HugoLannes" in out
    assert "revue demandée à : Foundation" in out
    assert "alliage-factory (approuvée)" in out
    assert "état : mergée le 26/11" in out
    # The linked repo is read directly, never guessed among the account's repos.
    assert [c[4] for c in stub.calls] == ["Dedalus-ERP-PAS/alliage"]


def test_fetch_link_and_same_hash_number_read_once(monkeypatch):
    stub = DetailGh()
    monkeypatch.setattr(gh, "_gh", stub)
    out = gh.fetch(HUGO + " (#4812)", ["acme/autre"], True)
    assert out.count("#4812") == 1
    assert len(stub.calls) == 1


def test_fetch_hash_number_still_searches_account_repos(monkeypatch):
    stub = DetailGh("acme/portail")
    monkeypatch.setattr(gh, "_gh", stub)
    out = gh.fetch("la PR #12 est bloquée", ["acme/interop", "acme/portail"], True)
    assert out.startswith("acme/portail • PR #12")


def test_fetch_unreadable_link_gives_nothing(monkeypatch):
    monkeypatch.setattr(gh, "_gh", lambda args, timeout=20: "")
    assert gh.fetch(HUGO, [], True) == ""


def test_search_looks_up_link_even_without_account_repos(monkeypatch):
    monkeypatch.setattr(gh, "_gh", ViewGh(["Dedalus-ERP-PAS/alliage"]))
    hits = gh.search([], [], [], True, HUGO)
    assert [(h.repo, h.number, h.why) for h in hits] == [("Dedalus-ERP-PAS/alliage", 4812, "#4812 lié dans la conversation")]


# ── Liens GitHub affichés dans les messages : titre et état ────────────────────


class LinkGh:
    def __init__(self, state="OPEN"):
        self.state = state
        self.calls: list[list[str]] = []

    def __call__(self, args, timeout=20):
        self.calls.append(list(args))
        kind, num, repo = args[0], args[2], args[4]
        path = "pull" if kind == "pr" else "issues"
        return json.dumps({"number": int(num), "title": f"Titre {num}", "state": self.state,
                           "url": f"https://github.com/{repo}/{path}/{num}"})


def test_link_info_reads_title_and_state_once(monkeypatch):
    stub = LinkGh("MERGED")
    monkeypatch.setattr(gh, "_gh", stub)
    monkeypatch.setattr(gh, "_link_cache", {})
    hit = gh.link_info("pr", "Dedalus-ERP-PAS/alliage", 4271)
    assert (hit.title, hit.state, hit.url) == ("Titre 4271", "merged", "https://github.com/Dedalus-ERP-PAS/alliage/pull/4271")
    assert gh.link_info("pr", "dedalus-erp-pas/alliage", 4271) == hit
    assert stub.calls == [["pr", "view", "4271", "--repo", "Dedalus-ERP-PAS/alliage", "--json", "number,title,state,url"]]


def test_link_info_rejects_odd_input(monkeypatch):
    stub = LinkGh()
    monkeypatch.setattr(gh, "_gh", stub)
    monkeypatch.setattr(gh, "_link_cache", {})
    assert gh.link_info("commit", "acme/portail", 1) is None
    assert gh.link_info("pr", "acme/portail --web", 1) is None
    assert gh.link_info("pr", "acme", 1) is None
    assert gh.link_info("pr", "acme/portail", 0) is None
    assert stub.calls == []


def test_link_info_unreadable_is_cached_none(monkeypatch):
    calls = []
    monkeypatch.setattr(gh, "_gh", lambda args, timeout=20: calls.append(args) or "")
    monkeypatch.setattr(gh, "_link_cache", {})
    assert gh.link_info("issue", "acme/prive", 3) is None
    assert gh.link_info("issue", "acme/prive", 3) is None
    assert len(calls) == 1


def test_link_endpoint_follows_github_setting(make_client, monkeypatch):
    stub = LinkGh()
    monkeypatch.setattr(gh, "_gh", stub)
    monkeypatch.setattr(gh, "_link_cache", {})
    client, _watcher, _driver = make_client()
    r = client.get("/api/github/link", params={"kind": "issue", "repo": "acme/portail", "number": 12}).json()
    assert r["ok"] is True
    assert r["link"]["title"] == "Titre 12" and r["link"]["state"] == "open"
    client.put("/api/settings", json={"github": {"enabled": False}})
    r = client.get("/api/github/link", params={"kind": "pr", "repo": "acme/portail", "number": 13}).json()
    assert r == {"ok": True, "link": None}
    assert [c[2] for c in stub.calls] == ["12"]
