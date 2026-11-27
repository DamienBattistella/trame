from __future__ import annotations
import re
import unicodedata
from typing import Optional

AUTO_MARK = "🤖"

# The tone of the reply, checked in this order (the first that matches wins): a sorry
# reply must not get a smile because it also says « merci ». Plain words of the reply
# itself, accents ignored; no match keeps the 🤖 alone.
TONES: list[tuple[str, tuple[str, ...]]] = [
    ("😔", ("desole", "desolee", "dommage", "malheureusement", "navre", "navree", "triste", "pas pu",
            "pas reussi", "impossible", "echec", "sorry", "unfortunately")),
    ("🎉", ("bravo", "felicitations", "bien joue", "chapeau", "congrats", "well done")),
    ("😊", ("merci", "super", "genial", "top", "parfait", "ravi", "ravie", "content", "contente",
            "excellent", "avec plaisir", "thanks", "great")),
    ("😎", ("pas de souci", "pas de soucis", "pas de probleme", "ca roule", "tranquille", "nickel",
            "carrement", "t'inquiete", "je gere", "no worries", "easy")),
    ("🤔", ("je regarde", "je verifie", "je me renseigne", "a voir", "je ne sais pas", "aucune idee",
            "bonne question")),
]
TONE_MARKS = tuple(mark for mark, _words in TONES)
_TONE_RES = [(mark, re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b")) for mark, words in TONES]


def _plain(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text.casefold().replace("’", "'"))
    return "".join(c for c in folded if not unicodedata.combining(c))


def tone_of(text: str) -> str:
    """The emoji matching the tone of a reply (sad, celebrating, happy, cool, thinking),
    or "" when nothing stands out."""
    plain = _plain(text)
    return next((mark for mark, pattern in _TONE_RES if pattern.search(plain)), "")


def mark_automatic(text: str) -> str:
    """Append the 🤖 marker to a reply Trame sends on its own, followed by the emoji of
    its tone (« Merci ! 🤖😊 »). Applied to the cleaned reply (clean_reply already
    stripped labels, quotes and blank edges), so the marker is the very last thing in
    the message. Never doubled when the brain already wrote a 🤖; an empty text (an
    attachment alone) gets nothing."""
    body = text.rstrip()
    if not body.strip() or AUTO_MARK in body:
        return text
    return f"{body} {AUTO_MARK}{tone_of(body)}"


def unmark(text: str) -> str:
    """The text without its trailing 🤖 marker and tone emoji (for comparing with what
    Teams shows)."""
    body = text.strip()
    for mark in TONE_MARKS:
        if body.endswith(AUTO_MARK + mark):
            body = body[: -len(mark)]
            break
    return body[: -len(AUTO_MARK)].rstrip() if body.endswith(AUTO_MARK) else body


def marks_automatic(cfg: dict) -> bool:
    """On unless the user turned it off: a config without the key keeps the marker."""
    return bool(cfg.get("safety", {}).get("mark_auto_replies", True))


def blocked_by_filter(text: str, needles: list[str]) -> bool:
    low = text.lower()
    return any(n.lower() in low for n in needles)


def should_react(
    surface: str,
    mentions: list[str],
    named_people: list[str],
    triggers: dict,
    self_names: list[str],
) -> bool:
    """1:1 = every message. Group/channel = only when the user (self_names) or a
    named person is mentioned."""
    rule = triggers.get(surface, "mention_or_named")
    if rule == "every_message":
        return True
    if rule == "mention_or_named":
        low = [m.lower() for m in mentions]
        if any(any(s.lower() in m for m in low) for s in self_names):
            return True
        return any(p in mentions for p in named_people)
    return False


# --- Ce que Trame peut faire, et ce qu'il laisse à l'utilisateur ---
# Trame n'écrit que des messages dans Teams. Il n'a accès à aucun environnement, serveur,
# fichier de logs, base de données, déploiement ou outil interne, et ne lit GitHub que pour
# le contexte qu'il ajoute lui-même au prompt. Une demande d'action que seul l'utilisateur peut
# mener, ou une réponse qui l'engage à agir, ne part donc jamais toute seule en mode Auto :
# elle reste en brouillon, pour que l'utilisateur décide.

# Une demande d'agir sur un système : « tu peux regarder les logs de la recette ? »,
# « relance le service sur ws004 », « can you check the prod DB ».
_ASK = (r"(?:peux|pourrais|pourriez|pouvez|peut|merci de|stp|svp|tu|vous|can you|could you|please|pls)\b.{0,60}?"
        r"\b(?:regarde\w*|v[eé]rifi\w*|check\w*|cherch\w*|r[eéè]cup[eéè]r\w*|extrai\w*|envoi\w*|envoy\w*|transf[eéè]r\w*|"
        r"d[eé]ploi\w*|d[eé]ploy\w*|livr\w*|lanc\w*|relanc\w*|red[eé]marr\w*|restart\w*|rebo\w*|install\w*|"
        r"migr\w*|purg\w*|supprim\w*|cr[eé]\w*|ouvr\w*|donn\w*|ajout\w*|corrig\w*|fix\w*|run\w*|ex[eé]cut\w*|"
        r"look|pull|fetch|send|deploy|grab|get)\b")
_SYSTEM = (r"\b(?:logs?|journaux|traces?|stack ?trace|serveurs?|server|vm|machines?|environnements?|envs?|prod|"
           r"production|pr[eé]prod|recette|staging|qa|int[eé]gration|dev|base(?:s)? de donn[eé]es|bdd|db|database|"
           r"sql|requ[eê]tes?|tables?|dump|backup|sauvegarde|pipeline|ci|job|cluster|pods?|conteneurs?|containers?|"
           r"docker|kubernetes|k8s|ssh|acc[eè]s|droits?|comptes?|mot de passe|password|fichiers?|files?|dossiers?|"
           r"partage|r[eé]pertoire|ticket|jira)\b")
_ASK_RE = re.compile(_ASK, re.IGNORECASE | re.DOTALL)
_SYSTEM_RE = re.compile(_SYSTEM, re.IGNORECASE)

# Une réponse qui engage l'utilisateur à agir (« je regarde », « je te l'envoie », « je relance »).
_COMMIT_RE = re.compile(
    r"\b(?:je|j'|on)\s*(?:vais\s+|te\s+|vous\s+|t'|v'|le\s+|la\s+|les\s+|l')*"
    r"(?:regarde|v[eé]rifie|check|cherche|r[eéè]cup[eéè]re|envoie|transf[eéè]re|d[eé]ploie|livre|lance|relance|"
    r"red[eé]marre|installe|corrige|m'en occupe|m'occupe|reviens|fais|ferai|regarderai|enverrai|relancerai|"
    r"m'en charge)\b",
    re.IGNORECASE)


def asks_for_action(text: str) -> bool:
    """Le message demande d'agir sur un système (logs, serveur, environnement, base, accès…) :
    une action que Trame ne peut pas mener, seul l'utilisateur le peut."""
    plain = (text or "").replace("’", "'")
    return bool(_ASK_RE.search(plain) and _SYSTEM_RE.search(plain))


def commits_to_action(reply: str) -> bool:
    """La réponse engage l'utilisateur à faire quelque chose (« je regarde », « je te l'envoie »)."""
    return bool(_COMMIT_RE.search((reply or "").replace("’", "'")))


def beyond_capabilities(incoming: str, reply: str) -> Optional[str]:
    """Pourquoi une réponse automatique doit attendre l'utilisateur parce qu'elle touche à une
    action que Trame ne peut pas mener ; None quand elle peut partir."""
    if asks_for_action(incoming):
        return "le message demande une action sur un système (logs, serveur, environnement…) que Trame ne peut pas faire"
    if commits_to_action(reply):
        return "la réponse t'engage à agir"
    return None
