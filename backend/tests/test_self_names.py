from models import Surface, WatchEntity


def _self_chat(name):
    return WatchEntity(thread_id=f"name:{name}", display_name=name, surface=Surface.dm, is_self=True)


def _names(watcher, value):
    watcher.cfg["triggers"] = {**watcher.cfg.get("triggers", {}), "self_names": value}


def test_shipped_config_names_nobody():
    import json
    import config as cfgmod
    cfg = json.loads((cfgmod.BUNDLE / "config.json").read_text(encoding="utf-8"))
    assert cfg["triggers"]["self_names"] == []


def test_empty_self_names_learn_the_teams_name(make_client):
    _client, watcher, _driver = make_client()
    _names(watcher, [])
    watcher._learn_self_name([_self_chat("Romain Courtois")])
    assert watcher._self_names() == ["Romain Courtois", "Romain"]
    import config as cfgmod
    assert cfgmod.load()["triggers"]["self_names"] == ["Romain Courtois", "Romain"]


def test_former_shipped_names_follow_the_real_user(make_client):
    _client, watcher, _driver = make_client()
    _names(watcher, ["Damien", "Damien Battistella"])
    watcher._learn_self_name([_self_chat("Romain Courtois")])
    assert watcher._self_names() == ["Romain Courtois", "Romain"]


def test_former_shipped_names_kept_for_their_owner(make_client):
    _client, watcher, _driver = make_client()
    _names(watcher, ["Damien", "Damien Battistella"])
    watcher._learn_self_name([_self_chat("Damien Battistella")])
    assert watcher._self_names() == ["Damien", "Damien Battistella"]


def test_names_set_by_the_user_are_never_replaced(make_client):
    _client, watcher, _driver = make_client()
    _names(watcher, ["Rom", "Romain C."])
    watcher._learn_self_name([_self_chat("Romain Courtois")])
    assert watcher._self_names() == ["Rom", "Romain C."]


def test_no_self_chat_changes_nothing(make_client):
    _client, watcher, _driver = make_client()
    _names(watcher, [])
    watcher._learn_self_name([WatchEntity(thread_id="19:x", display_name="Sofia Marino", surface=Surface.dm)])
    assert watcher._self_names() == []


def _notes_chat():
    # La conversation avec soi-même ajoutée depuis le service de chat : libellé de Trame.
    return WatchEntity(thread_id="48:notes", display_name="Mes notes", surface=Surface.dm, is_self=True)


def test_the_notes_label_is_never_learned_as_a_name(make_client):
    _client, watcher, _driver = make_client()
    _names(watcher, [])
    watcher._learn_self_name([_notes_chat()])
    assert watcher._self_names() == []
    _names(watcher, ["Damien", "Damien Battistella"])
    watcher._learn_self_name([_notes_chat()])
    assert watcher._self_names() == ["Damien", "Damien Battistella"]


def test_the_notes_label_learned_by_mistake_is_repaired_by_the_real_name(make_client):
    from models import IncomingMessage
    _client, watcher, _driver = make_client()
    _names(watcher, ["Mes notes", "Mes"])
    # Un message que le service de chat dit écrit par l'utilisateur (from_me) le nomme.
    other = IncomingMessage(thread_id="48:notes", sender="Sofia Marino", text="a", received_at="", surface=Surface.dm, from_me=False)
    mine = IncomingMessage(thread_id="48:notes", sender="Romain Courtois", text="b", received_at="", surface=Surface.dm, from_me=True)
    watcher._learn_self_from([other, mine])
    assert watcher._self_names() == ["Romain Courtois", "Romain"]


def test_a_from_me_message_never_replaces_names_set_by_the_user(make_client):
    from models import IncomingMessage
    _client, watcher, _driver = make_client()
    _names(watcher, ["Rom"])
    watcher._learn_self_from([IncomingMessage(thread_id="48:notes", sender="Romain Courtois", text="b", received_at="", surface=Surface.dm, from_me=True)])
    assert watcher._self_names() == ["Rom"]


def test_from_me_decides_who_wrote_a_message(make_client):
    _client, watcher, _driver = make_client()
    _names(watcher, ["Mes notes", "Mes"])
    assert watcher._is_mine("Romain Courtois", True)
    assert not watcher._is_mine("Mes notes", False)
    assert not watcher._is_mine("Romain Courtois")
