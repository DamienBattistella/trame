from __future__ import annotations
import re
from enum import Enum
from typing import Annotated, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from presence import Presence
from teams_check import TeamsCheck


class Surface(str, Enum):
    dm = "dm"
    group = "group"
    channel = "channel"


Mode = Literal["draft", "auto"]


class WatchEntity(BaseModel):
    thread_id: str
    display_name: str
    surface: Surface
    watch: bool = False
    mode: Mode = "draft"
    named_people: list[str] = Field(default_factory=list)
    # Live facts from Teams (not saved): rail position (0 = most recent), time of the
    # last message as Teams shows it ("04:49", "25/11"), unread flag.
    rank: Optional[int] = None
    last_activity: Optional[str] = None
    unread: bool = False
    is_self: bool = False
    own_preview: Optional[str] = None
    # Teams presence of the other person of a 1:1 chat, None when Teams does not say
    # (or said it too long ago): never a guessed status.
    presence: Optional[Presence] = None


# Le petit jeu de réactions de Teams : clé stable côté moteur, emoji côté interface.
# Les réactions rapides de Teams (barre de gestes), dans son ordre.
REACTIONS: dict[str, str] = {
    "like": "👍",
    "heart": "❤️",
    "laugh": "😆",
    "surprised": "😮",
    "sad": "😢",
    "angry": "😡",
}
# Toute réaction de Teams : une clé d'émoticône (« like », « clap », « 1f44f_clappinghands »…).
REACTION_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
Reaction = Annotated[str, StringConstraints(pattern=REACTION_KEY.pattern)]

# Émoticônes Skype courantes que Teams emploie encore comme clés de réaction.
_SKYPE_EMOJI = {
    "smile": "🙂", "happy": "😊", "wink": "😉", "cool": "😎", "cry": "😭", "yes": "👍", "no": "👎",
    "clap": "👏", "party": "🎉", "fire": "🔥", "rocket": "🚀", "pray": "🙏", "praying": "🙏", "ok": "👌",
    "thinking": "🤔", "eyes": "👀", "check": "✅", "star": "⭐", "100": "💯", "tada": "🎉", "muscle": "💪",
    "rofl": "🤣", "joy": "😂", "facepalm": "🤦", "shrug": "🤷", "wave": "👋", "coffee": "☕", "beer": "🍺",
    "cake": "🎂", "sun": "☀️", "kiss": "😘", "inlove": "😍", "think": "🤔", "highfive": "🙌", "handshake": "🤝",
}


def reaction_emoji(key: str) -> str:
    """L'emoji d'une clé de réaction de Teams : les réactions rapides, les émoticônes Skype
    courantes, puis les identifiants d'emoji qui commencent par leurs points de code
    (« 1f44f_clappinghands » -> 👏, « 2764-fe0f_redheart » -> ❤️). Inconnue : "" (la clé
    est alors montrée telle quelle)."""
    k = (key or "").strip().lower()
    if k in REACTIONS:
        return REACTIONS[k]
    if k in _SKYPE_EMOJI:
        return _SKYPE_EMOJI[k]
    m = re.match(r"^((?:[0-9a-f]{4,6})(?:-[0-9a-f]{4,6})*)_", k)
    if m:
        try:
            return "".join(chr(int(cp, 16)) for cp in m.group(1).split("-"))
        except (ValueError, OverflowError):
            return ""
    return ""


class ReactionCount(BaseModel):
    """Une réaction sur un message : sa clé, son emoji, combien l'ont mise, et si tu en fais partie."""
    key: str
    emoji: str = ""
    count: int = 1
    mine: bool = False

# Ce que Teams affiche à la place d'un message supprimé.
DELETED_TEXT = "Ce message a été supprimé."


