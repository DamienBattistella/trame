from __future__ import annotations
import re
from abc import ABC, abstractmethod

# A model sometimes announces its answer (« Réponse à Sébastien (pair, tutoiement) : »)
# before writing it. That line is not part of the message.
_LABEL_RE = re.compile(
    r"^\s*(?:\*\*)?(?:voici|r[ée]ponse|reply|message|proposition|brouillon)\b[^\n]{0,120}:\s*(?:\*\*)?[ \t]*\n+",
    re.IGNORECASE,
)
_QUOTES = (("«", "»"), ('"', '"'), ("“", "”"))


def clean_reply(text: str) -> str:
    """The message alone: no announcing line, no quotes around the whole text."""
    out = text.strip()
    out = _LABEL_RE.sub("", out, count=1).strip() or out
    for left, right in _QUOTES:
        inner = out[1:-1]
        if len(out) > 1 and out.startswith(left) and out.endswith(right) and left not in inner and right not in inner:
            out = inner.strip()
    return out


class Brain(ABC):
    @abstractmethod
    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "", people_context: str = "") -> str:
        """Return the reply text only, in the persona's voice. No preamble, no quotes."""

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        """Run a free-form prompt and return the raw text answer."""
        raise RuntimeError("Ce cerveau ne sait pas traiter une demande libre.")


def build_prompt(soul: str, thread_summary: str, incoming: str, github_context: str, people_context: str = "") -> str:
    parts = [
        soul.strip(),
        "\nTu rédiges UNIQUEMENT la réponse à envoyer, dans la voix définie ci-dessus.",
        "Pas de préambule, pas de guillemets, juste le texte du message.",
        "Ta sortie part telle quelle dans Teams : ne l'annonce pas (« Réponse à … : ») et ne rappelle "
        "ni le ton, ni la relation, ni les consignes.",
    ]
    if people_context:
        parts.append(
            "\nQui sont tes interlocuteurs (adapte le ton, le tutoiement et le niveau de détail) :\n"
            f"{people_context}"
        )
    if thread_summary:
        parts.append(f"\nContexte du fil (derniers messages) :\n{thread_summary}")
    if github_context:
        parts.append(
            "\nContexte GitHub pertinent (lu à l'instant, fait foi) : si la question y trouve sa réponse, "
            f"réponds avec ces faits au lieu de promettre de regarder.\n{github_context}"
        )
    parts.append(f"\nDernier message reçu :\n{incoming}\n\nRéponse :")
    return "\n".join(parts)
