from drivers.rail_label import parse
from models import Surface


def test_dm_with_presence_and_preview():
    r = parse("Chat Bertrand GAUTHIER Offline Last message voir ça demain 25/11")
    assert (r.name, r.surface, r.unread, r.is_self) == ("Bertrand GAUTHIER", Surface.dm, False, False)
    assert r.preview == "voir ça demain" and r.preview_sender == "Bertrand GAUTHIER"


def test_pinned_and_presence_variants():
    assert parse("Chat Celine Leleux Has pinned messages Offline Last message ok").name == "Celine Leleux"
    assert parse("Chat Céline Meignant Away Last message voir le doc").name == "Céline Meignant"
    assert parse("Chat Chloé Julenon Away Last message You: J'arrive 09:12").preview_sender == "You"


def test_self_chat():
    r = parse("Chat Damien Battistella (You) You: test 04:49")
    assert r.name == "Damien Battistella" and r.is_self


def test_group_and_unread():
    r = parse("Group chat Projet FHIR Passerelle Unread Last message Lucas Bernard: on fait un point ? 10:02")
    assert r.name == "Projet FHIR Passerelle" and r.surface == Surface.group and r.unread
    assert r.preview_sender == "Lucas Bernard" and r.preview == "on fait un point ?"


def test_meeting_and_french():
    assert parse("Meeting chat Suivi opérationnel - E4M H10 Last message Tout est fini").surface == Surface.group
    r = parse("Conversation Romain CUREAU Absent Dernier message je vais préparer ça 25/11")
    assert r.name == "Romain CUREAU" and r.preview == "je vais préparer ça"


def test_plain_name_untouched():
    assert parse("Amélie Durand").name == "Amélie Durand"


def test_last_time():
    assert parse("Chat Bertrand GAUTHIER Offline Last message voir ça demain 25/11").last_time == "25/11"
    assert parse("Chat Damien Battistella (You) You: test 04:49").last_time == "04:49"
    assert parse("Chat Anne Away Last message ok Yesterday").last_time == "Hier"
    assert parse("Amélie Durand").last_time is None
