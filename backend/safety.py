from __future__ import annotations


def blocked_by_filter(text: str, needles: list[str]) -> bool:
    low = text.lower()
    return any(n.lower() in low for n in needles)


def should_react(surface: str, mentions: list[str], named_people: list[str], triggers: dict) -> bool:
    """1:1 = every message. Group/channel = only on @mention of the user or a named person."""
    rule = triggers.get(surface, "mention_or_named")
    if rule == "every_message":
        return True
    if rule == "mention_or_named":
        if any("damien" in m.lower() for m in mentions):
            return True
        return any(p in mentions or p in named_people for p in named_people)
    return False
