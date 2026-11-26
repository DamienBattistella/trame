from __future__ import annotations
import json
import re
import shutil
import unicodedata
from typing import Iterable, Optional

from pydantic import BaseModel, Field, ValidationError

import config as cfgmod

FILENAME = "ENTOURAGE.json"
MAX_BYTES = 512 * 1024
MAX_IN_PROMPT = 8


class Person(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    aliases: list[str] = Field(default_factory=list, max_length=10)
    email: Optional[str] = Field(default=None, max_length=200)
    role: Optional[str] = Field(default=None, max_length=120)
    team: Optional[str] = Field(default=None, max_length=120)
    manager: Optional[str] = Field(default=None, max_length=120)
    relation: Optional[str] = Field(default=None, max_length=80)
    tone: Optional[str] = Field(default=None, max_length=200)
    note: Optional[str] = Field(default=None, max_length=300)


class PeopleFile(BaseModel):
    version: int = 1
    source: Optional[str] = Field(default=None, max_length=80)
    generated_at: Optional[str] = Field(default=None, max_length=40)
    people: list[Person] = Field(default_factory=list, max_length=5000)


class PeopleSummary(BaseModel):
    loaded: bool
    count: int = 0
    source: Optional[str] = None
    generated_at: Optional[str] = None


def _key(name: str) -> str:
    text = unicodedata.normalize("NFD", name or "")
    text = "".join(c for c in text if unicodedata.category(c) != "Mn").casefold()
    text = re.sub(r"\(.*?\)", " ", text)
    return " ".join(re.findall(r"[a-z0-9]+", text))


def _keys(name: str) -> set[str]:
    """A name matches whatever the word order ("Lucas Bernard" / "BERNARD Lucas")."""
    k = _key(name)
    return {k, " ".join(sorted(k.split()))} if k else set()


class Directory:
    """Who's who at work (exported from Orbite as ENTOURAGE.json). Only used to tell
    the brain who it is answering; never sent anywhere else."""

    def __init__(self, data: Optional[PeopleFile] = None):
        self.data = data
        self._index: dict[str, Person] = {}
        for p in data.people if data else []:
            for alias in [p.name, *p.aliases, (p.email or "").split("@")[0].replace(".", " ")]:
                for k in _keys(alias):
                    self._index.setdefault(k, p)

    @staticmethod
    def parse(content: str) -> PeopleFile:
        try:
            raw = json.loads(content)
        except ValueError as e:
            raise ValueError(f"Fichier illisible : JSON invalide ({e.msg}, ligne {e.lineno}).")
        try:
            return PeopleFile.model_validate(raw)
        except ValidationError as e:
            first = e.errors()[0]
            where = ".".join(str(x) for x in first.get("loc", ()))
            raise ValueError(f"Fichier non conforme : {where} : {first.get('msg', '')}.")

    @classmethod
    def load(cls) -> "Directory":
        path = cfgmod.HOME / FILENAME
        try:
            return cls(cls.parse(path.read_text(encoding="utf-8")))
        except Exception:
            return cls()

    def summary(self) -> PeopleSummary:
        if not self.data:
            return PeopleSummary(loaded=False)
        return PeopleSummary(loaded=True, count=len(self.data.people), source=self.data.source,
                             generated_at=self.data.generated_at)

    def find(self, name: str) -> Optional[Person]:
        for k in _keys(name):
            if k in self._index:
                return self._index[k]
        return None

    def search(self, query: str, limit: int = 8) -> list[Person]:
        """People whose name or alias starts with every word typed ("luc ber", "bernard"),
        names before aliases, then those whose role or team words start the same way."""
        words = _key(query).split()
        if not words or not self.data:
            return []

        def by_words(text: str) -> bool:
            tokens = _key(text).split()
            return all(any(t.startswith(w) for t in tokens) for w in words)

        joined = " ".join(words)
        ranked: list[tuple[int, str, Person]] = []
        for p in self.data.people:
            if by_words(p.name):
                rank = 0 if _key(p.name).startswith(joined) else 1
            elif any(by_words(a) for a in p.aliases):
                rank = 2
            elif any(by_words(x or "") for x in (p.role, p.team)):
                rank = 3
            else:
                continue
            ranked.append((rank, _key(p.name), p))
        ranked.sort(key=lambda r: (r[0], r[1]))
        return [p for _, _, p in ranked[:limit]]

    @staticmethod
    def label(p: Person) -> str:
        """Short line under a name in the UI: « Développeur interop · Hexagone »."""
        return " · ".join(x for x in (p.role, p.team) if x)

    @staticmethod
    def card(p: Person) -> str:
        bits = [x for x in (p.role, p.team and f"équipe {p.team}", p.manager and f"rattaché à {p.manager}",
                            p.relation) if x]
        line = f"- {p.name}" + (f" : {', '.join(bits)}" if bits else "")
        if p.tone:
            line += f". Ton : {p.tone}"
        if p.note:
            line += f". Note : {p.note}"
        return line

    def context(self, names: Iterable[str]) -> str:
        seen: list[Person] = []
        for n in names:
            p = self.find(n)
            if p and p not in seen:
                seen.append(p)
            if len(seen) >= MAX_IN_PROMPT:
                break
        return "\n".join(self.card(p) for p in seen)


def save(content: str) -> Directory:
    data = Directory.parse(content)
    path = cfgmod.HOME / FILENAME
    cfgmod.HOME.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)
    return Directory(data)


def restore_default() -> Directory:
    """Back to the org chart shipped with the app, or to no entourage if none is."""
    source, target = cfgmod.BUNDLE / FILENAME, cfgmod.HOME / FILENAME
    if not source.exists():
        return remove()
    if source.resolve() != target.resolve():
        shutil.copyfile(source, target)
    return Directory.load()


def remove() -> Directory:
    try:
        (cfgmod.HOME / FILENAME).unlink()
    except FileNotFoundError:
        pass
    return Directory()
