from __future__ import annotations
import re
import unicodedata

AUTO_MARK = "🤖"

# The tone of the reply, checked in this order (the first that matches wins): a sorry
# reply must not get a smile because it also says « merci ». Plain words of the reply
# itself, accents ignored; no match keeps the 🤖 alone.
TONES: list[tuple[str, tuple[str, ...]]] = [
    ("😔", ("desole", "desolee", "dommage", "malheureusement", "navre", "navree", "triste", "pas pu",
            "pas reussi", "impossible", "echec", "sorry", "unfortunately")),
    ("🎉", ("bravo", "felicitations", "bien joue", "chapeau", "congrats", "well done")),
    ("😊", ("merci", "super", "genial", "top", "parfait", "ravi", "ravie", "content", "contente",
            "excellent", "avec plaisir", "thanks", "great")),
    ("😎", ("pas de souci", "pas de soucis", "pas de probleme", "ca roule", "tranquille", "nickel",
            "carrement", "t'inquiete", "je gere", "no worries", "easy")),
    ("🤔", ("je regarde", "je verifie", "je me renseigne", "a voir", "je ne sais pas", "aucune idee",
            "bonne question")),
]
TONE_MARKS = tuple(mark for mark, _words in TONES)
_TONE_RES = [(mark, re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b")) for mark, words in TONES]


def _plain(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text.casefold().replace("’", "'"))
    return "".join(c for c in folded if not unicodedata.combining(c))


def tone_of(text: str) -> str:
    """The emoji matching the tone of a reply (sad, celebrating, happy, cool, thinking),
    or "" when nothing stands out."""
    plain = _plain(text)
    return next((mark for mark, pattern in _TONE_RES if pattern.search(plain)), "")


def mark_automatic(text: str) -> str:
    """Append the 🤖 marker to a reply Trame sends on its own, followed by the emoji of
    its tone (« Merci ! 🤖😊 »). Applied to the cleaned reply (clean_reply already
    stripped labels, quotes and blank edges), so the marker is the very last thing in
    the message. Never doubled when the brain already wrote a 🤖; an empty text (an
    attachment alone) gets nothing."""
    body = text.rstrip()
    if not body.strip() or AUTO_MARK in body:
        return text
    return f"{body} {AUTO_MARK}{tone_of(body)}"


def unmark(text: str) -> str:
    """The text without its trailing 🤖 marker and tone emoji (for comparing with what
    Teams shows)."""
    body = text.strip()
    for mark in TONE_MARKS:
        if body.endswith(AUTO_MARK + mark):
            body = body[: -len(mark)]
            break
    return body[: -len(AUTO_MARK)].rstrip() if body.endswith(AUTO_MARK) else body


def marks_automatic(cfg: dict) -> bool:
    """On unless the user turned it off: a config without the key keeps the marker."""
    return bool(cfg.get("safety", {}).get("mark_auto_replies", True))


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
