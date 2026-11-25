from __future__ import annotations


def blocked_by_filter(text: str, needles: list[str]) -> bool:
    low = text.lower()
    return any(n.lower() in low for n in needles)


def should_react(
    surface: str,
    mentions: list[str],
    named_people: list[str],
    triggers: dict,
    self_names: list[str],
) -> bool:
    """1:1 = every message. Group/channel = only when the user (self_names) or a
    named person is mentioned."""
    rule = triggers.get(surface, "mention_or_named")
    if rule == "every_message":
        return True
    if rule == "mention_or_named":
        low = [m.lower() for m in mentions]
        if any(any(s.lower() in m for m in low) for s in self_names):
            return True
        return any(p in mentions for p in named_people)
    return False
