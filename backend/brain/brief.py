from __future__ import annotations
import json
import re

from pydantic import BaseModel, Field, ValidationError, field_validator

MAX_QUERIES = 5


class BriefParseError(ValueError):
    """The brain answered, but not with a usable brief."""


class BriefDigest(BaseModel):
    summary: str = Field(min_length=1)
    open_points: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    search_queries: list[str] = Field(default_factory=list)

    @field_validator("summary")
    @classmethod
    def _summary(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("résumé vide")
        return v

    @field_validator("open_points", "topics")
    @classmethod
    def _items(cls, v: list[str]) -> list[str]:
        return [s.strip() for s in v if s.strip()][:10]

    @field_validator("search_queries")
    @classmethod
    def _queries(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for q in v:
            q = " ".join(q.split())[:80]
            if q and q.lower() not in {x.lower() for x in out}:
                out.append(q)
        return out[:MAX_QUERIES]


def build_brief_prompt(display_name: str, transcript: str) -> str:
    return "\n".join([
        "Tu analyses une conversation Microsoft Teams pour en faire une synthèse.",
        f"Conversation : {display_name}",
        "",
        "Réponds UNIQUEMENT avec un objet JSON, sans texte autour, de la forme :",
        '{"summary": "...", "open_points": ["..."], "topics": ["..."], "search_queries": ["..."]}',
        "",
        "- summary : résumé de la discussion en français, 6 phrases au plus.",
        "- open_points : questions ou actions encore ouvertes, en français.",
        "- topics : sujets techniques ou métier abordés (mots-clés courts).",
        "- search_queries : 0 à 5 requêtes courtes (2 à 5 mots-clés) pour retrouver dans GitHub "
        "les PR, issues ou commits liés. Liste vide si la conversation ne parle pas de code.",
        "",
        "Conversation (du plus ancien au plus récent) :",
        transcript,
    ])


def parse_brief(raw: str) -> BriefDigest:
    """Extract and validate the first JSON object of a brain answer (code fences tolerated)."""
    text = re.sub(r"```(?:json)?", "", raw or "", flags=re.IGNORECASE)
    decoder = json.JSONDecoder()
    found = False
    for match in re.finditer(r"\{", text):
        try:
            obj, _end = decoder.raw_decode(text, match.start())
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        found = True
        try:
            return BriefDigest.model_validate(obj)
        except ValidationError:
            continue
    if found:
        raise BriefParseError("la réponse du cerveau ne contient pas les champs attendus")
    raise BriefParseError("la réponse du cerveau n'est pas du JSON exploitable")
