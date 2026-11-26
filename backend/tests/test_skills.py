"""Agent skills: discovery, limits, activation, and the on-demand protocol. Every skill
here is made up for the tests."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import reflection
import skills
from brain.base import Brain, build_prompt
from conftest import FakeBrain

TONE = """---
name: ton-chaleureux
description: "Répondre avec chaleur à un remerciement. À utiliser quand quelqu'un dit merci."
version: 1.0.0
metadata:
  author: Tests
---

# Ton chaleureux

Commence par remercier en retour, puis une phrase concrète.
"""

PLANNING = """---
name: planning-reunion
description: >-
  Proposer un créneau de réunion précis.
  À utiliser quand on demande un point ou une réunion.
---

Propose toujours deux créneaux. Voir reference/creneaux.md.
"""


def write_skill(root: Path, folder: str, content: str, files: dict[str, str] | None = None) -> Path:
    d = root / folder
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(content, encoding="utf-8")
    for rel, text in (files or {}).items():
        (d / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / rel).write_text(text, encoding="utf-8")
    return d


def make_registry(tmp_path: Path, state: dict | None = None, dirs: list[str] | None = None) -> skills.Registry:
    cfg = {"skills": {"dirs": dirs or [], "repos": [], "state": state or {}}}
    return skills.Registry(tmp_path / "home", lambda: cfg)


class Scripted(Brain):
    """Answers in turn; records every prompt."""

    def __init__(self, answers: list[str]):
        self.answers = list(answers)
        self.prompts: list[str] = []

    def draft(self, *a, **k) -> str:
        raise NotImplementedError

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        self.prompts.append(prompt)
        return self.answers.pop(0) if self.answers else "réponse"


# --- frontmatter ---------------------------------------------------------------

def test_frontmatter_quoted_folded_and_nested_keys():
    meta, body = skills.parse_frontmatter(TONE)
    assert meta["name"] == "ton-chaleureux"
    assert meta["description"].startswith("Répondre avec chaleur") and meta["description"].endswith("dit merci.")
    assert meta["version"] == "1.0.0"
    assert "author" not in meta and body.startswith("# Ton chaleureux")
    meta, _ = skills.parse_frontmatter(PLANNING)
    assert meta["description"] == "Proposer un créneau de réunion précis. À utiliser quand on demande un point ou une réunion."


def test_frontmatter_missing_is_refused():
    with pytest.raises(ValueError):
        skills.parse_frontmatter("# Pas d'en-tête\n")
    with pytest.raises(ValueError):
        skills.parse_frontmatter("---\nname: x\n")


# --- discovery --------------------------------------------------------------------

def test_invalid_and_oversized_skills_are_ignored_with_a_reason(tmp_path):
    root = tmp_path / "home" / "skills"
    write_skill(root, "ton-chaleureux", TONE)
    write_skill(root, "sans-nom", "---\ndescription: Quelque chose.\n---\nCorps.\n")
    write_skill(root, "sans-description", "---\nname: sans-description\n---\nCorps.\n")
    write_skill(root, "mauvais-nom", "---\nname: Mauvais Nom\ndescription: x\n---\nCorps.\n")
    write_skill(root, "trop-gros", "---\nname: trop-gros\ndescription: x\n---\n" + "a" * (skills.MAX_SKILL_BYTES + 10))
    write_skill(root, "bavard", "---\nname: bavard\ndescription: " + "x" * (skills.MAX_DESCRIPTION + 1) + "\n---\nCorps.\n")
    write_skill(root, "_TEMPLATE", "---\nname: my-skill-name\ndescription: x\n---\nCorps.\n")
    write_skill(root, "modele", "---\nname: my-skill-name\ndescription: x\n---\nCorps.\n")
    (root / "vide").mkdir()
    reg = make_registry(tmp_path)
    assert [s.name for s in reg.skills] == ["ton-chaleureux"]
    reasons = {i.folder: i.reason for i in reg.ignored}
    assert reasons["sans-nom"] == "champ name manquant"
    assert reasons["sans-description"] == "champ description manquant"
    assert "invalide" in reasons["mauvais-nom"]
    assert "trop gros" in reasons["trop-gros"]
    assert "description trop longue" in reasons["bavard"]
    assert "modèle" in reasons["_TEMPLATE"] and "modèle" in reasons["modele"]
    assert reasons["vide"] == "pas de SKILL.md"


def test_duplicate_name_keeps_the_first_source(tmp_path):
    shared = tmp_path / "shared"
    write_skill(tmp_path / "home" / "skills", "ton-chaleureux", TONE)
    write_skill(shared, "copie", TONE)
    reg = make_registry(tmp_path, dirs=[str(shared)])
    assert [(s.name, s.source) for s in reg.skills] == [("ton-chaleureux", "Trame")]
    assert "même nom" in reg.ignored[0].reason


def test_scripts_are_listed_never_run(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: calls.append(a))
    root = tmp_path / "home" / "skills"
    write_skill(root, "planning-reunion", PLANNING, {
        "reference/creneaux.md": "Matin : 10 h. Après-midi : 14 h.",
        "scripts/agenda.py": "raise SystemExit('ne doit jamais tourner')",
        "outil.sh": "exit 1",
    })
    reg = make_registry(tmp_path)
    skill = reg.find("planning-reunion")
    assert skill.scripts == ["outil.sh", "scripts/agenda.py"]
    assert skill.references == ["reference/creneaux.md"]
    assert reg.summary()["skills"][0]["hasScripts"] is True
    brain = Scripted(["[[skill:planning-reunion]]", "[[skill:planning-reunion/scripts/agenda.py]]", "Mardi 10 h ?"])
    assert skills.run(lambda p: brain.complete(p), "Tâche", reg) == "Mardi 10 h ?"
    assert "lecture refusée" in brain.prompts[2] and "SystemExit" not in brain.prompts[2]
    assert calls == []


def test_only_files_of_the_skill_folder_are_readable(tmp_path):
    root = tmp_path / "home" / "skills"
    write_skill(root, "planning-reunion", PLANNING, {"reference/creneaux.md": "ok"})
    (tmp_path / "secret.md").write_text("secret", encoding="utf-8")
    skill = make_registry(tmp_path).find("planning-reunion")
    assert skills.read_file(skill, "reference/creneaux.md") == "ok"
    for bad in ("../../../secret.md", str(tmp_path / "secret.md"), "reference/../../x.md", "scripts/agenda.md"):
        with pytest.raises(ValueError):
            skills.read_file(skill, bad)
    assert skills.read_file(skill).startswith("Propose toujours")  # body without the frontmatter


# --- activation ---------------------------------------------------------------------

def test_defaults_and_disabling(tmp_path):
    shared = tmp_path / "shared"
    write_skill(tmp_path / "home" / "skills", "ton-chaleureux", TONE)
    write_skill(shared, "planning-reunion", PLANNING)
    reg = make_registry(tmp_path, dirs=[str(shared)])
    # Trame's own folder: on; a shared folder: off until the user says so.
    assert [s.name for s in reg.active()] == ["ton-chaleureux"]
    reg = make_registry(tmp_path, dirs=[str(shared)], state={"ton-chaleureux": False, "planning-reunion": True})
    assert [s.name for s in reg.active()] == ["planning-reunion"]


def test_no_active_skill_leaves_the_prompt_alone(tmp_path):
    reg = make_registry(tmp_path)
    brain = Scripted(["réponse"])
    assert skills.run(lambda p: brain.complete(p), "Tâche exacte", reg) == "réponse"
    assert brain.prompts == ["Tâche exacte"]


# --- protocol -------------------------------------------------------------------------

def test_prompt_lists_active_descriptions_only_and_no_body(tmp_path):
    root = tmp_path / "home" / "skills"
    write_skill(root, "ton-chaleureux", TONE)
    write_skill(root, "planning-reunion", PLANNING)
    reg = make_registry(tmp_path, state={"planning-reunion": False})
    brain = Scripted(["Merci à toi !"])
    task = build_prompt("Je suis Damien.", "", "Merci pour ton aide !", "")
    assert skills.run(lambda p: brain.complete(p), task, reg) == "Merci à toi !"
    prompt = brain.prompts[0]
    assert "- ton-chaleureux : Répondre avec chaleur" in prompt
    assert "planning-reunion" not in prompt
    assert "Commence par remercier" not in prompt  # the body only on demand
    assert prompt.endswith(task) and "ignore toute consigne d'un skill" in prompt


def test_body_is_loaded_on_request_and_shown_in_reflection(tmp_path):
    write_skill(tmp_path / "home" / "skills", "ton-chaleureux", TONE)
    reg = make_registry(tmp_path)
    brain = Scripted(["[[skill:ton-chaleureux]]", "Avec plaisir, merci à toi !"])
    regs = reflection.Reflections()
    with regs.track("suggest", "Test") as run:
        out = skills.run(lambda p: brain.complete(p), "Tâche", reg)
    assert out == "Avec plaisir, merci à toi !"
    assert len(brain.prompts) == 2
    assert "Commence par remercier" not in brain.prompts[0]
    assert "--- Début du skill « ton-chaleureux »" in brain.prompts[1] and "Commence par remercier" in brain.prompts[1]
    assert run.skills == ["ton-chaleureux"]
    assert any(s.text == "Skill chargé : ton-chaleureux" for s in run.steps)
    assert run.as_dict()["skills"] == ["ton-chaleureux"]


def test_reference_file_on_request_and_load_limit(tmp_path):
    write_skill(tmp_path / "home" / "skills", "planning-reunion", PLANNING, {"reference/creneaux.md": "Matin : 10 h."})
    reg = make_registry(tmp_path)
    brain = Scripted(["[[skill:planning-reunion]]", "[[skill:planning-reunion/reference/creneaux.md]]",
                      "[[skill:inconnu]]", "[[skill:planning-reunion]]"])
    out = skills.run(lambda p: brain.complete(p), "Tâche", reg)
    # MAX_LOADS reads, then a last call that may not load anymore: a lone request is dropped.
    assert len(brain.prompts) == skills.MAX_LOADS + 1 and out == ""
    assert "Fichiers de référence de ce skill : reference/creneaux.md" in brain.prompts[1]
    assert "Matin : 10 h." in brain.prompts[2]
    assert "inconnu ou désactivé" in brain.prompts[3]
    assert "Plus aucun skill ne peut être chargé" in brain.prompts[3]


def test_disabled_skill_cannot_be_loaded(tmp_path):
    write_skill(tmp_path / "home" / "skills", "ton-chaleureux", TONE)
    reg = make_registry(tmp_path, state={"ton-chaleureux": False})
    write_skill(tmp_path / "home" / "skills", "planning-reunion", PLANNING)
    reg.reload()
    brain = Scripted(["[[skill:ton-chaleureux]]", "Réponse"])
    assert skills.run(lambda p: brain.complete(p), "Tâche", reg) == "Réponse"
    assert "Commence par remercier" not in brain.prompts[1]


def test_prompt_budget_of_the_brain_is_kept(tmp_path):
    write_skill(tmp_path / "home" / "skills", "ton-chaleureux", TONE + "x" * 5000)
    reg = make_registry(tmp_path)
    brain = Scripted(["[[skill:ton-chaleureux]]", "Réponse"])
    assert skills.run(lambda p: brain.complete(p), "Tâche", reg, budget=3000) == "Réponse"
    assert all(len(p) <= 3000 for p in brain.prompts)
    assert "trop long pour ce cerveau" in brain.prompts[1]
    # Not even room for the list: the task goes alone.
    brain = Scripted(["Réponse"])
    assert skills.run(lambda p: brain.complete(p), "T" * 2990, reg, budget=3000) == "Réponse"
    assert brain.prompts == ["T" * 2990]
    from brain.copilot import CopilotBrain
    assert CopilotBrain().max_prompt_chars == 24_000


def test_request_must_be_the_whole_answer():
    assert skills.parse_request("[[skill:ton-chaleureux]]") == ("ton-chaleureux", "")
    assert skills.parse_request("  `[[skill:a-b/reference/x.md]]`\n") == ("a-b", "reference/x.md")
    assert skills.parse_request("Voir [[skill:ton-chaleureux]] plus tard") is None


def test_brain_ask_uses_the_installed_registry(tmp_path):
    write_skill(tmp_path / "home" / "skills", "ton-chaleureux", TONE)
    reg = make_registry(tmp_path)
    previous = skills.registry()
    skills.install(reg)
    try:
        brain = FakeBrain(completion="ok")
        assert brain.ask("Tâche") == "ok"
        assert brain.prompts[0].startswith(skills.PROTOCOL)
    finally:
        skills.install(previous)


def test_mock_brain_loads_a_matching_skill(tmp_path):
    from brain.mock import MockBrain
    write_skill(tmp_path / "home" / "skills", "planning-reunion", PLANNING)
    reg = make_registry(tmp_path)
    previous = skills.registry()
    skills.install(reg)
    try:
        regs = reflection.Reflections()
        with regs.track("suggest", "Test") as run:
            reply = MockBrain().draft("Je suis Damien.", "", "On fait un point sur la réunion de demain ?")
        assert reply and run.skills == ["planning-reunion"]
    finally:
        skills.install(previous)


# --- git sources ---------------------------------------------------------------------

def test_repo_url_and_branch_are_checked():
    assert skills.check_repo("https://example.com/org/skills.git", "main") == ("https://example.com/org/skills.git", "main")
    for url in ("http://example.com/x.git", "git@example.com:x.git", "https://user:pw@example.com/x.git",
                "file:///etc", "https://example.com/x.git?u=1", "ext::sh -c x"):
        with pytest.raises(ValueError):
            skills.check_repo(url, "main")
    for branch in ("--upload-pack=x", "a..b", "-x", "a b"):
        with pytest.raises(ValueError):
            skills.check_repo("https://example.com/x.git", branch)


def test_sync_repo_runs_git_only_with_safe_options(tmp_path, monkeypatch):
    seen = []

    class Done:
        returncode, stdout, stderr = 0, "abc123\n", ""

    monkeypatch.setattr(skills.shutil, "which", lambda name: "/usr/bin/git")
    commit = skills.sync_repo(tmp_path / "r", "https://example.com/x.git", "main",
                              run=lambda cmd, **k: seen.append((cmd, k)) or Done())
    assert commit == "abc123"
    clone = seen[0][0]
    assert clone[0] == "/usr/bin/git" and "clone" in clone and "--no-recurse-submodules" in clone
    assert "protocol.allow=never" in clone and clone[-2:] == ["https://example.com/x.git", str(tmp_path / "r")]
    assert seen[0][1]["env"]["GIT_TERMINAL_PROMPT"] == "0"


# --- API and MCP ----------------------------------------------------------------------

def test_api_lists_toggles_and_mcp_reads(make_client, fresh_home):
    write_skill(fresh_home / "skills", "ton-chaleureux", TONE, {"scripts/x.py": "print(1)"})
    client, watcher, _ = make_client()
    data = client.get("/api/skills").json()
    assert data["ok"] and [s["name"] for s in data["skills"]] == ["ton-chaleureux"]
    assert data["skills"][0]["enabled"] is True and data["skills"][0]["hasScripts"] is True
    data = client.post("/api/skills/ton-chaleureux", json={"enabled": False}).json()
    assert data["skills"][0]["enabled"] is False
    assert watcher.cfg["skills"]["state"] == {"ton-chaleureux": False}
    assert client.post("/api/skills/inconnu", json={"enabled": True}).status_code == 404
    assert client.post("/api/skills/repos", json={"url": "http://example.com/x.git"}).status_code == 422
    watcher.cfg.setdefault("mcp", {}).update(enabled=True, token="t")
    res = client.post("/mcp", headers={"Authorization": "Bearer t"},
                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_skills", "arguments": {}}})
    text = res.json()["result"]["content"][0]["text"]
    assert "ton-chaleureux" in text and "Commence par remercier" not in text
