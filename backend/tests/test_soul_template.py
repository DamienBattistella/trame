from models import Surface, WatchEntity
from soul_template import build


def _c(name, surface=Surface.dm, rank=0, **kw):
    return WatchEntity(thread_id=f"name:{name}", display_name=name, surface=surface, rank=rank, **kw)


def test_template_uses_teams_facts():
    convs = [
        _c("Damien Battistella", rank=3, is_self=True, own_preview="test"),
        _c("Projet FHIR", Surface.group, rank=1),
        _c("Chloé Julenon", rank=0, own_preview="J'ai wipe la base, je relance les imports ce soir"),
        _c("Christophe Francis", rank=2, own_preview="Sent a file"),
        _c("#prod-incidents", Surface.channel, rank=4),
    ]
    md = build(convs, None)
    assert md.startswith("# SOUL — Damien Battistella")
    assert "Sujets du moment : Projet FHIR, #prod-incidents" in md
    assert "> J'ai wipe la base, je relance les imports ce soir" in md
    assert "Sent a file" not in md and "> test" not in md
    for section in ("## Ton et style", "## Tu ou vous", "## Longueur", "## Ce que Trame doit refuser", "## Exemples"):
        assert section in md


def test_template_without_teams():
    md = build([], None)
    assert md.startswith("# SOUL\n") and "<colle ici" in md


def test_template_endpoint(make_client):
    client, _w, _d = make_client()
    r = client.get("/api/soul/template").json()
    assert r["ok"] and "## Exemples de messages écrits par moi" in r["content"]