class IncomingMessage(BaseModel):
    thread_id: str
    sender: str
    text: str
    received_at: str
    surface: Surface
    mentions: list[str] = Field(default_factory=list)
    # Identifiant du message dans Teams quand le pilote le connaît, et réactions que
    # l'utilisateur y a déjà mises (clés de REACTIONS).
    id: Optional[str] = None
    reactions: list[str] = Field(default_factory=list)
    # Toutes les réactions du message (les tiennes et celles des autres), quand le pilote les lit.
    reaction_counts: list["ReactionCount"] = Field(default_factory=list)
    # Pièces jointes reçues : fichiers (nom et lien Teams/SharePoint) et images (aperçu).
    files: list["FileRef"] = Field(default_factory=list)
    images: list["ImageRef"] = Field(default_factory=list)
    # Accusé de lecture d'un de tes messages : True « Vu », False « Envoyé », None inconnu.
    seen: Optional[bool] = None
    # Message supprimé par son auteur : Teams n'en montre plus que DELETED_TEXT.
    deleted: bool = False
    # Liens du texte (texte affiché et adresse : « [ALL-141] Recherche identité - Jira »
    # n'est pas l'adresse) et cartes d'aperçu (Jira, site…) résumées, jamais dans `text`.
    links: list["LinkRef"] = Field(default_factory=list)
    cards: list["CardRef"] = Field(default_factory=list)
    # Message cité (« Répondre » dans Teams) : son auteur, son heure, son extrait. Jamais
    # dans `text`, qui ne garde que la réponse.
    quote: Optional["QuoteRef"] = None
    # Modifié par son auteur après l'envoi (« Modifié » dans Teams).
    edited: bool = False

    def brain_text(self) -> str:
        return brain_text(self.text, self.links, self.cards, self.quote)


class QuoteRef(BaseModel):
    """Le message cité par une réponse, tel que Teams le montre au-dessus d'elle."""
    sender: str = ""
    at: str = ""
    text: str = ""


class LinkRef(BaseModel):
    """Un lien du texte d'un message : son texte tel qu'affiché et son adresse (http/https)."""
    text: str
    url: str


class CardRef(BaseModel):
    """Une carte d'aperçu sous un message, résumée : sa source (Jira, GitHub, un site), son
    titre, son adresse (http/https, peut manquer) et quelques champs (état, assignée…)."""
    source: str = ""
    title: str = ""
    url: str = ""
    fields: list[str] = Field(default_factory=list)

    def summary(self) -> str:
        head = " : ".join(p for p in (self.source, self.title) if p)
        tail = ", ".join(self.fields)
        return f"[aperçu {head}{f' ({tail})' if tail else ''}{f' {self.url}' if self.url else ''}]"


def brain_text(text: str, links: list[LinkRef], cards: list[CardRef], quote: Optional[QuoteRef] = None) -> str:
    """Le texte d'un message pour le cerveau : la citation à laquelle il répond, chaque lien
    « texte (adresse) », puis une ligne par carte d'aperçu, sans ses libellés ni boutons. Les
    adresses y restent visibles pour le contexte GitHub et la vérification des faits."""
    if quote is not None and (quote.text or quote.sender):
        when = f" ({quote.at})" if quote.at else ""
        text = f"(en réponse à {quote.sender or 'un message'}{when} : « {' '.join(quote.text.split())} »)\n{text}"
    for link in links:
        if link.url in text or link.text == link.url:
            continue
        at = text.find(link.text)
        if at >= 0:
            end = at + len(link.text)
            text = f"{text[:end]} ({link.url}){text[end:]}"
        else:
            text = f"{text}\n{link.text} ({link.url})".strip()
    return "\n".join([text, *(c.summary() for c in cards)]).strip()


class FileRef(BaseModel):
    """Un fichier joint à un message : son nom et le lien pour l'ouvrir (https seulement).
    kind : « video » pour une vidéo (lue dans Trame), vide sinon."""
    name: str
    url: str = ""
    kind: str = ""


class ImageRef(BaseModel):
    """Une image d'un message. data : aperçu JPEG/PNG en data URL, absent quand Teams
    ne l'affichait pas au moment de la lecture (l'image se voit alors dans Teams)."""
    data: Optional[str] = None
    width: int = 0
    height: int = 0


IncomingMessage.model_rebuild()


class MessageRef(BaseModel):
    """Un message précis du fil, pour y réagir ou y répondre. Le pilote le retrouve par
    son id, puis vérifie l'auteur et le début du texte : jamais d'action sur un message
    qui ne correspond pas à ce que l'utilisateur a vu."""

    id: Optional[str] = Field(default=None, max_length=200)
    sender: str = Field(default="", max_length=200)
    text: str = Field(min_length=1, max_length=8000)
    at: str = Field(default="", max_length=40)


