import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { Ban, BookOpenText, Brain, Check, Copy, ExternalLink, FileText, ListChecks, Loader2, Paperclip, PenLine, Reply, RotateCcw, SearchX, Send, Sparkles, SpellCheck, Star, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { StickToBottom, type StickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AutoToggle, InitialsAvatar, PRESENCE, shake } from "@/components/kit";
import { Highlight } from "@/components/MessageSearchResults";
import { LinkCards } from "@/components/LinkCards";
import { MessageText } from "@/components/MessageText";
import { MessageAttachments } from "@/components/MessageAttachments";
import { ScrollTimeline, type TimelineItem } from "@/components/ScrollTimeline";
import { FactCheckPanel } from "@/components/FactCheckPanel";
import { ThreadActivity } from "@/components/ThreadActivity";
import { OutboxItems } from "@/components/OutboxItems";
import { UndoAutoBar } from "@/components/UndoAuto";
import { FollowUpCards } from "@/components/FollowUpCard";
import { JoinMeeting } from "@/components/JoinMeeting";
import { findFolded, fold } from "@/lib/textSearch";
import { applyMention, matchPeople, mentionQuery, mentionsUsed } from "@/lib/mentions";
import { wordDiff } from "@/lib/wordDiff";
import { jiraBases } from "@/lib/apps";
import { layoutThread } from "@/lib/threadLayout";
import { GithubLogo } from "@/brands";
import { cn } from "@/lib/utils";
import { CANCELLED, DELETED_TEXT, Trame } from "@/api";
import { AttachmentLimits, DraftItem, FactCheck, FactClaim, MeetingLink, MessageHit, MessageRef, PendingFile, REACTIONS, Reaction, ThreadMessage, WatchEntity } from "@/types";
import { acceptOf, addFiles, humanSize, limitsShort, limitsText, pastedFiles } from "@/lib/attachments";
import type { BriefTarget } from "@/components/BriefSheet";

const KIND = { dm: "Conversation privée", group: "Groupe", channel: "Canal" } as const;
// Messages chargés à l'ouverture, puis à chaque remontée ; plafond du moteur.
const PAGE = 30;
const MAX = 500;

/** Clés stables : charger l'historique ajoute des messages en tête sans redessiner les autres. */
function keysOf(messages: ThreadMessage[]): string[] {
  // Doublons numérotés depuis la fin : un ajout en tête ne décale pas leur numéro.
  const seen = new Map<string, number>();
  return [...messages]
    .reverse()
    .map((m) => {
      const k = `${m.at}|${m.sender}|${m.text.slice(0, 40)}`;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return `${k}#${n}`;
    })
    .reverse();
}

/** Bouton-icône : `label` est son nom accessible, `hint` (s'il diffère) l'explication en infobulle. */
function IconAction({ label, hint, onClick, disabled, pressed, children }: { label: string; hint?: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button variant="ghost" size="icon" className="size-8 rounded-full text-muted-foreground hover:text-foreground" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}

/** Position du message trouvé dans le fil affiché (le plus récent s'il revient), -1 sinon. */
function foundAt(shown: ThreadMessage[], found: MessageHit | null): number {
  if (!found) return -1;
  const text = fold(found.text);
  for (let i = shown.length - 1; i >= 0; i--) {
    if (fold(shown[i].text) === text && (shown[i].sender === found.sender || shown[i].mine === found.mine)) return i;
  }
  return -1;
}

const EMOJI = Object.fromEntries(REACTIONS.map((r) => [r.key, r.emoji])) as Record<Reaction, string>;
const refOf = (m: ThreadMessage): MessageRef => ({ id: m.id ?? null, sender: m.sender, text: m.text, at: m.at });
const sameRef = (a: MessageRef | null, b: ThreadMessage) =>
  Boolean(a) && (a!.id && b.id ? a!.id === b.id : a!.text === b.text && a!.sender === b.sender);
/** Le message à qui proposer une réponse : une image ou un fichier seul est nommé
 *  comme le moteur le lit (« [image] », « [fichier joint : nom] »). */
const proposalRef = (m: ThreadMessage): MessageRef => {
  const named = [
    ...(m.files ?? []).map((f) => `[fichier joint : ${f.name}]`),
    ...(m.images ?? []).map(() => "[image]"),
    ...(m.cards ?? []).map((c) => `[aperçu ${c.source} : ${c.title}]`),
  ];
  return { ...refOf(m), text: m.text.trim() || named.join("\n") };
};
/** « Modifié », comme Teams à côté de l'heure d'un message modifié après l'envoi. */
const Edited = () => <span title="Message modifié après l'envoi">Modifié</span>;
const excerpt = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
/** Citation d'un message, dans le fil ou au-dessus de la zone de saisie (comme une réponse Teams). */
function Quote({ target, className, children }: { target: MessageRef; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 rounded-lg border-l-2 border-link/60 bg-background/60 px-2.5 py-1.5 text-xs", className)}>
      <div className="min-w-0 flex-1">
        <span className="font-medium">{target.sender || "Message"}</span>
        {target.at && <span className="ml-1.5 text-muted-foreground tabular-nums">{target.at}</span>}
        <p className="line-clamp-2 text-muted-foreground">
          <MessageText text={target.text} interactive={false} />
        </p>
      </div>
      {children}
    </div>
  );
}

/** Écrit dans le presse-papiers. L'API Clipboard peut être refusée (permission de la
 *  WebView) : repli sur une zone de texte temporaire et la commande « copier ». */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    const before = document.activeElement as HTMLElement | null;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    before?.focus?.();
    return ok;
  }
}

/** Copie le texte d'un message ; « copié » s'affiche un instant à la place de l'icône. */
function CopyButton({ text, separated }: { text: string; separated: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await copyText(text))) return void toast.error("Copie impossible", { description: "Le presse-papiers n'est pas accessible." });
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={copied ? "Message copié" : "Copier le message"}
          onClick={copy}
          className={cn(
            "grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
            separated && "ml-0.5 border-l",
            copied && "text-success hover:text-success"
          )}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copié" : "Copier"}</TooltipContent>
    </Tooltip>
  );
}

/** Barre de gestes au survol d'un message : le petit jeu de réactions Teams, « Répondre »,
 *  « Proposer une réponse à ce message » (le cerveau, jamais d'envoi), « Copier » (toujours
 *  là, il ne passe pas par Teams) et, sur tes messages, « Supprimer ». */
