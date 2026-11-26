from __future__ import annotations
import re
from abc import ABC, abstractmethod

# A model sometimes announces its answer (« Réponse à Sébastien (pair, tutoiement) : »)
# before writing it, at times after a few lines of reasoning (« Hugo demande… Je ne peux
# pas… \n\nRéponse suggérée :\n\n… »). The label line and everything before it are not
# part of the message: the label must start its line and its colon must end it.
_LABEL_RE = re.compile(
    r"^[ \t]*(?:\*\*)?(?:voici|r[ée]ponse|reply|message|proposition|brouillon)\b[^\n]{0,120}:[ \t]*(?:\*\*)?[ \t]*\n+",
    re.IGNORECASE | re.MULTILINE,
)
_QUOTES = (("«", "»"), ('"', '"'), ("“", "”"))


def clean_reply(text: str) -> str:
    """The message alone: no reasoning, no announcing line, no quotes around the whole text."""
    out = text.strip()
    label = _LABEL_RE.search(out)
    if label and out[label.end():].strip():
        out = out[label.end():].strip()
    for left, right in _QUOTES:
        inner = out[1:-1]
        if len(out) > 1 and out.startswith(left) and out.endswith(right) and left not in inner and right not in inner:
            out = inner.strip()
    return out


class Brain(ABC):
    # Who answers, as the reflection panel names it.
    label = ""
    # Longest prompt this brain takes (None: no limit of its own).
    max_prompt_chars: int | None = None

    @abstractmethod
    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "", people_context: str = "") -> str:
        """Return the reply text only, in the persona's voice. No preamble, no quotes."""

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        """Run a free-form prompt and return the raw text answer."""
        raise RuntimeError("Ce cerveau ne sait pas traiter une demande libre.")

    def ask(self, prompt: str, timeout: float | None = None) -> str:
        """`complete`, with the active skills offered to the model: it may ask for the
        text of one before answering (skills.run). Without active skill, the same call."""
        import skills
        return skills.run(lambda p: self.complete(p, timeout), prompt, budget=self.max_prompt_chars)

    def correct(self, text: str) -> str:
        """Spelling, grammar and typography fixed; tone and wording untouched."""
        from brain.correct import build_correct_prompt, parse_correction
        return parse_correction(self.ask(build_correct_prompt(text)), text)


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
