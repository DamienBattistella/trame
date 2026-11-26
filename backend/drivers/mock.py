from __future__ import annotations
import itertools
import time
from datetime import datetime
from typing import Callable, Iterable, Optional
from models import DELETED_TEXT, IncomingMessage, MessageRef, Surface, WatchEntity
from drivers.base import TeamsDriver, same_message

_SEED = [
    WatchEntity(thread_id="19:aa11@thread.v2", display_name="Sofia Marino", surface=Surface.dm, watch=True, mode="auto"),
    WatchEntity(thread_id="19:bb22@thread.v2", display_name="Lucas Bernard", surface=Surface.dm, watch=True, mode="draft"),
    WatchEntity(thread_id="19:cc33@thread.v2", display_name="Équipe Interop", surface=Surface.group, watch=True, mode="draft", named_people=["Sofia Marino"]),
    WatchEntity(thread_id="19:dd44@thread.v2", display_name="#prod-incidents", surface=Surface.channel, watch=False, mode="draft"),
    WatchEntity(thread_id="19:ee55@thread.v2", display_name="Chiara Rossi", surface=Surface.dm, watch=False, mode="draft"),
    WatchEntity(thread_id="19:meeting_ff66@thread.v2", display_name="Point interop hebdo", surface=Surface.group, watch=False, mode="draft"),
]

# Conversations de réunion : le lien de la réunion, et si elle est en cours.
_MEETINGS = {
    "19:meeting_ff66@thread.v2": {
        "url": "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ff66%40thread.v2/0?context=%7b%22Tid%22%3a%22demo%22%7d",
        "live": True,
    },
}


def _say(line: str) -> None:
    """Console trace of the mock. A Windows console in cp1252 cannot print an emoji
    (the 🤖 of automatic sends): never let the trace fail the send it describes."""
    try:
        print(line)
    except UnicodeEncodeError:
        print(line.encode("ascii", "backslashreplace").decode("ascii"))


_SCRIPT = [
    ("19:bb22@thread.v2", "Lucas Bernard", "Tu peux relire la PR #214 sur le mapping HL7 ? Je bloque sur le segment OBX.", []),
    ("19:cc33@thread.v2", "Sofia Marino", "@Damien dispo pour un point interop demain 10h ?", ["Damien"]),
    ("19:aa11@thread.v2", "Sofia Marino", "Le build passe de ton côté ?", []),
]

_UNREAD = {
    "19:aa11@thread.v2": ("Sofia Marino", "Tu as vu mon mail sur la recette de jeudi ?", []),
    "19:bb22@thread.v2": ("Lucas Bernard", "J'ai poussé un correctif sur la branche, tu me dis si c'est bon pour toi.", []),
    "19:cc33@thread.v2": ("Sofia Marino", "@Damien on garde le créneau de 14h pour la démo interop ?", ["Damien"]),
    "19:dd44@thread.v2": ("Alerte Prod", "Latence élevée sur le connecteur HL7 depuis 9h12.", []),
    "19:ee55@thread.v2": ("Chiara Rossi", "Bonjour Damien, tu aurais 5 minutes cet après-midi ?", []),
}

