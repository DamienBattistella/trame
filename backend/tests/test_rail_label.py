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


def test_teams_v2_calibration():
    from drivers.rail_label import is_structural, stable_id, title_conversation, same_name
    assert title_conversation("Chat | Romain CUREAU | Microsoft Teams") == "Romain CUREAU"
    assert title_conversation("Chat | Projet | FHIR | Microsoft Teams") == "Projet | FHIR"
    assert title_conversation("Chat | Damien Battistella (You) | Microsoft Teams") == "Damien Battistella"
    assert title_conversation("Microsoft Teams") is None and title_conversation("Chat | Microsoft Teams") is None
    assert stable_id("menurmh") is None and stable_id("") is None
    assert stable_id("chat-list-item_19:abc@thread.v2") == "19:abc@thread.v2"
    for name in ("Copilot", "Quick views", "Mentions", "Drafts", "Saved", "Favorites", "Favoris"):
        assert is_structural(name)
    assert is_structural("Hexagone", "expanded=true;level=1")
    assert not is_structural("Foundation 🧱", "expanded=false;level=2;selected=false")
    assert same_name("Romain  CUREAU", "romain cureau")
    # Comme le pont (norm) : sans accents. Teams affiche « Sébastien », on tape « Sebastien ».
    assert same_name("Sébastien Hug De Larauze", "Sebastien  Hug de larauze")
    assert same_name("Élodie Faure", "elodie faure")
    assert not same_name("Sébastien Hug", "Sébastien Tan")


def test_french_self_preview_is_own():
    r = parse("Conversation Romain CUREAU Absent Dernier message Vous : je regarde 10:02")
    assert r.preview_sender == "You" and r.preview == "je regarde"
    r = parse("Chat Chloé Julenon Away Last message You: J'arrive 09:12")
    assert r.preview_sender == "You"


def test_teams_web_label_without_prefix_or_marker():
    r = parse("Romain CUREAU 25/11 je vais préparer ça")
    assert (r.name, r.last_time, r.preview, r.preview_sender) == ("Romain CUREAU", "25/11", "je vais préparer ça", "Romain CUREAU")
    r = parse("Hexagone 10 - Developers 24/11 Chloé: merci je regarde ça")
    assert (r.name, r.preview_sender, r.preview) == ("Hexagone 10 - Developers", "Chloé", "merci je regarde ça")
    r = parse("Hugo Lannes 25/11")
    assert (r.name, r.last_time, r.preview) == ("Hugo Lannes", "25/11", None)
    assert parse("Romain CUREAU 10:41 Vous : je regarde").preview_sender == "You"
    assert parse("Damien Battistella (You) Hier note").is_self
    r = parse("Non lu Sébastien Hug De Larauze 09:49 nouvelle config")
    assert (r.name, r.unread, r.preview) == ("Sébastien Hug De Larauze", True, "nouvelle config")
    assert not parse("Romain CUREAU 25/11 je vais préparer ça").unread
    from drivers.rail_label import is_structural
    assert is_structural("Enregistré")
    assert is_structural("3 3") and is_structural("99+")
    assert not is_structural("Hexagone 10") and not is_structural("DX")
