from __future__ import annotations
import json
import re

from brain.base import Brain


class MockBrain(Brain):
    """Deterministic offline brain (TRAME_BRAIN=mock): no CLI call, no subscription used."""

    def draft(self, soul: str, thread_summary: str, incoming: str, github_context: str = "", people_context: str = "") -> str:
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

    def complete(self, prompt: str, timeout: float | None = None) -> str:
        if "Message à vérifier :" in prompt:
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