class Draft(BaseModel):
    id: str
    thread_id: str
    from_: str = Field(alias="from")
    surface: Surface
    incoming: str
    proposal: str
    received_at: str
    mode: Mode
    used_github: Optional[str] = None
    sender_label: Optional[str] = None
    # Le message auquel cette réponse répond (citation dans Teams), quand il est connu.
    reply_to: Optional[MessageRef] = None

    model_config = ConfigDict(populate_by_name=True)


class Notice(BaseModel):
    """A message just received, whatever the conversation: the UI turns it into a
    Windows notification."""
    id: str
    thread_id: str
    conversation: str
    from_: str = Field(alias="from")
    text: str
    at: str
    surface: Surface
    # Pour filtrer les notifications : on te mentionne, et la conversation est suivie.
    mentioned: bool = False
    followed: bool = False

    model_config = ConfigDict(populate_by_name=True)


class LogItem(BaseModel):
    at: str
    # ISO date and time: `at` alone is the time of day, too short for a journal kept across days.
    ts: str = ""
    level: Literal["info", "warn", "sent", "draft"]
    text: str


class Capabilities(BaseModel):
    """Ce que le pilote Teams actif sait faire en plus de lire et d'écrire."""
    react: bool = False
    reply: bool = False
    mentions: bool = False
    # Changer son propre statut Teams (Disponible, Ne pas déranger…).
    own_status: bool = False
    # Supprimer un de ses propres messages.
    delete: bool = False
    # Modifier le texte d'un de ses propres messages.
    edit: bool = False


class Readiness(BaseModel):
    """Ce qui est prêt dans Teams, capacité par capacité, pour que l'interface dise « Teams se
    connecte… » au lieu d'afficher des erreurs. « waiting » : pas encore ; « ready » : prêt ;
    « off » : pas de Teams intégré (autre pilote, ou option désactivée)."""
    page: Literal["waiting", "ready", "off"] = "waiting"
    # Service de chat de Teams (lecture sans ouvrir, envois, présence) ; « off » sans API Teams web.
    chat: Literal["waiting", "ready", "off"] = "off"
    # Depuis quand l'état de la page n'a pas changé (heure locale « HH:MM:SS »).
    since: str = ""


class AppState(BaseModel):
    onboarded: bool = False
    paused: bool = False
    screen_sharing: bool = False
    brain: Literal["claude", "copilot"] = "claude"
    selftest_ok: bool = True
    readiness: Readiness = Field(default_factory=Readiness)
    watchlist: list[WatchEntity] = Field(default_factory=list)
    drafts: list[Draft] = Field(default_factory=list)
    logs: list[LogItem] = Field(default_factory=list)
    notices: list[Notice] = Field(default_factory=list)
    capabilities: Capabilities = Field(default_factory=Capabilities)
    # Son propre statut Teams, tel que Teams l'affiche ; None quand il ne le dit pas.
    my_presence: Optional[Presence] = None
    # Sa photo de profil Teams (data URL, 96 px) ; None sans photo ou tant qu'elle n'est pas lue.
    my_photo: Optional[str] = None
    # Messages que tu as envoyés quand Teams n'était pas prêt : ils partent dès qu'il l'est.
    outbox: list["QueuedSend"] = Field(default_factory=list)
    # thread id -> compteur : change dès qu'un message arrive ou que Trame en envoie un
    # (mode Auto, file d'envoi, brouillon). La discussion ouverte se relit alors.
    thread_updates: dict[str, int] = Field(default_factory=dict)
    # Réponses envoyées par le mode Auto, encore annulables (supprimées dans Teams).
    undoable: list["UndoableSend"] = Field(default_factory=list)
    # Ce que le mode Auto a envoyé seul aujourd'hui (heure, conversation, texte).
    auto_today: list["AutoSent"] = Field(default_factory=list)
    # Dernier contrôle des repères de la page Teams web ; None tant qu'il n'a pas tourné
    # (ou que le pilote ne sait pas le faire).
    teams_check: Optional[TeamsCheck] = None
    # Tes questions restées sans réponse, avec la relance proposée (jamais envoyée seule).
    follow_ups: list["FollowUp"] = Field(default_factory=list)
    # Conversations épinglées en haut de la liste, dans l'ordre choisi (identifiants).
    # Indépendant de « Suivie » : une conversation non suivie peut être en favori.
    favorites: list[str] = Field(default_factory=list)
    # Conversations archivées (identifiant -> détail) : hors des sections principales,
    # de retour au premier message reçu. Rien n'est supprimé, ni dans Trame ni dans Teams.
    archived: dict[str, "Archived"] = Field(default_factory=dict)


