"""Catalogue d'emoji de Trame : tout Unicode (emojibase-data), avec la clé de réaction Teams.

Sources :
- emojibase-data (devDependency) : chaque emoji Unicode, son groupe, sa version, ses teintes de
  peau, son nom et ses mots-clés en français (CLDR).
- le catalogue d'émoticônes de Teams, servi en JSON public par son CDN : pour chaque émoticône,
  sa clé (« launch », « 1f4af_hundredpointssymbol »…), son caractère Unicode, sa description et
  ses mots-clés en français, et si elle prend une teinte de peau (« yes-tone1 »). Son adresse
  porte une empreinte qui change avec les versions du client Teams : on la retrouve dans le cache
  de Teams (URL « personal-expressions/v1/metadata/<empreinte>/fr-fr.json »).

Un emoji sans clé Teams (drapeaux, familles, emoji les plus récents) reste insérable dans un
message mais pas comme réaction : Teams ne l'accepte pas.

    python scripts/teams-emoji-keys.py   (depuis ui/, après npm ci)

Écrit src/data/emoji.json : [groupe, emoji, nom, mots-clés, clé Teams, version, clé Teams à
teinte, teintes 1 à 5] par emoji.
"""
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "node_modules" / "emojibase-data"
OUT = ROOT / "src" / "data" / "emoji.json"
TEAMS_CATALOG = "https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v1/metadata/{}/fr-fr.json"
# Les réactions rapides de Teams (REACTIONS dans backend/models.py).
QUICK = {"like", "heart", "laugh", "surprised", "sad", "angry"}
TEAMS_HASH = sys.argv[1] if len(sys.argv) > 1 else "ec4576179210cde40ce5494513213583"


def bare(emoji: str) -> str:
    return emoji.replace(chr(0xFE0F), "")


def words(*parts) -> str:
    seen: dict[str, None] = {}
    for p in parts:
        for w in (p if isinstance(p, list) else [p]):
            w = (w or "").strip().lower()
            if w:
                seen.setdefault(w, None)
    return " ".join(seen)


def main() -> None:
    with urllib.request.urlopen(TEAMS_CATALOG.format(TEAMS_HASH), timeout=60) as r:
        catalog = [e for c in json.load(r)["categories"] for e in c["emoticons"] if e.get("unicode")]
    # Plusieurs clés pour un même emoji (« like » et « yes » pour 👍, « hi » et
    # « 1f44b_wavinghand » pour 👋) : la réaction rapide de Teams d'abord, sinon la première du
    # catalogue ; avec une teinte de peau, la première qui en prend une (« yes-tone1 »).
    teams: dict[str, dict] = {}
    toned: dict[str, str] = {}
    for e in catalog:
        u = bare(e["unicode"])
        if u not in teams or (e["id"] in QUICK and teams[u]["id"] not in QUICK):
            teams[u] = e
        if e.get("diverse"):
            toned.setdefault(u, e["id"])
    fr = json.loads((DATA / "fr" / "data.json").read_text(encoding="utf-8"))
    groups_fr = {g["order"]: g["message"] for g in json.loads((DATA / "fr" / "messages.json").read_text(encoding="utf-8"))["groups"]}
    shown = [g for g in sorted(groups_fr) if g != 2]  # 2 : composants (teintes seules), pas des emoji
    rows = []
    for e in sorted((e for e in fr if e.get("group") in shown), key=lambda e: e["order"]):
        t = teams.get(bare(e["emoji"]), {})
        row = [shown.index(e["group"]), e["emoji"], e["label"], words(e.get("tags", []), t.get("description", ""), t.get("keywords", [])),
               t.get("id", ""), e["version"], toned.get(bare(e["emoji"]), "")]
        if e.get("skins"):
            tones = sorted(e["skins"], key=lambda s: s["tone"] if isinstance(s["tone"], int) else 99)
            row.append([s["emoji"] for s in tones if isinstance(s["tone"], int)][:5])
        rows.append(row)
    groups = [groups_fr[g][:1].upper() + groups_fr[g][1:] for g in shown]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        '{\n"groups": ' + json.dumps(groups, ensure_ascii=False) + ',\n"emoji": [\n'
        + ",\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n]\n}\n",
        encoding="utf-8",
    )
    keyed = sum(1 for r in rows if r[4])
    print(f"{len(rows)} emoji, {keyed} avec une clé de réaction Teams, {len(teams)} au catalogue Teams -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