_HISTORY: dict[str, list[tuple[str, str, str]]] = {
    "19:meeting_ff66@thread.v2": [
        ("09:58", "Sofia Marino", "Je lance la réunion, on commence par le point FHIR."),
        ("10:01", "Lucas Bernard", "J'arrive dans deux minutes."),
    ],
    "19:aa11@thread.v2": [
        ("08:52", "Sofia Marino", "Salut Damien, la CI est rouge sur main depuis ce matin."),
        ("08:54", "Damien Battistella", "Je regarde. C'est le job de tests d'intégration HL7 ?"),
        ("08:55", "Sofia Marino", "Oui, le test du parseur OBX tombe en timeout sur le runner Windows."),
        ("09:03", "Damien Battistella", "Le runner a pris la nouvelle image hier soir, le cache Maven a sauté."),
        ("09:04", "Sofia Marino", "Ok, tu relances le pipeline ou je le fais ?"),
        ("09:06", "Damien Battistella", "Je le relance avec le cache réchauffé, je te dis."),
        ("09:31", "Damien Battistella", "Build vert sur main, c'était bien le cache."),
        ("09:33", "Sofia Marino", "Top. Il faudrait épingler la version de l'image du runner pour éviter ça."),
        ("09:34", "Damien Battistella", "Je crée une issue pour l'épinglage, on en parle à la rétro."),
        ("10:12", "Sofia Marino", "Pour la recette de jeudi, on part bien sur le build d'aujourd'hui ?"),
        ("10:15", "Damien Battistella", "Oui, si la PR #214 est fusionnée avant demain midi."),
        ("10:41", "Sofia Marino", "Le build passe de ton côté ?"),
    ],
    "19:bb22@thread.v2": [
        ("14:02", "Lucas Bernard", "Damien, j'ai ouvert la PR #214 pour le mapping HL7 des résultats de labo."),
        ("14:03", "Lucas Bernard", "Elle convertit les segments OBX en Observation FHIR."),
        ("14:10", "Damien Battistella", "Je regarde. Tu gères le typage de OBX-2 ?"),
        ("14:12", "Lucas Bernard", "Pour l'instant je force ST partout, c'était plus simple."),
        ("14:15", "Damien Battistella", "Ça va casser les valeurs numériques : OBX-2 doit suivre ce que porte OBX-5 (NM, ST, CE)."),
        ("14:18", "Lucas Bernard", "D'accord. Et pour les unités en OBX-6, je mappe vers UCUM ?"),
        ("14:20", "Damien Battistella", "Oui, avec une table de correspondance, et on garde le code local si pas de correspondance."),
        ("14:26", "Lucas Bernard", "Il y a aussi des messages avec plusieurs OBX pour un même examen, je les regroupe ?"),
        ("14:29", "Damien Battistella", "Regroupe par OBR, un Observation par OBX, rattachés au même DiagnosticReport."),
        ("14:31", "Lucas Bernard", "Ok, je reprends ça. Les tests de non-régression sont dans la PR aussi."),
        ("16:47", "Lucas Bernard", "J'ai poussé le typage OBX-2, mais il reste un cas avec des valeurs CE vides."),
        ("16:50", "Lucas Bernard", "Tu peux relire la PR #214 sur le mapping HL7 ? Je bloque sur le segment OBX."),
    ],
    "19:cc33@thread.v2": [
        ("09:15", "Sofia Marino", "Bonjour à tous, on cale la démo interop pour le client la semaine prochaine."),
        ("09:17", "Chiara Rossi", "Côté client ils veulent voir le flux résultats de labo de bout en bout."),
        ("09:20", "Lucas Bernard", "Ça dépend de la PR #214, le mapping OBX n'est pas encore fusionné."),
        ("09:22", "Damien Battistella", "Je la relis aujourd'hui. Le blocage restant, c'est le typage OBX-2."),
        ("09:25", "Sofia Marino", "On peut faire la démo sur la branche si besoin ?"),
        ("09:27", "Damien Battistella", "Je préfère une version taguée, sinon on ne sait pas ce qu'on montre."),
        ("09:31", "Chiara Rossi", "Il faut aussi un jeu de messages anonymisés, je peux le préparer."),
        ("09:33", "Lucas Bernard", "J'ai des ORU^R01 de test dans le repo, il faudra juste vérifier l'anonymisation."),
        ("09:40", "Sofia Marino", "Et l'alerte de latence sur le connecteur HL7 de ce matin, ça peut gêner ?"),
        ("09:42", "Damien Battistella", "C'est la prod, pas l'environnement de démo, mais je garde un œil dessus."),
        ("11:05", "Sofia Marino", "@Damien dispo pour un point interop demain 10h ?"),
        ("11:20", "Sofia Marino", "@Damien on garde le créneau de 14h pour la démo interop ?"),
    ],
    "19:dd44@thread.v2": [
        ("09:12", "Alerte Prod", "Latence élevée sur le connecteur HL7 depuis 9h12."),
        ("09:14", "Marc Lefèvre", "Je confirme, p95 à 4,2 s au lieu de 300 ms sur la réception ORU."),
        ("09:16", "Chiara Rossi", "Ça coïncide avec le déploiement de 9h ?"),
        ("09:18", "Marc Lefèvre", "Possible, la release contient le nouveau pool de connexions MLLP."),
        ("09:21", "Damien Battistella", "Le pool est limité à 4 connexions par défaut, c'est peut-être trop bas."),
        ("09:25", "Marc Lefèvre", "Les accusés ACK partent bien mais avec du retard, la file monte."),
        ("09:30", "Chiara Rossi", "On fait un rollback ou on augmente la taille du pool ?"),
        ("09:33", "Damien Battistella", "Augmenter le pool à 16 par la config, c'est réversible sans redéployer."),
        ("09:41", "Marc Lefèvre", "Fait. La latence redescend, p95 à 900 ms."),
        ("09:44", "Chiara Rossi", "Il faudrait une issue pour revoir la valeur par défaut et ajouter une alerte sur la file."),
    ],
    "19:ee55@thread.v2": [
        ("11:02", "Chiara Rossi", "Salut Damien, je reprends la doc d'intégration du connecteur HL7."),
        ("11:04", "Damien Battistella", "Super, il y a un brouillon dans le wiki du repo."),
        ("11:06", "Chiara Rossi", "Je l'ai vu, mais il manque la partie sur les segments OBX et leur typage."),
        ("11:08", "Damien Battistella", "Lucas est en train de finaliser ça dans la PR #214, attends qu'elle soit fusionnée."),
        ("11:10", "Chiara Rossi", "D'accord. Et pour la démo interop, tu veux que je prépare les messages anonymisés ?"),
        ("11:13", "Damien Battistella", "Oui, ça aiderait beaucoup, merci."),
        ("11:15", "Chiara Rossi", "Je m'y mets cet après-midi."),
        ("15:20", "Chiara Rossi", "Bonjour Damien, tu aurais 5 minutes cet après-midi ?"),
    ],
}


