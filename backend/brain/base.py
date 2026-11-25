from __future__ import annotations
from abc import ABC, abstractmethod


class Brain(ABC):
    @abstractmethod
    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "") -> str:
        """Return the reply text only, in the persona's voice. No preamble, no quotes."""


def build_prompt(soul: str, thread_summary: str, incoming: str, github_context: str) -> str:
    parts = [
        soul.strip(),
        "\nTu rédiges UNIQUEMENT la réponse à envoyer, dans la voix définie ci-dessus.",
        "Pas de préambule, pas de guillemets, juste le texte du message.",
    ]
    if thread_summary:
        parts.append(f"\nContexte du fil (derniers messages) :\n{thread_summary}")
    if github_context:
        parts.append(f"\nContexte GitHub pertinent :\n{github_context}")
    parts.append(f"\nDernier message reçu :\n{incoming}\n\nRéponse :")
    return "\n".join(parts)