class Archived(BaseModel):
    at: str  # ISO, heure locale
    auto: bool = False  # archivée par l'archivage automatique (sinon à la main)
    label: Optional[str] = None  # heure de la liste Teams au moment de l'archivage
    hidden: bool = False  # aussi masquée dans Teams (service de chat de Teams)


class UndoableSend(BaseModel):
    """Une réponse partie seule (mode Auto) que l'utilisateur peut encore retirer : Trame
    la supprime alors dans Teams, comme une suppression faite à la main."""
    id: str
    thread_id: str
    conversation: str
    text: str
    sent_at: str
    # Fin de la fenêtre d'annulation, en millisecondes depuis l'époque (pour le compte à rebours).
    expires_at_ms: int


class AutoSent(BaseModel):
    at: str
    thread_id: str
    conversation: str
    text: str


class FollowUp(BaseModel):
    """Une relance proposée : ta question restée sans réponse, depuis quand (ISO, heure
    locale), et le texte proposé, modifiable avant envoi."""
    id: str
    thread_id: str
    conversation: str
    question: str
    asked_at: str
    proposal: str


class QueuedSend(BaseModel):
    """Un message envoyé par l'utilisateur alors que Teams n'était pas prêt (fenêtre de
    Trame en reconnexion, partage d'écran…) : rien n'a atteint Teams, Trame le renvoie
    seul dès que possible. waiting : en attente ; sending : en cours ; failed : refusé
    pour une raison qui demande ton action (jamais renvoyé seul) ; uncertain : peut-être
    parti, à vérifier dans Teams (jamais renvoyé seul)."""
    id: str
    thread_id: str
    conversation: str
    text: str
    files: list[str] = Field(default_factory=list)
    reply_to: Optional["MessageRef"] = None
    queued_at: str
    attempts: int = 0
    status: Literal["waiting", "sending", "failed", "uncertain"] = "waiting"
    reason: str = ""


class GithubHit(BaseModel):
    kind: Literal["pr", "issue", "commit"]
    repo: str
    number: Optional[int] = None
    title: str
    state: Optional[Literal["open", "closed", "merged"]] = None
    url: str
    why: str


class BriefSources(BaseModel):
    messages: int
    repos_searched: int
    # Période lue : "messages" (les N derniers) ou une plage de temps (today, 24h, 7d, 30d).
    range: str = "messages"


class Brief(BaseModel):
    thread_id: str
    display_name: str
    generated_at: str
    summary: str
    open_points: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    github_enabled: bool
    github: list[GithubHit] = Field(default_factory=list)
    sources: BriefSources


# --- vérification des faits d'un message avant envoi ---
Verdict = Literal["contredit", "non_verifiable", "ok"]


class Claim(BaseModel):
    excerpt: str = Field(min_length=1)
    verdict: Verdict
    source: str = ""
    fix: Optional[str] = None

    @field_validator("excerpt")
    @classmethod
    def _excerpt(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("extrait vide")
        return v

    @field_validator("source", mode="before")
    @classmethod
    def _source(cls, v) -> str:
        return " ".join(str(v or "").split())[:400]

    @field_validator("fix", mode="before")
    @classmethod
    def _fix(cls, v) -> Optional[str]:
        v = str(v or "").strip()
        return v or None


class FactCheckSources(BaseModel):
    messages: int
    people: int
    github: int


class FactCheck(BaseModel):
    thread_id: str
    checked_at: str
    claims: list[Claim] = Field(default_factory=list)
    sources: FactCheckSources


AppState.model_rebuild()