# Simulated presence of the 1:1 chats, moving one step every PRESENCE_STEP seconds:
# enough variety to see every dot, slow enough to look like a real day.
_PRESENCE: dict[str, list[str]] = {
    "19:aa11@thread.v2": ["available", "available", "in_meeting", "available", "busy"],
    "19:bb22@thread.v2": ["in_meeting", "in_meeting", "available", "in_call", "away"],
    "19:ee55@thread.v2": ["away", "brb", "available", "dnd", "offline"],
}


# The people Teams' own search knows in the demo, beyond the conversations above.
_TEAMS_PEOPLE = [
    "Sofia Marino", "Lucas Bernard", "Chiara Rossi", "Marc Lefèvre", "Alice Martin",
    "Antoine Girard", "Camille Leroy", "Nadia Benali", "Thomas Petit", "Julie Moreau",
]


def _fold(text: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn").casefold()


# Older messages, only reachable through Teams' own search (dates as Teams shows them).
_OLDER: dict[str, list[tuple[str, str, str]]] = {
    "19:aa11@thread.v2": [
        ("12/10 09:41", "Sofia Marino", "On avait déjà eu ce souci de cache sur le runner Windows en septembre."),
        ("12/10 09:45", "Damien Battistella", "Oui, l'épinglage de l'image avait été repoussé au trimestre suivant."),
    ],
    "19:bb22@thread.v2": [
        ("03/09 16:20", "Lucas Bernard", "Pour le premier jet du mapping HL7, je pars sur une table de correspondance UCUM ?"),
        ("03/09 16:24", "Damien Battistella", "Oui, garde le code local quand il n'y a pas de correspondance."),
    ],
    "19:dd44@thread.v2": [
        ("28/08 11:02", "Marc Lefèvre", "Incident clos : la latence du connecteur HL7 venait du pool MLLP trop petit."),
    ],
}


class MockTeamsDriver(TeamsDriver):
    PRESENCE_STEP = 120.0
    can_start_chat = True
    can_search_people = True
    can_search_messages = True
    supports_reactions = True
    supports_reply = True
    supports_mentions = True
    supports_delete = True
    # L'utilisateur de la démo : Teams ne propose « Supprimer » que sur ses messages.
    ME = "Damien Battistella"

    def __init__(self, interval: float = 20.0):
        self.interval = interval
        self._convs = [c.model_copy() for c in _SEED]
        self._active: Optional[str] = None
        self.typed: list[tuple[str, str, bool]] = []
        self.sent_files: list[tuple[str, str, list[tuple[str, int]]]] = []
        self.opened: list[str] = []
        self.marked_read: list[str] = []
        self.cleared: list[str] = []
        # Teams resolves anyone in the organization: the entourage is part of it.
        self.allow_anyone = True
        # Gestes simulés : réponses citant un message, réactions posées (par id de message).
        self.replies: list[tuple[str, str, str, bool]] = []
        self.mentioned: list[tuple[str, str, list[str], bool]] = []
        self.reactions: dict[str, list[str]] = {}
        # Messages supprimés, par « conversation/id ».
        self.deleted: set[str] = set()

    def _thread(self, thread_id: str) -> list[tuple[str, str, str, str]]:
        """(id, heure, auteur, texte) : ids stables, à la position du message dans le fil.
        Un message supprimé ne montre plus que DELETED_TEXT, comme dans Teams."""
        return [(f"m{i}", at, sender, DELETED_TEXT if f"{thread_id}/m{i}" in self.deleted else text)
                for i, (at, sender, text) in enumerate(_HISTORY.get(thread_id, []))]

    def _find(self, thread_id: str, ref: MessageRef) -> Optional[str]:
        """Id of the message ref points at, None unless its author and text match."""
        rows = self._thread(thread_id)
        if ref.id:
            row = next((r for r in rows if r[0] == ref.id), None)
            return row[0] if row and same_message(ref, row[2], row[3]) else None
        return next((r[0] for r in reversed(rows) if same_message(ref, r[2], r[3])), None)

    def selftest(self) -> bool:
        return True

    def list_conversations(self) -> list[WatchEntity]:
        seen = self.presence()
        return [c.model_copy(update={"presence": seen.get(c.thread_id)}) for c in self._convs]

    def presence(self) -> dict[str, str]:
        step = int(time.time() // self.PRESENCE_STEP)
        return {tid: cycle[step % len(cycle)] for tid, cycle in _PRESENCE.items()}

    # Statut simulé : ce que l'utilisateur choisit, « Réinitialiser » le remet à Disponible.
    can_set_status = True
    my_presence: Optional[str] = "available"
    my_message: str = ""
    my_duration: Optional[str] = None
    my_until: Optional[datetime] = None

    def my_status(self, with_message: bool = False) -> dict:
        out: dict = {"presence": self.my_presence}
        if with_message:
            out["message"] = self.my_message
        return out

    def set_my_status(self, choice: str, duration: Optional[str] = None,
                      until: Optional[datetime] = None) -> Optional[str]:
        self.my_presence = "available" if choice == "reset" else choice
        self.my_duration = duration
        self.my_until = until
        return self.my_presence

    def set_status_message(self, text: str) -> str:
        self.my_message = " ".join((text or "").split())
        return self.my_message

    def is_screen_sharing(self) -> bool:
        return False

    def read_context(self, thread_id: str, last_n: int) -> list[IncomingMessage]:
        self._note_meeting(thread_id, _MEETINGS.get(thread_id))
        surface = next((c.surface for c in self._convs if c.thread_id == thread_id), Surface.dm)
        history = self._thread(thread_id)[-last_n:] if last_n > 0 else []
        return [
            IncomingMessage(thread_id=thread_id, sender=sender, text=text, received_at=at, surface=surface,
                            id=mid, reactions=list(self.reactions.get(f"{thread_id}/{mid}", [])),
                            deleted=f"{thread_id}/{mid}" in self.deleted)
            for mid, at, sender, text in history
        ]

    def open_thread(self, thread_id: str) -> bool:
        if not any(c.thread_id == thread_id for c in self._convs):
            return False
        self._active = thread_id
        self.opened.append(thread_id)
        return True

    def active_thread(self) -> Optional[str]:
        return self._active

    def search_people(self, query: str, limit: int = 8) -> list[str]:
        words = _fold(query).split()
        if not words:
            return []
        hits = [n for n in _TEAMS_PEOPLE if all(any(t.startswith(w) for t in _fold(n).split()) for w in words)]
        return hits[:limit]

    def search_messages(self, query: str, limit: int = 25) -> list[dict]:
        """Like Teams' search: every conversation, older messages included."""
        q = _fold(" ".join((query or "").split()))
        if len(q) < 2:
            return []
        names = {c.thread_id: c.display_name for c in self._convs}
        out = []
        for thread_id, history in [*_OLDER.items(), *_HISTORY.items()]:
            for at, sender, text in reversed(history):
                if q in _fold(text):
                    mine = sender == "Damien Battistella"
                    dm = next((c.surface == Surface.dm for c in self._convs if c.thread_id == thread_id), False)
                    out.append({"conversation": names[thread_id] if not (dm and mine) else "", "sender": sender,
                                "mine": mine, "at": at, "text": text})
        return out[:limit]

    def start_chat(self, name: str) -> Optional[WatchEntity]:
        name = " ".join((name or "").split())
        existing = next((c for c in self._convs if c.surface == Surface.dm and _fold(c.display_name) == _fold(name)), None)
        if existing is None:
            if not name or (_fold(name) not in {_fold(n) for n in _TEAMS_PEOPLE} and not self.allow_anyone):
                self.last_error = f"« {name} » introuvable dans Teams"
                return None
            slug = "".join(c for c in _fold(name) if c.isalnum())[:24]
            existing = WatchEntity(thread_id=f"19:new-{slug}@unq.gbl.spaces", display_name=name, surface=Surface.dm,
                                   rank=0, last_activity=datetime.now().strftime("%H:%M"))
            for c in self._convs:
                if c.rank is not None:
                    c.rank += 1
            self._convs.insert(0, existing)
        self._active = existing.thread_id
        self.opened.append(existing.thread_id)
        return existing.model_copy()

    def _type_into_active(self, thread_id: str, text: str, send: bool) -> bool:
        if self._active != thread_id:
            return False
        self.typed.append((thread_id, text, send))
        action = "ENVOYÉ" if send else "SAISI"
        _say(f"[mock] {action} -> {thread_id}: {text[:80]}")
        return True

    can_attach = True

    def _send_files_into_active(self, thread_id, text, files, reply_to=None) -> bool:
        if self._active != thread_id:
            return False
        self.sent_files.append((thread_id, text, [(f.name, f.size) for f in files]))
        print(f"[mock] ENVOYÉ + {len(files)} fichier(s) -> {thread_id}: {text[:80]}")
        return True

    def _clear_active(self, thread_id: str) -> bool:
        if self._active != thread_id:
            return False
        self.cleared.append(thread_id)
        return True

    def mark_read(self, thread_id: str) -> bool:
        if not any(c.thread_id == thread_id for c in self._convs):
            self.last_error = "conversation absente de la liste"
            return False
        self.marked_read.append(thread_id)
        for c in self._convs:
            if c.thread_id == thread_id:
                c.unread = False
        return True

    def _reply_in_active(self, thread_id: str, target: MessageRef, text: str, send: bool) -> bool:
        if self._active != thread_id:
            return False
        if self._find(thread_id, target) is None:
            raise RuntimeError("message cité introuvable dans la conversation")
        self.typed.append((thread_id, text, send))
        self.replies.append((thread_id, target.text, text, send))
        action = "RÉPONSE ENVOYÉE" if send else "RÉPONSE SAISIE"
        _say(f"[mock] {action} -> {thread_id} (à « {target.text[:30]} »): {text[:80]}")
        return True

    def _type_with_mentions(self, thread_id: str, text: str, send: bool, mentions: list[str],
                            reply_to: Optional[MessageRef] = None) -> bool:
        ok = (self._reply_in_active(thread_id, reply_to, text, send) if reply_to is not None
              else self._type_into_active(thread_id, text, send))
        if ok:
            self.mentioned.append((thread_id, text, list(mentions), send))
        return ok

    def _react_in_active(self, thread_id: str, target: MessageRef, reaction: str) -> bool:
        if self._active != thread_id:
            return False
        mid = self._find(thread_id, target)
        if mid is None:
            raise RuntimeError("message introuvable dans la conversation")
        mine = self.reactions.setdefault(f"{thread_id}/{mid}", [])
        if reaction not in mine:
            mine.append(reaction)
        _say(f"[mock] RÉACTION {reaction} -> {thread_id}/{mid}")
        return True

    def _delete_in_active(self, thread_id: str, target: MessageRef) -> bool:
        if self._active != thread_id:
            return False
        mid = self._find(thread_id, target)
        if mid is None:
            raise RuntimeError("message introuvable ou différent de celui choisi")
        sender = next(r[2] for r in self._thread(thread_id) if r[0] == mid)
        if sender != self.ME:
            raise RuntimeError("Teams ne propose pas « Supprimer » sur ce message")
        self.deleted.add(f"{thread_id}/{mid}")
        self.reactions.pop(f"{thread_id}/{mid}", None)
        _say(f"[mock] SUPPRIMÉ -> {thread_id}/{mid}")
        return True

    def list_unread(self, thread_ids: Optional[Iterable[str]] = None) -> list[IncomingMessage]:
        wanted = set(thread_ids) if thread_ids is not None else None
        now = datetime.now().strftime("%H:%M")
        out: list[IncomingMessage] = []
        for c in self._convs:
            if c.thread_id not in _UNREAD or c.thread_id in self.marked_read or (wanted is not None and c.thread_id not in wanted):
                continue
            sender, text, mentions = _UNREAD[c.thread_id]
            out.append(IncomingMessage(
                thread_id=c.thread_id, sender=sender, text=text,
                received_at=now, surface=c.surface, mentions=list(mentions),
            ))
        return out

    def watch(self, on_message: Callable[[IncomingMessage], None], should_stop: Callable[[], bool]) -> None:
        for thread_id, sender, text, mentions in itertools.cycle(_SCRIPT):
            for _ in range(int(self.interval * 2)):
                if should_stop():
                    return
                time.sleep(0.5)
            on_message(IncomingMessage(
                thread_id=thread_id, sender=sender, text=text,
                received_at=datetime.now().strftime("%H:%M"),
                surface=next((c.surface for c in self._convs if c.thread_id == thread_id), Surface.dm),
                mentions=mentions,
            ))
