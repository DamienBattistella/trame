from __future__ import annotations
import pytest

import safety

TRIGGERS = {"dm": "every_message", "group": "mention_or_named", "channel": "mention_or_named"}
SELF = ["Damien", "Damien Battistella"]


@pytest.mark.parametrize(
    "surface,mentions,named,expected",
    [
        ("dm", [], [], True),
        ("group", [], [], False),
        ("group", ["Damien"], [], True),
        ("group", ["damien battistella"], [], True),
        ("channel", ["Sofia Marino"], ["Sofia Marino"], True),
        ("channel", ["Lucas Bernard"], ["Sofia Marino"], False),
        ("unknown", ["Damien"], [], True),
    ],
)
def test_should_react(surface, mentions, named, expected):
    assert safety.should_react(surface, mentions, named, TRIGGERS, SELF) is expected


def test_should_react_unknown_rule():
    assert safety.should_react("dm", [], [], {"dm": "never"}, SELF) is False


def test_blocked_by_filter_case_insensitive():
    assert safety.blocked_by_filter("C'est CONFIDENTIEL", ["confidentiel"])
    assert not safety.blocked_by_filter("Tout va bien", ["confidentiel"])
