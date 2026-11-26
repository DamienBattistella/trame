from __future__ import annotations
import re
from typing import Iterable, Optional

from models import Surface, WatchEntity

_NOT_TEXT = re.compile(r"^(sent an? (file|image|gif|sticker|video|attachment)|a envoyé|envoyé un|photo|gif|\W*)$", re.IGNORECASE)


def _samples(convs: Iterable[WatchEntity], limit: int = 3) -> list[str]:
    out: list[str] = []
    for c in sorted(convs, key=lambda c: c.rank if c.rank is not None else 10**6):
        text = (c.own_preview or "").strip().rstrip("…").strip()
        if len(text) < 12 or _NOT_TEXT.match(text) or text in out:
            continue
        out.append(text)
        if len(out) >= limit:
            break
    return out


def build(convs: list[WatchEntity], self_name: Optional[str]) -> str:
    """SOUL.md starter filled with what Teams already tells: the user's name, the groups
    they are most active in, and a few of their own recent messages as style examples."""
    name = self_name or next((c.display_name for c in convs if c.is_self), None)
    groups = [c.display_name for c in sorted(convs, key=lambda c: c.rank if c.rank is not None else 10**6)
              if c.surface in (Surface.group, Surface.channel) and not c.is_self][:5]
    samples = _samples(convs)
    lines = [f"# SOUL — {name}" if name else "# SOUL", "", "## Qui je suis"]
    lines.append(f"- Nom : {name}" if name else "- Nom : <ton nom>")
    lines += ["- Rôle : <ton poste, ton équipe, ce dont tu t'occupes>"]
    if groups:
        lines.append(f"- Sujets du moment : {', '.join(groups)}")
    lines += [
        "", "## Ton et style",
        "- Direct et cordial, sans formules toutes faites.",
        "- Une idée par message ; je vais droit au but.",
        "", "## Tu ou vous",
        "- Je tutoie mon équipe et mes collègues proches.",
        "- Je vouvoie les clients, la direction et les personnes que je ne connais pas.",
        "", "## Longueur",
        "- Une à trois phrases, sauf pour une question technique détaillée.",
        "", "## Ce que Trame doit refuser",
        "- Jamais d'engagement de date, de budget ou de priorité à ma place.",
        "- Rien sur les RH, les salaires ou le confidentiel : laisser en brouillon.",
        "- Ne pas inventer d'information technique : dire que je vérifie.",
        "", "## Exemples de messages écrits par moi",
    ]
    if samples:
        lines += [f"> {s}" for s in samples]
    else:
        lines += ["> <colle ici 2 ou 3 messages que tu as vraiment écrits>"]
    return "\n".join(lines) + "\n"
