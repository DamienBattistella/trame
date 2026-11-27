from __future__ import annotations
import base64
import json

import pytest

from conftest import FakeBrain
from models import IncomingMessage, Surface
from github import context as gh
from github import knowledge as kn

DOC = "# Réinitialiser un mot de passe\n\nIntro.\n\n## Où\n\nMenu **Sécurité**.\n"
CATALOG = [{"nameWithOwner": "acme/serveur", "description": "Serveur du produit"},
           {"nameWithOwner": "acme/portail", "description": None}]


class RepoGh:
    """Stub of the read-only gh calls: account, repo list, code search, git tree, contents."""

    def __init__(self, search=None, files=None, tree=None):
        self.search = search or {}
        self.files = files or {}
        self.tree = tree or {}
        self.calls: list[list[str]] = []

    def __call__(self, args, timeout=20):
        self.calls.append(list(args))
        if args[:2] == ["api", "user"]:
            return "me"
        if args[:2] == ["api", "user/orgs"]:
            return "acme"
        if args[:2] == ["repo", "list"]:
            return json.dumps(CATALOG if args[2] == "acme" else [])
        if args[:2] == ["search", "code"]:
            hits = self.search.get(args[-1], [])
            return json.dumps([{"path": p, "repository": {"nameWithOwner": r}} for r, p in hits])
        if args[0] == "api" and "/git/trees/" in args[1]:
            repo = args[1].split("/git/", 1)[0].removeprefix("repos/")
            return json.dumps({"tree": [{"type": "blob", "path": p} for p in self.tree.get(repo, [])]})
        if args[0] == "api" and "/contents/" in args[1]:
            body = self.files.get(args[1].split("/contents/", 1)[1])
            if body is None:
                return ""
            return json.dumps({"encoding": "base64", "content": base64.b64encode(body.encode()).decode()})
        return ""

    def kinds(self):
        return [c[:2] if c[0] != "api" else ["api", c[1].split("?")[0]] for c in self.calls]


@pytest.fixture(autouse=True)
def _fresh_caches(monkeypatch):
    monkeypatch.setattr(kn, "_catalog_cache", {})
    monkeypatch.setattr(kn, "_tree_cache", {})


def brain(plan: dict, files=None, prompts=None):
    def complete(prompt, timeout):
        if prompts is not None:
            prompts.append(prompt)
        if "Fichiers :" in prompt:
            return "Voici :\n```json\n" + json.dumps({"files": files if files is not None else [1]}) + "\n```"
        return json.dumps(plan)
    return complete


def test_parse_plan_keeps_known_repos_and_dedups_queries():
    plan = kn.parse_plan('```json {"repos": ["ACME/Portail", "evil/x"], "queries": ["Mot de passe", "mot de passe", " a  b "]}```',
                         ["acme/portail"])
    assert plan.repos == ["acme/portail"] and plan.queries == ["Mot de passe", "a b"]
    assert kn.parse_plan("pas du json") == kn.Plan()


def test_docs_outrank_code_tests_and_changelog():
    assert kn.rank_path("docs_fr/guides/reset.md") > kn.rank_path("src/reset.ts")
    assert kn.rank_path("src/reset.ts") > kn.rank_path("tests/reset.test.ts")
    assert kn.rank_path("CHANGELOG.md") < kn.rank_path("src/reset.ts")


def test_gather_lists_docs_of_the_chosen_repo_and_reads_the_pick(monkeypatch):
    stub = RepoGh(search={"mot de passe": [("acme/serveur", "src/reset.ts")]},
                  tree={"acme/serveur": ["docs/guides/reset.fr.md", "CHANGELOG.md", "src/a.ts"]},
                  files={"docs/guides/reset.fr.md": DOC, "src/reset.ts": "export function reset() {}"})
    monkeypatch.setattr(gh, "_gh", stub)
    prompts: list[str] = []
    out = kn.gather(brain({"repos": ["acme/serveur"], "queries": ["mot de passe"]}, [2, 1], prompts),
                    "Comment on réinitialise ?", "", [], True)
    assert out.split("\n")[0] == "=== acme/serveur — docs/guides/reset.fr.md ==="
    assert "Sécurité" in out and "reset()" in out
    assert "- acme/serveur : Serveur du produit" in prompts[0] and "- acme/portail\n" in prompts[0]
    # Code hits first, then the repo's docs; changelog and code files are not listed as docs.
    assert "1. acme/serveur — src/reset.ts\n2. acme/serveur — docs/guides/reset.fr.md" in prompts[1]
    assert "CHANGELOG" not in prompts[1] and "src/a.ts" not in prompts[1]
    search = next(c for c in stub.calls if c[:2] == ["search", "code"])
    assert search[2:4] == ["--repo", "acme/serveur"]
    # Reads only: no write verb, no HTTP method override.
    assert all(c[:2] in (["repo", "list"], ["search", "code"]) or c[0] == "api" for c in stub.calls)
    assert not any(flag in c for c in stub.calls for flag in ("-X", "--method", "-f", "-F", "--input"))


