"""A Teams status message proposed by the brain, in the user's voice. Only a proposal:
it fills the field in Trame and goes to Teams only when the user confirms it."""
from __future__ import annotations

import random
import re
from datetime import datetime

# A different angle each time, so two clicks do not give the same kind of message.
ANGLES = (
    "concentré sur une tâche, joignable pour l'urgent",
    "une touche d'humour sur le métier de développeur",
    "ce que tu fais en ce moment, dit simplement",
    "quand on peut te joindre et comment",
    "un clin d'œil au jour de la semaine",
    "une formule courte et sobre",
    "une petite phrase motivante, sans être niaise",
)

# Used when the brain cannot answer: short, neutral, in French.
FALLBACK = (
    "🎧 Concentré, je réponds dès que possible",
    "☕ Pause rapide, je reviens vite",
    "🛠️ En plein dans le code, l'urgent passe toujours",
    "📅 En réunion une bonne partie de la journée",
    "🚀 On avance bien aujourd'hui",
    "💬 Disponible pour un échange rapide",
    "🧠 Moment de réflexion, écris-moi, je lis tout",
)

MARKER = "Propose UN message de statut Teams."


def build_status_prompt(soul: str, presence: str, previous: str, now: datetime | None = None,
                        angle: str | None = None) -> str:
    now = now or datetime.now()
    angle = angle or random.choice(ANGLES)
    days = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    parts = [
        MARKER,
        "Écris-le comme la personne décrite ci-dessous l'écrirait (son ton, sa langue, tu ou vous).",
        f"Statut affiché dans Teams : {presence or 'inconnu'}.",
        f"Moment : {days[now.weekday()]} {now:%H:%M}.",
        f"Angle à prendre cette fois : {angle}.",
        "Contraintes : une seule ligne, 80 caractères au plus, au plus un émoji (au début si tu en mets un), "
        "aucune information confidentielle, aucune promesse de date, pas de guillemets.",
    ]
    if previous.strip():
        parts.append(f"Message actuel, à ne pas répéter : {previous.strip()}")
    parts += ["", "Qui je suis :", soul.strip() or "(non renseigné)", "",
              "Réponds uniquement par le message, sans phrase d'introduction."]
    return "\n".join(parts)


def parse_status_note(raw: str, limit: int = 280) -> str:
    """The first meaningful line, without quotes, labels or markdown; empty if nothing."""
    for line in (raw or "").splitlines():
        text = line.strip().strip("*_`").strip()
        text = re.sub(r"^(message( de statut)?|statut|proposition)\s*:\s*", "", text, flags=re.IGNORECASE)
        text = text.strip().strip("*_`").strip().strip("«»\"'“”").strip()
        if text:
            return " ".join(text.split())[:limit]
    return ""