function MessageActions({
  message,
  canReact,
  canReply,
  canDelete,
  propose,
  pending,
  onReact,
  onReply,
  onPropose,
  onDelete,
}: {
  message: ThreadMessage;
  canReact: boolean;
  canReply: boolean;
  canDelete: boolean;
  /** « Proposer une réponse à ce message » : null si absent ; `blocked` dit pourquoi il est inactif. */
  propose: { busy: boolean; blocked: string | null } | null;
  pending: Reaction | null;
  onReact: (r: Reaction) => void;
  onReply: () => void;
  onPropose: () => void;
  onDelete: () => void;
}) {
  const canCopy = Boolean(message.text.trim()) && !message.deleted;
  if (!canReact && !canReply && !propose && !canCopy && !canDelete) return null;
  const mine = message.reactions ?? [];
  return (
    <div
      role="toolbar"
      aria-label={`Gestes sur le message de ${message.sender}`}
      className={cn(
        "absolute -top-4 right-2 z-10 flex items-center gap-0.5 rounded-full border bg-popover p-0.5 shadow-sm transition-opacity",
        pending || propose?.busy ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      )}
    >
      {canReact &&
        REACTIONS.map((r) => (
          <Tooltip key={r.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={mine.includes(r.key) ? `Retirer la réaction : ${r.label}` : `Réagir : ${r.label}`}
                aria-pressed={mine.includes(r.key)}
                disabled={Boolean(pending)}
                onClick={() => onReact(r.key)}
                className={cn(
                  "grid size-7 place-items-center rounded-full text-base leading-none transition-transform hover:scale-125 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:hover:scale-100",
                  mine.includes(r.key) && "bg-primary/10"
                )}
              >
                {pending === r.key ? <Loader2 className="size-3.5 animate-spin" /> : r.emoji}
              </button>
            </TooltipTrigger>
            <TooltipContent>{mine.includes(r.key) ? `${r.label} · cliquer pour retirer` : r.label}</TooltipContent>
          </Tooltip>
        ))}
      {canReply && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Répondre à ce message de ${message.sender}`}
              disabled={Boolean(pending)}
              onClick={onReply}
              className={cn("grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", canReact && "ml-0.5 border-l")}
            >
              <Reply className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Répondre à ce message</TooltipContent>
        </Tooltip>
      )}
      {propose && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* aria-disabled plutôt que disabled : l'infobulle reste lisible et dit pourquoi. */}
            <button
              type="button"
              aria-label={message.mine ? "Proposer une relance de ce message" : "Proposer une réponse à ce message"}
              aria-disabled={Boolean(pending) || Boolean(propose.blocked) || propose.busy}
              aria-busy={propose.busy}
              data-testid="propose-on-message"
              onClick={() => !pending && !propose.blocked && !propose.busy && onPropose()}
              className={cn(
                "grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                canReact && !canReply && "ml-0.5 border-l",
                propose.busy && "text-primary",
                (propose.blocked || pending) && !propose.busy && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground"
              )}
            >
              {propose.busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {propose.busy
              ? "Proposition en cours…"
              : propose.blocked ?? (message.mine ? "Proposer une relance ou un complément à ce message" : "Proposer une réponse à ce message")}
          </TooltipContent>
        </Tooltip>
      )}
      {canCopy && <CopyButton text={message.text} separated={canReact && !canReply && !propose} />}
      {canDelete && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Supprimer ce message"
              disabled={Boolean(pending)}
              onClick={onDelete}
              className="ml-0.5 grid size-7 place-items-center rounded-full border-l text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Trash2 className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Supprimer ce message</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** Une discussion : historique lu dans Teams, réponse proposée pré-remplie, envoi à la main. */
export function DiscussionView({
  trame,
  conversation: c,
  draft,
  found = null,
  onBrief,
  reflectionOpen = false,
  onReflection,
  autoReflection = false,
  favorite = false,
  onFavorite,
}: {
  trame: Trame;
  conversation: WatchEntity;
  draft: DraftItem | null;
  /** Message trouvé par la recherche : la discussion s'ouvre dessus, surligné. */
  found?: MessageHit | null;
  onBrief: (t: BriefTarget) => void;
  /** Panneau Réflexion (ce que fait le modèle pendant une action) ouvert à droite. */
  reflectionOpen?: boolean;
  onReflection?: (open: boolean) => void;
  /** Ouvrir la réflexion à chaque action (fenêtre assez large pour le panneau ancré). */
  autoReflection?: boolean;
  /** En favori : épinglée en haut de la liste (étoile de l'en-tête, Alt+F). */
  favorite?: boolean;
  onFavorite?: () => void;
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  // Conversation de réunion : son lien, pour « Rejoindre dans Teams » (null sinon).
  const [meeting, setMeeting] = useState<MeetingLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  // La réponse proposée n'entre pas d'office dans la zone de saisie : elle s'y montre
  // en texte fantôme tant que la zone est vide, et Tab (ou le badge) l'y fait entrer.
  const [text, setText] = useState("");
  const [ghost, setGhost] = useState(draft?.proposal ?? "");
  // Échap masque la proposition ; la moindre frappe la rend au prochain champ vide.
  const [ghostHidden, setGhostHidden] = useState(false);
  const [busy, setBusy] = useState<"idle" | "send" | "suggest" | "dismiss" | "correct">("idle");
  // Correction proposée, à accepter ou rejeter ; puis de quoi l'annuler tant que le texte n'a pas bougé.
  const [review, setReview] = useState<{ before: string; after: string } | null>(null);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const [fresher, setFresher] = useState<string | null>(null);
  // Fil complet : `edge` dit pourquoi on ne remonte plus (début de la conversation, ou
  // limite de ce que Trame peut relire d'un coup), `older` pendant qu'on remonte.
  // `want` : combien de messages le fil affiche.
  const [edge, setEdge] = useState<"start" | "limit" | null>(null);
  const [older, setOlder] = useState(false);
  const want = useRef(PAGE);
  const loading = useRef(false);
  // Réponse à un message précis (citation Teams), et réaction en cours d'envoi.
  const [replyTo, setReplyTo] = useState<MessageRef | null>(null);
  // Vérification des faits : à part de `busy`, elle ne bloque jamais l'envoi.
  const [check, setCheck] = useState<{ result: FactCheck; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [reacting, setReacting] = useState<{ index: number; reaction: Reaction } | null>(null);
  // Message dont la proposition est en cours (« Proposer une réponse à ce message »).
  const [proposingFor, setProposingFor] = useState<MessageRef | null>(null);
  // Suppression d'un de tes messages : à confirmer dans un dialogue, jamais en un clic.
  const [toDelete, setToDelete] = useState<ThreadMessage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const caps = trame.state.capabilities;
  const composer = useRef<HTMLTextAreaElement>(null);
  // Mentions : personnes choisies dans les suggestions « @ », et la liste ouverte.
  const [chosen, setChosen] = useState<string[]>([]);
  const [mentioning, setMentioning] = useState<{ at: number; query: string; index: number } | null>(null);
  const [entourage, setEntourage] = useState<string[]>([]);
  // `base` : la proposition acceptée telle quelle dans la zone (vide sinon) ;
  // `seen` : la dernière proposition du moteur déjà prise en compte.
  const base = useRef("");
  const seen = useRef(draft?.proposal ?? "");
  const ghostId = useId();
  const controls = useAnimationControls();
  const scroller = useRef<StickToBottomContext>(null);
  const foundRef = useRef<HTMLDivElement>(null);
  // Pièces jointes : seulement des fichiers que l'utilisateur choisit ici (bouton ou
  // glisser-déposer), envoyés par son clic sur Envoyer. Le mode Auto n'en joint jamais.
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [limits, setLimits] = useState<AttachmentLimits | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const load = async (fresh = false) => {
    setError(null);
    if (fresh) setMessages(null);
    const res = await trame.threadMessages(c.threadId, fresh, want.current);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    setMessages(res.messages);
    setMeeting(res.meeting);
    if (res.top) setEdge("start");
    return true;
  };

  // Lu dans Trame, lu dans Teams : la conversation n'y reste pas en non-lu et tes
  // collègues voient que tu l'as lue. Seulement quand le fil est affiché sous tes yeux ;
  // un échec est noté dans le Journal, sans gêner la lecture.
  const markRead = () => {
    if (document.hasFocus()) void trame.markRead(c.threadId);
  };

  const loadOlder = async () => {
    if (loading.current || edge || messages === null) return;
    loading.current = true;
    setOlder(true);
    want.current = Math.min(MAX, want.current + PAGE);
    const res = await trame.threadMessages(c.threadId, false, want.current);
    loading.current = false;
    setOlder(false);
    if (!res.ok) return toast.error("Historique indisponible", { description: res.error });
    // Rien de plus ancien revenu : Teams n'en charge pas davantage dans le temps imparti.
    const gained = res.messages.length > (messages?.length ?? 0);
    setMessages(res.messages);
    setMeeting(res.meeting);
    setEdge(res.top ? "start" : !gained || want.current >= MAX ? "limit" : null);
  };

  useEffect(() => {
    let live = true;
    trame.attachmentLimits().then((r) => live && setLimits(r.ok ? r.limits : null));
    return () => {
      live = false;
    };
  }, [trame.connected]);

  useEffect(() => {
    setMessages(null);
    setMeeting(null);
    setFiles([]);
    setText("");
    setGhost(draft?.proposal ?? "");
    setGhostHidden(false);
    base.current = "";
    seen.current = draft?.proposal ?? "";
    setFresher(null);
    setReview(null);
    setUndo(null);
    // Une réponse préparée pour un message précis arrive avec sa citation (retirable).
    setReplyTo(caps.reply && draft?.replyTo ? draft.replyTo : null);
    setCheck(null);
    setReacting(null);
    setEdge(null);
    want.current = PAGE;
    const unread = c.unread;
    load().then((ok) => ok && unread && markRead());
  }, [c.threadId]);

  // Fil vivant : la conversation se relit dès qu'elle change, sans perdre l'historique
  // déjà remonté : message reçu (suivie ou non), mais aussi réponse envoyée par Trame
  // lui-même (mode Auto, file d'envoi, brouillon), qui sinon n'apparaissait qu'au
  // message reçu suivant.
  const version = trame.state.threadUpdates[c.threadId] ?? 0;
  const seenVersion = useRef(version);
  const lastNotice = trame.state.notices.find((n) => n.threadId === c.threadId)?.id ?? "";
  const seenNotice = useRef(lastNotice);
  useEffect(() => {
    if (version === seenVersion.current) return;
    seenVersion.current = version;
    const received = lastNotice !== seenNotice.current;
    seenNotice.current = lastNotice;
    // Lu dans Teams seulement pour un message reçu, pas pour sa propre réponse.
    load().then((ok) => ok && received && lastNotice && markRead());
  }, [version, lastNotice]);

  // Remonter en haut du fil charge les messages plus anciens.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || edge || messages === null) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && loadOlder(), { rootMargin: "120px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [edge, messages === null, c.threadId]);

  // Toute nouvelle proposition remplace le texte fantôme. Elle remplace aussi une
  // proposition déjà acceptée et pas retouchée ; jamais un texte que tu as écrit,
  // à qui elle est seulement offerte (« Utiliser »).
  const offer = (next: string) => {
    setGhost(next);
    setGhostHidden(false);
    if (!text) return;
    if (text.trim() === base.current.trim()) {
      setText(next);
      base.current = next;
    } else if (next) setFresher(next);
  };

  // Nouveau message pendant la lecture : la proposition suit, sans écraser ton texte.
  useEffect(() => {
    const next = draft?.proposal ?? "";
    if (next === seen.current) return;
    seen.current = next;
    offer(next);
  }, [draft?.proposal]);

  const showGhost = !text && !!ghost && !ghostHidden;
  // Tab ou le badge : la proposition devient ton message, curseur à la fin.
  const acceptGhost = () => {
    if (!showGhost) return;
    setText(ghost);
    base.current = ghost;
    setFresher(null);
    setReview(null);
    requestAnimationFrame(() => {
      const box = composer.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(ghost.length, ghost.length);
    });
  };

  // Annulée depuis le panneau Réflexion : l'utilisateur le sait déjà.
  const fail = (title: string, error: string) => {
    if (error === CANCELLED) return;
    controls.start(shake);
    toast.error(title, { description: error });
  };

  // Qui mentionner : ceux qui ont écrit dans le fil (membres sûrs de la conversation),
  // la personne d'une conversation privée, puis l'entourage. Teams vérifie à l'envoi.
  useEffect(() => {
    if (!caps.mentions) return;
    trame.listPeople().then((r) => r.ok && setEntourage(r.list.map((p) => p.name)));
  }, [caps.mentions]);
  const people = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (n?: string | null) => {
      const name = (n ?? "").replace(/\s+/g, " ").trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        out.push(name);
      }
    };
    [...(messages ?? [])].reverse().forEach((m) => !m.mine && add(m.sender));
    if (c.surface === "dm") add(c.displayName);
    entourage.forEach(add);
    return out;
  }, [messages, c.surface, c.displayName, entourage]);
  const suggestions = mentioning ? matchPeople(mentioning.query, people) : [];

  const followMention = (value: string, caret: number) => {
    if (!caps.mentions) return;
    const q = mentionQuery(value, caret);
    setMentioning(q ? { ...q, index: 0 } : null);
  };
  const chooseMention = (name: string) => {
    const box = composer.current;
    if (!mentioning || !box) return;
    const next = applyMention(text, box.selectionStart, mentioning.at, name);
    setText(next.text);
    setReview(null);
    setChosen((list) => (list.includes(name) ? list : [...list, name]));
    setMentioning(null);
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(next.caret, next.caret);
    });
  };
  // Clavier dans la liste ouverte : vrai si la touche a été prise par la liste.
  const mentionKey = (e: React.KeyboardEvent) => {
    if (!mentioning) return false;
    const n = suggestions.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setMentioning({ ...mentioning, index: (mentioning.index + step + n) % n });
    } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
      chooseMention(suggestions[Math.min(mentioning.index, n - 1)]);
    } else if (e.key === "Escape") {
      setMentioning(null);
    } else return false;
    e.preventDefault();
    return true;
  };

  const canAttach = Boolean(limits?.canAttach);
  const attachHint = !limits
    ? "Pièces jointes indisponibles : moteur injoignable"
    : !limits.canAttach
      ? `Pièces jointes indisponibles : ${limits.unsupported ?? "pilote Teams sans pièces jointes"}`
      : `Joindre un fichier, ou Ctrl+V d'une capture. ${limitsText(limits)}`;

  const pick = async (picked: File[]) => {
    if (!limits?.canAttach || !picked.length || busy === "send") return;
    const res = await addFiles(files, picked, limits);
    setFiles(res.files);
    if (res.refused.length) toast.error("Fichier refusé", { description: `${res.refused.join(" ; ")}. Accepté : ${limitsText(limits)}.` });
  };

  const send = async (force = false) => {
    const body = text.trim();
    if ((!body && !files.length) || busy !== "idle" || review) return;
    setBusy("send");
    const target = replyTo;
    const mentions = caps.mentions ? mentionsUsed(body, chosen) : [];
    const res = draft
      ? await trame.sendDraft(draft.id, body, target, mentions, files, force)
      : await trame.sendInThread(c.threadId, body, target, mentions, files, force);
    setBusy("idle");
    if (!res.ok) {
      const kept = files.length ? "Ton message et tes fichiers sont conservés." : "Ton message est conservé.";
      // Le même envoi, resté « non confirmé », est déjà dans le fil : rien n'est renvoyé
      // sans que l'utilisateur le demande.
      if (res.code === "maybe_sent") {
        return void toast.warning(`Déjà envoyé à ${c.displayName} ?`, {
          description: `${res.error} ${kept}`,
          duration: 20000,
          action: { label: "Renvoyer quand même", onClick: () => void send(true) },
        });
      }
      // Quelque chose occupe déjà la zone de saisie dans Teams (reste d'un envoi raté,
      // brouillon tapé dans Teams) : tant qu'il y est, aucun envoi ne passe. On propose
      // de la vider, en le disant.
      if (/zone de saisie non vide/.test(res.error)) {
        controls.start(shake);
        return void toast.error(`Envoi impossible à ${c.displayName}`, {
          description: `${res.error} ${kept}`,
          duration: 15000,
          action: {
            label: "Vider dans Teams",
            onClick: async () => {
              const r = await trame.clearCompose(c.threadId);
              if (r.ok) toast.success("Zone de saisie vidée dans Teams", { description: "Tu peux renvoyer ton message." });
              else toast.error("Zone de saisie non vidée", { description: r.error });
            },
          },
        });
      }
      return fail(`Envoi impossible à ${c.displayName}`, `${res.error} ${kept}`);
    }
    if (draft) trame.removeDraft(draft.id);
    if (res.queued) {
      // Teams pas prêt : le message attend dans la file (affichée en bas du fil) et partira seul.
      toast.info("Message en file d'envoi", { description: `${res.queued.reason}. Il partira dès que Teams est prêt.` });
    } else {
      const shownText = [body, ...files.map((f) => `Pièce jointe : ${f.name}`)].filter(Boolean).join("\n");
      setMessages((m) => [...(m ?? []), { sender: "Toi", text: shownText, at: "à l'instant", mine: true, replyTo: target }]);
    }
    setText("");
    setGhost("");
    setFiles([]);
    setReplyTo(null);
    setChosen([]);
    setCheck(null);
    setUndo(null);
    base.current = "";
  };

  // Un clic sur une réaction déjà mise la retire (comme dans Teams) ; l'état voulu est
  // envoyé explicitement au moteur, qui ne bascule jamais à l'aveugle.
  const react = async (m: ThreadMessage, index: number, reaction: Reaction) => {
    if (reacting) return;
    const remove = (m.reactions ?? []).includes(reaction);
    setReacting({ index, reaction });
    const res = await trame.reactInThread(c.threadId, refOf(m), reaction, remove);
    setReacting(null);
    if (!res.ok) return toast.error(`${remove ? "Retrait de la réaction" : "Réaction"} ${EMOJI[reaction]} impossible`, { description: res.error });
    setMessages((list) =>
      (list ?? []).map((x, i) => {
        if (i !== index || x.text !== m.text) return x;
        const had = x.reactions ?? [];
        if (remove) return { ...x, reactions: had.filter((r) => r !== reaction) };
        return had.includes(reaction) ? x : { ...x, reactions: [...had, reaction] };
      })
    );
  };

  const deleteMessage = async () => {
    const m = toDelete;
    if (!m || deleting) return;
    setDeleting(true);
    const res = await trame.deleteInThread(c.threadId, refOf(m));
    setDeleting(false);
    if (!res.ok) return void toast.error("Message non supprimé", { description: res.error });
    setToDelete(null);
    if (sameRef(replyTo, m)) setReplyTo(null);
    setMessages((list) =>
      (list ?? []).map((x) =>
        sameRef(refOf(m), x) ? { ...x, text: DELETED_TEXT, deleted: true, reactions: [], files: [], images: [] } : x
      )
    );
    toast.success("Message supprimé dans Teams");
  };

  const replyToMessage = (m: ThreadMessage) => {
    setReplyTo(refOf(m));
    requestAnimationFrame(() => composer.current?.focus());
  };

  const dismiss = async () => {
    if (!draft) return;
    setBusy("dismiss");
    const res = await trame.dismissDraft(draft.id);
    setBusy("idle");
    if (!res.ok) return fail("Impossible d'ignorer la réponse proposée", res.error);
    setText("");
    setGhost("");
    base.current = "";
  };

  const reflect = () => {
    if (autoReflection) onReflection?.(true);
  };

  const suggest = async (target: MessageRef | null = replyTo, mine = false) => {
    setBusy("suggest");
    reflect();
    const res = await trame.suggestInThread(c.threadId, target, { mine });
    setBusy("idle");
    setProposingFor(null);
    if (!res.ok) return fail("Proposition impossible", res.error);
    offer(res.text);
  };

  // « Proposer une réponse à ce message » : la réponse citée est préparée sur ce message
  // (quand Teams sait citer) et le cerveau rédige pour lui. Rien ne part sans ton envoi.
  const proposeOn = (m: ThreadMessage) => {
    if (busy !== "idle") return;
    if (caps.reply) setReplyTo(refOf(m));
    setProposingFor(refOf(m));
    requestAnimationFrame(() => composer.current?.focus());
    void suggest(proposalRef(m), m.mine);
  };
  // Pourquoi « Proposer » est inactif sur un message, null s'il est prêt.
  const proposeBlocked = !trame.connected && !trame.demoMode
    ? "Cerveau indisponible : le moteur de Trame est injoignable"
    : busy === "suggest"
      ? "Une proposition est déjà en cours"
      : busy !== "idle"
        ? "Attends la fin de l'action en cours"
        : null;

  const verify = async () => {
    const body = text.trim();
    if (!body || checking) return;
    setChecking(true);
    reflect();
    const res = await trame.checkInThread(c.threadId, body, replyTo);
    setChecking(false);
    if (!res.ok) return res.error === CANCELLED ? undefined : toast.error("Vérification impossible", { description: res.error });
    setCheck({ result: res.check, text: body });
  };

  const applyFix = (claim: FactClaim) => {
    if (!claim.fix || !text.includes(claim.excerpt)) return;
    setText(text.replace(claim.excerpt, claim.fix));
    setReview(null);
  };

  // Corrige sans jamais envoyer : le résultat attend ton accord.
  const correct = async () => {
    const before = text;
    if (!before.trim() || busy !== "idle") return;
    setBusy("correct");
    reflect();
    const res = await trame.correctText(before, c.threadId);
    setBusy("idle");
    if (!res.ok) return fail("Correction impossible", res.error);
    if (!res.changed) return toast.success("Rien à corriger", { description: "Ton message est déjà propre." });
    setReview({ before, after: res.text });
  };

  const acceptCorrection = () => {
    if (!review) return;
    setText(review.after);
    setUndo(review);
    setReview(null);
    requestAnimationFrame(() => composer.current?.focus());
  };

  const undoCorrection = () => {
    if (!undo) return;
    setText(undo.before);
    setUndo(null);
  };

  // Vidéo reçue : lien de téléchargement direct, résolu dans la page Teams pour cette conversation.
  const fileLink = (url: string) => trame.fileLink(url, c.threadId);
  const openInTeams = async () => {
    const res = await trame.showInTeams(c.threadId);
    if (!res.ok) toast.error("Ouverture dans Teams impossible", { description: res.error });
  };

  const shown: ThreadMessage[] =
    messages ?? (draft ? [{ sender: draft.from, text: draft.incoming, at: draft.receivedAt, mine: false }] : []);
  const keys = keysOf(shown);
  const foundIndex = foundAt(shown, found);
  // La recherche dans l'excerpt surligne la même plage dans le message entier.
  const foundQuery = found?.match ? found.excerpt.slice(found.match[0], found.match[1]) : "";
  // Séparateurs de jour et séries d'un même auteur (heure Teams telle qu'affichée).
  const rows = layoutThread(shown);
  // Projets Jira liés dans le fil : leurs clés seules (« ALL-94 ») deviennent des pastilles.
  const jira = useMemo(() => {
    const urls: string[] = [];
    for (const m of messages ?? []) {
      urls.push(...(m.text.match(/https?:\/\/\S+/g) ?? []), ...(m.links ?? []).map((l) => l.url), ...(m.cards ?? []).map((c) => c.url));
    }
    return jiraBases(urls);
  }, [messages]);
  const timeline: TimelineItem[] = shown.map((m, i) => ({
    key: keys[i],
    sender: m.sender,
    mine: m.mine,
    at: m.at,
    head: rows[i].head,
    preview: m.deleted ? DELETED_TEXT : m.text || [...(m.files ?? []).map((f) => f.name), ...(m.images ?? []).map(() => "Image")].join(", "),
  }));
  const scrollEl = useCallback(() => scroller.current?.scrollRef.current ?? null, []);
  // Saut depuis la chronologie : le message au centre, un bref halo pour le retrouver.
  // Saut immédiat : un défilement animé serait repris par l'accroche en bas du fil.
  const jump = useCallback((key: string) => {
    const box = scroller.current?.scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-msg-key="${CSS.escape(key)}"]`);
    if (!el) return;
    scroller.current?.stopScroll();
    el.scrollIntoView({ block: "center" });
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) el.animate([{ backgroundColor: "color-mix(in oklab, var(--link) 14%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }, []);

  useEffect(() => {
    if (foundIndex < 0) return;
    scroller.current?.stopScroll();
    foundRef.current?.scrollIntoView({ block: "center" });
  }, [found, foundIndex, messages]);
  const edited = !!text && text.trim() !== base.current.trim();
  const status = !text
    ? ghost
      ? ghostHidden
        ? "Réponse proposée · masquée"
        : "Réponse proposée"
      : "Réponse proposée · ignorée"
    : edited
      ? "Ta réponse · modifiée"
      : "Réponse proposée · modifiable";
  const showFresher = !!fresher && !!text && fresher.trim() !== text.trim();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-5 py-3">
        <InitialsAvatar name={c.displayName} presence={c.presence} className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{c.displayName}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[meeting ? (meeting.live ? "Réunion en cours" : "Conversation de réunion") : KIND[c.surface], c.presence && PRESENCE[c.presence]?.label, draft?.senderLabel].filter(Boolean).join(" · ")}
          </span>
        </div>
        <JoinMeeting meeting={meeting} />
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <AutoToggle
              name={c.displayName}
              mode={c.watch ? c.mode : "draft"}
              onChange={(v) => trame.setAuto(c.threadId, v === "auto").then((r) => !r.ok && toast.error("Modification impossible", { description: r.error }))}
            />
            {onFavorite && (
              <IconAction label={favorite ? "Retirer des favoris" : "Ajouter aux favoris"} hint={`${favorite ? "Retirer des favoris" : "Épingler en haut de la liste, dans Favoris"} · Alt+F`} pressed={favorite} onClick={onFavorite}>
                <Star className={cn("size-4", favorite && "fill-warning text-warning")} />
              </IconAction>
            )}
            {onReflection && (
              <IconAction label={reflectionOpen ? "Masquer la réflexion du modèle" : "Réflexion du modèle"} onClick={() => onReflection(!reflectionOpen)}>
                <Brain className="size-4" />
              </IconAction>
            )}
            <IconAction label="Résumé de la conversation" disabled={!trame.briefPrefs.enabled} onClick={() => onBrief({ threadId: c.threadId, displayName: c.displayName })}>
              <BookOpenText className="size-4" />
            </IconAction>
            <IconAction label="Relire depuis Teams" onClick={() => load(true)}>
              <RotateCcw className="size-4" />
            </IconAction>
            <IconAction label="Ouvrir dans Teams" onClick={openInTeams}>
              <ExternalLink className="size-4" />
            </IconAction>
          </div>
        </div>
      </header>

      {found && messages !== null && foundIndex < 0 && (
        <div className="flex items-center justify-center gap-2 border-b bg-muted/40 px-5 py-2 text-center text-xs text-muted-foreground">
          <SearchX className="size-3.5 shrink-0" />
          <span className="min-w-0">
            Le message trouvé ({found.at || "sans heure"}) est plus ancien que ceux affichés ici :
            « <Highlight text={found.excerpt} range={found.match} /> »
          </span>
          <button type="button" className="shrink-0 font-medium text-link hover:underline" onClick={openInTeams}>
            Voir dans Teams
          </button>
        </div>
      )}

      <StickToBottom contextRef={scroller} className="relative min-h-0 flex-1" resize="smooth" initial={found ? false : "instant"}>
        {messages !== null && <ScrollTimeline items={timeline} scrollEl={scrollEl} onJump={jump} className="max-sm:hidden" />}
        <StickToBottom.Content className="mx-auto flex w-full max-w-3xl flex-col px-5 py-5 sm:px-12">
          {error && !draft ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => load(true)}>
                <RotateCcw className="size-4" /> Réessayer
              </Button>
            </div>
          ) : messages === null && !draft ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Lecture de la conversation dans Teams…
            </div>
          ) : shown.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Aucun message lisible dans cette conversation.</p>
          ) : (
            <>
              {messages === null && draft && (
                <span className="flex items-center justify-center gap-2 pb-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Historique en cours de lecture…
                </span>
              )}
              {messages !== null && (
                <div ref={sentinel} className="flex justify-center pb-2 text-xs text-muted-foreground">
                  {edge === "start" ? (
                    <span>Début de la conversation</span>
                  ) : edge === "limit" ? (
                    <button type="button" className="rounded-full px-3 py-1 hover:bg-muted hover:text-foreground" onClick={openInTeams}>
                      Plus ancien : ouvrir dans Teams
                    </button>
                  ) : older ? (
                    <span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Messages plus anciens…</span>
                  ) : (
                    <button type="button" className="rounded-full px-3 py-1 hover:bg-muted hover:text-foreground" onClick={loadOlder}>
                      Messages plus anciens
                    </button>
                  )}
                </div>
              )}
              {shown.map((m, i) => {
                const row = rows[i];
                // Pas de geste sur un message pas encore relu dans Teams, ni sur ce que tu viens d'envoyer.
                const live = messages !== null && m.at !== "à l'instant" && !m.deleted;
                const canReact = live && caps.react && !m.mine;
                const canReply = live && caps.reply;
                // Seulement tes messages, connus de Teams par leur identifiant.
                const canDelete = live && caps.delete && m.mine && Boolean(m.id);
                const canPropose = live && Boolean(m.text.trim() || m.files?.length || m.images?.length);
                const targeted = sameRef(replyTo, m);
                const isFound = i === foundIndex;
                const pending = reacting?.index === i ? reacting.reaction : null;
                const edited = Boolean(m.edited && !m.deleted);
                const body = m.deleted ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground italic">
                    <Ban className="size-3.5 shrink-0" />
                    {DELETED_TEXT}
                  </span>
                ) : (
                  <>
                    {(m.replyTo || m.quote) && <Quote target={(m.replyTo || m.quote)!} />}
                    <MessageText
                      text={m.text}
                      links={m.links}
                      mentions={m.mentions}
                      jira={jira}
                      rich
                      range={isFound ? findFolded(m.text, foundQuery) : null}
                      github={trame.githubLink}
                    />
                    <LinkCards cards={m.cards} />
                  </>
                );
                const reactions = (m.reactions?.length ?? 0) > 0 && (
                  <div className={cn("flex items-center gap-1", m.mine && "justify-end")}>
                    <AnimatePresence initial={false}>
                      {(m.reactions ?? []).map((r) => {
                        const label = REACTIONS.find((x) => x.key === r)?.label ?? r;
                        return (
                          <motion.button
                            key={r}
                            type="button"
                            initial={{ scale: 0.4, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.4, opacity: 0 }}
                            transition={{ type: "spring", stiffness: 500, damping: 22 }}
                            title={canReact ? `Tu as réagi : ${label} · cliquer pour retirer` : `Tu as réagi : ${label}`}
                            aria-label={`Retirer la réaction : ${label}`}
                            disabled={!canReact || Boolean(reacting)}
                            onClick={() => react(m, i, r)}
                            className="rounded-full border border-primary/30 bg-primary/10 px-1.5 text-xs leading-5 enabled:hover:border-primary/60 enabled:hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
                          >
                            {pending === r ? <Loader2 className="inline size-3 animate-spin" /> : EMOJI[r]}
                          </motion.button>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                );
                return (
                  <Fragment key={keys[i]}>
                    {row.day && (
                      <div role="separator" aria-label={row.day} className="flex items-center gap-3 pt-6 pb-1 text-xs font-medium text-muted-foreground first:pt-2">
                        <span aria-hidden className="h-px flex-1 bg-border" />
                        <span aria-hidden>{row.day}</span>
                        <span aria-hidden className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <motion.div
                      data-msg-key={keys[i]}
                      ref={isFound ? foundRef : undefined}
                      aria-current={isFound ? "true" : undefined}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i, 10) * 0.02 }}
                      className={cn(
                        "group relative rounded-xl",
                        row.head ? (row.day ? "mt-2" : "mt-4") : "mt-0.5",
                        m.mine ? "flex flex-col items-end gap-1 pl-[20%]" : "-mx-2 grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-2 py-0.5",
                        !m.mine && isFound && "bg-warning/10 ring-1 ring-warning/50",
                        !m.mine && targeted && "bg-link/5 ring-1 ring-link/40"
                      )}
                    >
                      <MessageActions
                        message={m}
                        canReact={canReact}
                        canReply={canReply}
                        canDelete={canDelete}
                        propose={canPropose ? { busy: busy === "suggest" && sameRef(proposingFor, m), blocked: proposeBlocked } : null}
                        pending={pending}
                        onReact={(r) => react(m, i, r)}
                        onReply={() => replyToMessage(m)}
                        onPropose={() => proposeOn(m)}
                        onDelete={() => setToDelete(m)}
                      />
                      {m.mine ? (
                        <>
                          <div
                            title={row.tail ? undefined : m.at}
                            className={cn(
                              "flex max-w-full flex-col gap-1.5 rounded-2xl bg-muted px-3.5 py-2 text-sm leading-5 whitespace-pre-wrap",
                              isFound && "ring-2 ring-warning/70",
                              targeted && "ring-2 ring-link/50"
                            )}
                          >
                            {body}
                            <MessageAttachments files={m.files} images={m.images} sender={m.sender} onOpenTeams={openInTeams} onFileLink={fileLink} />
                          </div>
                          {reactions}
                          {((row.tail && m.at) || edited) && (
                            <span className="mr-1 text-xs text-muted-foreground tabular-nums">
                              {row.tail && m.at}
                              {row.tail && m.at && edited && " · "}
                              {edited && <Edited />}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          {row.head ? (
                            <InitialsAvatar name={m.sender} className="mt-0.5 size-8" />
                          ) : (
                            // Heure d'un message de la série : dans la marge, au survol.
                            <span className="pt-0.5 text-right text-[0.6875rem] leading-6 text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                              {row.time}
                            </span>
                          )}
                          <div className="flex min-w-0 flex-col gap-1.5">
                            {row.head && (
                              <div className="flex items-baseline gap-2 leading-tight">
                                <span className="truncate text-sm font-semibold">{m.sender}</span>
                                {m.at && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{m.at}</span>}
                                {edited && <span className="shrink-0 text-xs text-muted-foreground"><Edited /></span>}
                              </div>
                            )}
                            <div className="flex flex-col gap-1.5 text-sm leading-5 whitespace-pre-wrap">
                              {body}
                              <MessageAttachments files={m.files} images={m.images} sender={m.sender} onOpenTeams={openInTeams} onFileLink={fileLink} />
                            </div>
                            {edited && !row.head && <span className="text-xs text-muted-foreground"><Edited /></span>}
                            {reactions}
                          </div>
                        </>
                      )}
                    </motion.div>
                  </Fragment>
                );
              })}
              <div className="mt-4 flex flex-col gap-2 empty:hidden">
              <OutboxItems trame={trame} threadId={c.threadId} />
              <UndoAutoBar trame={trame} threadId={c.threadId} />
              <FollowUpCards trame={trame} threadId={c.threadId} />
              {messages !== null && <ThreadActivity trame={trame} conversation={c} last={shown[shown.length - 1]} />}
              </div>
            </>
          )}
        </StickToBottom.Content>
      </StickToBottom>

      <motion.div
        animate={controls}
        className={cn("border-t px-5 py-3 transition-colors", dragging && "bg-primary/5")}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = canAttach ? "copy" : "none";
          if (canAttach) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          setDragging(false);
          if (!canAttach) return void toast.error("Pièce jointe impossible", { description: attachHint });
          void pick(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {(draft || showFresher) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {draft && (
                <>
                  <span className={cn("size-1.5 rounded-full", edited ? "bg-link" : "bg-warning")} />
                  {status}
                </>
              )}
              {draft?.usedGithub && (
                <span className="ml-2 flex min-w-0 items-center gap-1 truncate">
                  <GithubLogo className="size-3.5 shrink-0" /> {draft.usedGithub}
                </span>
              )}
              <AnimatePresence initial={false}>
                {showFresher && (
                  <motion.span key="fresher" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="ml-auto flex items-center gap-1">
                    Nouvelle proposition
                    <Button size="sm" variant="ghost" className="h-6 rounded-full px-2 text-link" onClick={() => { setText(fresher!); base.current = fresher!; setFresher(null); }}>
                      Utiliser
                    </Button>
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          )}
          <AnimatePresence initial={false}>
            {replyTo && (
              <motion.div key="reply" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                <Quote target={replyTo} className="bg-muted/60">
                  <span className="sr-only">Réponse à ce message</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-6 shrink-0 rounded-full" aria-label="Ne plus répondre à ce message" onClick={() => setReplyTo(null)}>
                        <X className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Répondre à la conversation, sans citer</TooltipContent>
                  </Tooltip>
                </Quote>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {check && (
              <FactCheckPanel
                check={check.result}
                text={text}
                stale={text.trim() !== check.text}
                onFix={applyFix}
                onClose={() => setCheck(null)}
              />
            )}
            {review && (
              <motion.div
                key="review"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <section aria-label="Correction proposée" className="rounded-xl border border-link/30 bg-link/5 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <SpellCheck className="size-3.5" /> Correction proposée
                    <span className="font-normal">· barré : retiré, souligné : ajouté</span>
                  </div>
                  <p data-testid="correction-diff" className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {wordDiff(review.before, review.after).map((p, i) =>
                      p.kind === "same" ? (
                        <span key={i}>{p.text}</span>
                      ) : p.kind === "del" ? (
                        <del key={i} className="rounded-sm bg-destructive/10 text-destructive decoration-destructive/70">
                          {p.text}
                        </del>
                      ) : (
                        <ins key={i} title={p.text.includes("\u00a0") ? "Espace insécable ajoutée" : undefined} className="rounded-sm bg-success/15 text-success decoration-success/70 underline-offset-2">
                          {/* Une espace insécable ajoutée resterait invisible. */}
                          {p.text.replace(/\u00a0/g, "\u2423")}
                        </ins>
                      )
                    )}
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="ghost" size="sm" className="h-7 rounded-full" onClick={() => setReview(null)}>
                      <X className="size-3.5" /> Rejeter
                    </Button>
                    <Button size="sm" className="h-7 rounded-full" onClick={acceptCorrection}>
                      <Check className="size-3.5" /> Accepter
                    </Button>
                  </div>
                </section>
              </motion.div>
            )}
          </AnimatePresence>
          {undo && !review && text === undo.after && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <SpellCheck className="size-3.5" /> Correction appliquée
              <Button variant="ghost" size="sm" className="h-6 rounded-full px-2 text-link" onClick={undoCorrection}>
                <Undo2 className="size-3.5" /> Annuler
              </Button>
            </div>
          )}
          <div className="relative">
            <AnimatePresence>
              {mentioning && suggestions.length > 0 && (
                <motion.ul
                  key="mentions"
                  role="listbox"
                  aria-label="Mentionner"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  className="absolute bottom-full left-0 z-20 mb-1 w-72 overflow-hidden rounded-xl border bg-popover p-1 shadow-md"
                >
                  {suggestions.map((name, i) => (
                    <li
                      key={name}
                      role="option"
                      aria-selected={i === mentioning.index}
                      // mousedown : choisir avant que la zone de saisie ne perde le focus.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        chooseMention(name);
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                        i === mentioning.index ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                      )}
                    >
                      <InitialsAvatar name={name} className="size-6 text-[10px]" />
                      <span className="truncate">{name}</span>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
            {/* Une seule carte : la saisie, les pièces jointes et les actions. Le focus
                se lit sur la carte entière, pas sur la zone de texte seule. */}
            <div
              data-testid="composer"
              className={cn(
                "rounded-2xl border border-input bg-transparent shadow-xs transition-[color,box-shadow,border-color] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30",
                draft && "border-primary/30 bg-primary/5 dark:bg-primary/10",
                dragging && "border-dashed border-primary"
              )}
            >
            {/* Zone de saisie et texte fantôme dans la même case de grille : la zone
                grandit à la hauteur de la proposition, sur plusieurs lignes si besoin. */}
            <div className="grid [&>*]:col-start-1 [&>*]:row-start-1">
            <Textarea
              ref={composer}
              aria-label={replyTo ? `Réponse au message de ${replyTo.sender}` : `Message à ${c.displayName}`}
              placeholder={showGhost ? undefined : replyTo ? `Répondre à ${replyTo.sender || "ce message"}…` : `Écrire à ${c.displayName}…`}
              aria-describedby={showGhost ? ghostId : undefined}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setGhostHidden(false);
                // Le texte a changé : la correction affichée ne lui correspond plus.
                setReview(null);
                followMention(e.target.value, e.target.selectionStart);
              }}
              onClick={(e) => followMention(text, e.currentTarget.selectionStart)}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                setMentioning(null);
              }}
              onPaste={(e) => {
                // Ctrl+V d'une capture d'écran ou de fichiers copiés : ils rejoignent les
                // pièces jointes, comme par le trombone. Un texte collé reste un texte.
                const pasted = pastedFiles(e.clipboardData);
                if (!pasted.length) return;
                e.preventDefault();
                if (!canAttach) return void toast.error("Pièce jointe impossible", { description: attachHint });
                void pick(pasted);
              }}
              onKeyDown={(e) => {
                if (mentioning && suggestions.length && mentionKey(e)) return;
                // Entrée envoie, Maj+Entrée va à la ligne (pas pendant une saisie IME).
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && showGhost) {
                  // Sans proposition, ou zone non vide, Tab garde son rôle : passer au contrôle suivant.
                  e.preventDefault();
                  acceptGhost();
                } else if (e.key === "Escape" && replyTo) {
                  e.preventDefault();
                  setReplyTo(null);
                } else if (e.key === "Escape" && showGhost) {
                  e.preventDefault();
                  setGhostHidden(true);
                }
              }}
              disabled={busy === "send" || busy === "correct"}
              rows={2}
              className="field-sizing-content max-h-48 min-h-14 resize-none rounded-2xl border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            {showGhost && (
              <div
                id={ghostId}
                data-testid="ghost-proposal"
                // Mêmes bordure, marges et corps que la zone : le fantôme est à la place du texte.
                className="pointer-events-none z-10 max-h-48 overflow-hidden px-3 py-2 text-base break-words whitespace-pre-wrap text-muted-foreground md:text-sm"
              >
                <span className="sr-only">Réponse proposée, Tab pour l'utiliser : </span>
                {ghost}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  title="Utiliser la réponse proposée (Tab)"
                  // mousedown : garder le focus dans la zone de saisie.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptGhost();
                  }}
                  className="pointer-events-auto ml-1.5 inline-flex -translate-y-px cursor-pointer items-center gap-1 rounded border bg-background/80 px-1.5 align-middle font-sans text-[11px] leading-4 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  <span>⇥</span> Tab
                </button>
              </div>
            )}
            </div>
            {files.length > 0 && (
              <ul aria-label="Pièces jointes" className="flex flex-wrap gap-1.5 px-2.5 pb-1">
                {files.map((f) => (
                  <li key={f.id} className="flex max-w-64 items-center gap-1.5 rounded-full border bg-muted/50 py-0.5 pr-0.5 pl-2.5 text-xs">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={f.name}>{f.name}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{humanSize(f.size)}</span>
                    <button
                      type="button"
                      aria-label={`Retirer ${f.name}`}
                      disabled={busy === "send"}
                      className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                      onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* Outils de rédaction à gauche, en icônes ; décision à droite, Envoyer seul en plein. */}
            <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                accept={limits ? acceptOf(limits) : undefined}
                onChange={(e) => {
                  void pick(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <IconAction label={attachHint} disabled={!canAttach || busy === "send"} onClick={() => picker.current?.click()}>
                <Paperclip className="size-4" />
              </IconAction>
              <IconAction
                label="Corriger"
                hint="Corriger l'orthographe, la grammaire et la typographie, sans changer ton ton ni tes mots"
                disabled={busy !== "idle" || !text.trim() || !!review}
                onClick={correct}
              >
                {busy === "correct" ? <Loader2 className="size-4 animate-spin" /> : <SpellCheck className="size-4" />}
              </IconAction>
              <IconAction
                label="Vérifier"
                hint="Vérifier les dates, chiffres, noms et engagements contre le fil, l'entourage et GitHub. N'envoie rien."
                disabled={busy !== "idle" || checking || !text.trim()}
                onClick={verify}
              >
                {checking ? <Loader2 className="size-4 animate-spin" /> : <ListChecks className="size-4" />}
              </IconAction>
              {/* Rappel clavier : seulement pendant la saisie, là où il sert. */}
              <span
                aria-hidden
                className={cn(
                  // Hauteur d'une ligne : ce qui ne tient pas passe à la ligne, donc hors de vue.
                  "ml-2 hidden h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1 overflow-hidden text-xs text-muted-foreground transition-opacity duration-200 sm:flex [&>span]:flex [&>span]:items-center [&>span]:gap-1 [&>span]:whitespace-nowrap",
                  focused && !dragging ? "opacity-100" : "opacity-0"
                )}
              >
                <span><Kbd>Entrée</Kbd> envoyer</span>
                <span>· <Kbd>Maj</Kbd>+<Kbd>Entrée</Kbd> à la ligne</span>
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {draft && (
                  <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" disabled={busy !== "idle"} onClick={dismiss}>
                    Ignorer
                  </Button>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full"
                      aria-label={replyTo ? "Proposer une réponse à ce message" : draft ? "Autre proposition" : "Proposer une réponse"}
                      disabled={busy !== "idle"}
                      onClick={() => void suggest()}
                    >
                      {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />}
                      {draft && !replyTo ? "Autre proposition" : "Proposer"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{replyTo ? "Proposer une réponse à ce message" : draft ? "Proposer une autre réponse" : "Proposer une réponse dans ta voix"}</TooltipContent>
                </Tooltip>
                <Button size="sm" className="min-w-24 rounded-full" disabled={busy !== "idle" || (!text.trim() && !files.length) || !!review} onClick={() => send()}>
                  {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  Envoyer
                </Button>
              </div>
            </div>
            </div>
          </div>
          {dragging && limits && <p className="text-center text-xs text-primary">Dépose ici pour joindre · {limitsShort(limits)}</p>}
        </div>
      </motion.div>

      <Dialog open={toDelete !== null} onOpenChange={(open) => !open && !deleting && setToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Supprimer ce message ?</DialogTitle>
            <DialogDescription>
              Il sera supprimé dans Teams, pour toi et pour {c.surface === "dm" ? c.displayName : "tous les participants"}. Ils verront
              « {DELETED_TEXT} » à sa place.
            </DialogDescription>
          </DialogHeader>
          {toDelete && (
            <blockquote className="rounded-xl border-l-2 border-primary/40 bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
              {excerpt(toDelete.text, 240)}
              {toDelete.at && <span className="mt-1 block text-xs text-muted-foreground tabular-nums">{toDelete.at}</span>}
            </blockquote>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setToDelete(null)}>
              Annuler
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={deleteMessage}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