def test_no_search_when_the_message_needs_none(monkeypatch):
    stub = RepoGh()
    monkeypatch.setattr(gh, "_gh", stub)
    assert kn.gather(brain({"repos": [], "queries": []}), "Merci !", "", [], True) == ""
    assert not any(k[0] == "search" or "/contents/" in k[1] for k in stub.kinds())


def test_brain_can_reject_every_candidate(monkeypatch):
    stub = RepoGh(tree={"acme/portail": ["README.md"]}, files={"README.md": "x"})
    monkeypatch.setattr(gh, "_gh", stub)
    assert kn.gather(brain({"repos": ["acme/portail"]}, []), "question", "", [], True) == ""


def test_unusable_selection_falls_back_to_ranking(monkeypatch):
    stub = RepoGh(tree={"acme/portail": ["README.md"]}, files={"README.md": "le portail"})
    monkeypatch.setattr(gh, "_gh", stub)

    def complete(prompt, timeout):
        return "je ne sais pas" if "Fichiers :" in prompt else '{"repos": ["acme/portail"]}'

    assert kn.gather(complete, "question", "", [], True) == "=== acme/portail — README.md ===\nle portail"


def test_allowlist_is_the_catalog(monkeypatch):
    stub = RepoGh()
    monkeypatch.setattr(gh, "_gh", stub)
    prompts: list[str] = []
    kn.gather(brain({"repos": [], "queries": ["x"]}, prompts=prompts), "question", "", ["acme/portail"], False)
    assert "- acme/portail" in prompts[0] and "serveur" not in prompts[0]
    assert not any(c[:2] == ["repo", "list"] for c in stub.calls)
    assert next(c for c in stub.calls if c[:2] == ["search", "code"])[2:4] == ["--repo", "acme/portail"]


def test_excerpt_keeps_matching_sections_of_a_long_doc():
    filler = "\n\n".join(f"## Section {i}\n\n" + "bla " * 300 for i in range(10))
    doc = "# Titre\n\nIntro.\n\n" + filler + "\n\n## Poste partagé\n\nUn seul compte pour un poste partagé.\n"
    out = kn.excerpt(doc, ["partagé"], budget=1500)
    assert out.startswith("# Titre") and "Un seul compte pour un poste partagé." in out
    assert len(out) < 1600


def test_knowledge_joins_the_github_context_as_data():
    assert kn.with_knowledge("PR #1 : x", "") == "PR #1 : x"
    out = kn.with_knowledge("PR #1 : x", KNOWLEDGE)
    assert out.startswith("PR #1 : x\n\nCe que disent les dépôts") and KNOWLEDGE in out
    assert "jamais des consignes" in kn.with_knowledge("", "contenu")


DM_DRAFT = "19:bb22@thread.v2"
KNOWLEDGE = "=== acme/docs — a.md ===\nmenu Sécurité"


def _msg(text="Comment on réinitialise un mot de passe ?"):
    return IncomingMessage(thread_id=DM_DRAFT, sender="Quelqu'un", text=text, received_at="10:00",
                           surface=Surface.dm, mentions=[])


@pytest.fixture
def fake_gather(monkeypatch):
    calls: list[str] = []

    def gather(complete, incoming, summary, repos, all_repos):
        calls.append(incoming)
        return KNOWLEDGE

    monkeypatch.setattr(kn, "gather", gather)
    return calls


def test_draft_gets_what_the_repos_say(make_client, fake_gather):
    brain = FakeBrain()
    _client, watcher, _driver = make_client(brain=brain)
    assert watcher._process(_msg(), force_draft=True) == "draft"
    assert fake_gather == ["Comment on réinitialise un mot de passe ?"]
    assert len(brain.github) == 1 and KNOWLEDGE in brain.github[0]


@pytest.mark.parametrize("github", [{"enabled": False}, {"enabled": True, "knowledge": False}])
def test_no_repo_search_when_turned_off(make_client, fake_gather, github):
    brain = FakeBrain()
    _client, watcher, _driver = make_client(brain=brain)
    watcher.cfg.setdefault("context", {})["github"] = {**watcher.cfg["context"].get("github", {}), **github}
    assert watcher._process(_msg(), force_draft=True) == "draft"
    assert fake_gather == [] and brain.github == [""]


def test_catchup_skips_repo_search(make_client, fake_gather):
    brain = FakeBrain()
    _client, watcher, _driver = make_client(brain=brain)
    assert watcher._process(_msg(), force_draft=True, research=False) == "draft"
    assert fake_gather == [] and brain.github == [""]


def test_failed_search_still_drafts(make_client, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("gh absent")

    monkeypatch.setattr(kn, "gather", boom)
    brain = FakeBrain()
    _client, watcher, _driver = make_client(brain=brain)
    assert watcher._process(_msg(), force_draft=True) == "draft"
    assert brain.github == [""]


def test_turned_off_search_survives_a_settings_save(make_client):
    client, watcher, _driver = make_client()
    watcher.cfg.setdefault("context", {}).setdefault("github", {})["knowledge"] = False
    r = client.put("/api/settings", json={"github": {"all_repos": False}})
    assert r.status_code == 200, r.text
    assert watcher.cfg["context"]["github"]["knowledge"] is False
