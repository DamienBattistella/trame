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
