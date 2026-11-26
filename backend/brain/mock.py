from __future__ import annotations
import json
import os
import re
import time

import reflection

from brain.base import Brain
from brain.correct import mock_correct


class MockBrain(Brain):
    """Deterministic offline brain (TRAME_BRAIN=mock): no CLI call, no subscription used."""

    label = "Cerveau hors ligne"
    model = "simulé"

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "", people_context: str = "") -> str:
        _think(
            f"Le dernier message dit : « {_short(incoming)} ». "
            + ("Le fil donne le contexte des échanges précédents, je m'appuie dessus. " if thread_summary else "")
            + ("Je connais mes interlocuteurs grâce à l'entourage : j'adapte le tutoiement. " if people_context else "")
            + "La voix du persona est courte et directe : une ou deux phrases, un engagement concret, pas de formule creuse."
        )
        low = incoming.lower()
        if "#" in incoming or "pr" in low.split():
            return "Je regarde la PR dans la matinée et je te fais un retour en commentaire."
        if "build" in low or "ci" in low.split():
            return "Oui, le build passe chez moi depuis le dernier correctif. Je surveille la CI."
        if "démo" in low or "point" in low or "créneau" in low:
            return "Ça me va, je bloque le créneau. Je prépare les échanges de test pour la démo."
        if "latence" in low:
            return "Je regarde les traces du connecteur et je reviens vers vous rapidement."
        return "Bien reçu, je regarde et je te reviens vite."

    def correct(self, text: str) -> str:
        _think(
            f"Je relis « {_short(text)} » pour l'orthographe, les accords et la typographie française. "
            "Je garde le ton, les mentions, les liens et les emoji tels quels, je ne réécris rien."
        )
        return mock_correct(text)

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        from brain.status_note import MARKER
        if MARKER in prompt:
            # Démo : un message différent selon l'angle demandé.
            angle = next((l.split(":", 1)[1].strip() for l in prompt.splitlines() if l.startswith("Angle à prendre")), "")
            return f"🎧 {angle[:1].upper()}{angle[1:60]}" if angle else "🎧 Concentré, je réponds dès que possible"
        if "Message à vérifier :" in prompt:
            _think(
                "Je relève les heures, les jours et les numéros cités dans le message, puis je cherche dans le fil "
                "qui les a donnés et quand. Une valeur différente dans le fil est une contradiction, avec sa source."
            )
            return _fact_check(prompt)
        marker = "Conversation (du plus ancien au plus récent) :"
        transcript = prompt.split(marker, 1)[1] if marker in prompt else prompt
        low = transcript.lower()
        numbers = sorted(set(re.findall(r"#(\d+)", transcript)), key=int)
        summary: list[str] = []
        open_points: list[str] = []
        topics: list[str] = []
        queries: list[str] = []
        if "obx" in low:
            ref = f" (PR #{numbers[0]})" if numbers else ""
            summary.append(f"La discussion porte sur le mapping HL7 des segments OBX{ref}.")
            topics += ["HL7 v2", "segment OBX"]
            queries.append("mapping HL7 OBX")
            if "obx-2" in low:
                summary.append("Le point dur est le typage de OBX-2 qui doit suivre la valeur réellement transmise dans OBX-5.")
                open_points.append("Valider la règle de typage OBX-2 (NM, ST, CE) avant fusion.")
                topics.append("typage OBX-2")
                queries.append("OBX-2 type valeur")
        if "démo" in low or "interop" in low:
            summary.append("Une démonstration interopérabilité est prévue et le créneau reste à confirmer.")
            open_points.append("Confirmer le créneau et le jeu de messages de la démo interop.")
            topics.append("démo interop")
            queries.append("démo interop")
        if "build" in low or "ci" in low.split() or "pipeline" in low:
            summary.append("Le build et la CI ont été vérifiés après le dernier correctif.")
            if "runner" in low:
                open_points.append("Épingler la version de l'image du runner CI.")
            topics.append("build / CI")
            queries.append("build CI échec")
        if "latence" in low:
            summary.append("Une alerte de latence sur le connecteur HL7 est en cours d'analyse.")
            if "pool" in low:
                summary.append("La taille du pool de connexions MLLP a été augmentée pour résorber la file.")
            open_points.append("Identifier la cause de la latence du connecteur HL7 et décider d'un correctif.")
            topics.append("latence connecteur HL7")
            queries.append("latence connecteur HL7")
        if not summary:
            summary.append("Échange courant sans sujet technique particulier.")
        payload = {
            "summary": " ".join(summary[:6]),
            "open_points": open_points,
            "topics": list(dict.fromkeys(topics)),
            "search_queries": list(dict.fromkeys(queries))[:5],
        }
        return "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"


def _short(text: str, n: int = 70) -> str:
    one = " ".join(text.split())
    return one if len(one) <= n else one[:n].rstrip() + "…"


def _think(text: str) -> None:
    """Offline reasoning, streamed a few words at a time when an action is followed in
    the reflection panel (TRAME_MOCK_THINK_DELAY seconds between pieces)."""
    if not reflection.active():
        return
    delay = float(os.environ.get("TRAME_MOCK_THINK_DELAY", "0.06"))
    words = text.split(" ")
    for i in range(0, len(words), 3):
        reflection.check_cancelled()
        reflection.thinking(" ".join(words[i:i + 3]) + (" " if i + 3 < len(words) else ""))
        if delay:
            time.sleep(delay)
    reflection.check_cancelled()


_HOUR = re.compile(r"\b\d{1,2} ?h ?(?:\d{2})?\b", re.IGNORECASE)
_DAY = re.compile(r"\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b", re.IGNORECASE)
_NUM = re.compile(r"#\d+")
_LINE = re.compile(r"^\[([^\]]*)\] ([^:]+): (.*)$")


def _fact_check(prompt: str) -> str:
    """Compares hours, weekdays and #numbers of the message with the thread: enough to
    show every state of the check offline (contradicted with a fix, confirmed)."""
    message = prompt.rsplit("<<<\n", 1)[-1].rsplit("\n>>>", 1)[0]
    thread = prompt.split("Fil de la conversation (du plus ancien au plus récent) :\n", 1)[-1].split("\n\n", 1)[0]
    lines = []
    for raw in thread.splitlines():
        m = _LINE.match(raw)
        lines.append((m.group(1), m.group(2), m.group(3)) if m else ("", "", raw))
    claims: list[dict] = []
    for pattern, norm in ((_HOUR, lambda t: t.lower().replace(" ", "")), (_DAY, str.lower), (_NUM, str)):
        said = [(at, who, text, x.group(0)) for at, who, text in lines for x in pattern.finditer(text)]
        for found in pattern.finditer(message):
            excerpt = found.group(0)
            same = next((s for s in reversed(said) if norm(s[3]) == norm(excerpt)), None)
            hit = same or (said[-1] if said else None)
            if hit is None:
                continue
            at, who, text, value = hit
            source = f"{who}, {at} : « {text} »" if who else f"« {text} »"
            claims.append({"excerpt": excerpt, "verdict": "ok" if same else "contredit", "source": source,
                           "fix": "" if same else value})
    return "```json\n" + json.dumps({"claims": claims}, ensure_ascii=False, indent=2) + "\n```"


