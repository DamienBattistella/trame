import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { BookOpenText, ExternalLink, Loader2, PenLine, Reply, RotateCcw, SearchX, Send, X } from "lucide-react";
import { toast } from "sonner";
import { StickToBottom, type StickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InitialsAvatar, PRESENCE, Segment, shake } from "@/components/kit";
import { Highlight } from "@/components/MessageSearchResults";
import { findFolded, fold } from "@/lib/textSearch";
import { GithubLogo } from "@/brands";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { DraftItem, MessageHit, MessageRef, REACTIONS, Reaction, ThreadMessage, WatchEntity } from "@/types";
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

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label={label} disabled={disabled} onClick={onClick}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
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
const excerpt = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);

/** Citation d'un message, dans le fil ou au-dessus de la zone de saisie (comme une réponse Teams). */
function Quote({ target, className, children }: { target: MessageRef; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 rounded-lg border-l-2 border-link/60 bg-background/60 px-2.5 py-1.5 text-xs", className)}>
      <div className="min-w-0 flex-1">
        <span className="font-medium">{target.sender || "Message"}</span>
        {target.at && <span className="ml-1.5 text-muted-foreground tabular-nums">{target.at}</span>}
        <p className="line-clamp-2 text-muted-foreground">{excerpt(target.text, 160)}</p>
      </div>
      {children}
    </div>
  );
}

/** Barre de gestes au survol d'un message : le petit jeu de réactions Teams et « Répondre ». */
function MessageActions({
  message,
  canReact,
  canReply,
  pending,
  onReact,
  onReply,
}: {
  message: ThreadMessage;
  canReact: boolean;
  canReply: boolean;
  pending: Reaction | null;
  onReact: (r: Reaction) => void;
  onReply: () => void;
}) {
  if (!canReact && !canReply) return null;
  const mine = message.reactions ?? [];
  return (
    <div
      role="toolbar"
      aria-label={`Gestes sur le message de ${message.sender}`}
      className={cn(
        "absolute -top-4 z-10 flex items-center gap-0.5 rounded-full border bg-popover p-0.5 shadow-sm transition-opacity",
        message.mine ? "right-2" : "left-2",
        pending ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      )}
    >
      {canReact &&
        REACTIONS.map((r) => (
          <Tooltip key={r.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Réagir : ${r.label}`}
                aria-pressed={mine.includes(r.key)}
                disabled={Boolean(pending) || mine.includes(r.key)}
                onClick={() => onReact(r.key)}
                className={cn(
                  "grid size-7 place-items-center rounded-full text-base leading-none transition-transform hover:scale-125 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:hover:scale-100",
                  mine.includes(r.key) && "bg-primary/10"
                )}
              >
                {pending === r.key ? <Loader2 className="size-3.5 animate-spin" /> : r.emoji}
              </button>
            </TooltipTrigger>
            <TooltipContent>{mine.includes(r.key) ? `${r.label} · déjà mis` : r.label}</TooltipContent>
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
}: {
  trame: Trame;
  conversation: WatchEntity;
  draft: DraftItem | null;
  /** Message trouvé par la recherche : la discussion s'ouvre dessus, surligné. */
  found?: MessageHit | null;
  onBrief: (t: BriefTarget) => void;
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(draft?.proposal ?? "");
  const [busy, setBusy] = useState<"idle" | "send" | "suggest" | "dismiss">("idle");
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
  const [reacting, setReacting] = useState<{ index: number; reaction: Reaction } | null>(null);
  const caps = trame.state.capabilities;
  const composer = useRef<HTMLTextAreaElement>(null);
  const base = useRef(draft?.proposal ?? "");
  const controls = useAnimationControls();
  const scroller = useRef<StickToBottomContext>(null);
  const foundRef = useRef<HTMLDivElement>(null);

  const load = async (fresh = false) => {
    setError(null);
    if (fresh) setMessages(null);
    const res = await trame.threadMessages(c.threadId, fresh, want.current);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    setMessages(res.messages);
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
    setEdge(res.top ? "start" : !gained || want.current >= MAX ? "limit" : null);
  };

  useEffect(() => {
    setMessages(null);
    setText(draft?.proposal ?? "");
    base.current = draft?.proposal ?? "";
    setFresher(null);
    setReplyTo(null);
    setReacting(null);
    setEdge(null);
    want.current = PAGE;
    const unread = c.unread;
    load().then((ok) => ok && unread && markRead());
  }, [c.threadId]);

  // Fil vivant : tout message reçu dans cette conversation (suivie ou non) la fait
  // relire, sans perdre l'historique déjà remonté.
  const lastNotice = trame.state.notices.find((n) => n.threadId === c.threadId)?.id ?? "";
  const seenNotice = useRef(lastNotice);
  useEffect(() => {
    if (lastNotice === seenNotice.current) return;
    seenNotice.current = lastNotice;
    if (lastNotice) load().then((ok) => ok && markRead());
  }, [lastNotice]);

  // Remonter en haut du fil charge les messages plus anciens.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || edge || messages === null) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && loadOlder(), { rootMargin: "120px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [edge, messages === null, c.threadId]);

  // Nouveau message pendant la lecture : la proposition est mise à jour sans écraser ton texte.
  useEffect(() => {
    const next = draft?.proposal ?? "";
    if (next === base.current) return;
    if (text.trim() === base.current.trim()) setText(next);
    else if (next) setFresher(next);
    base.current = next;
  }, [draft?.proposal]);

  const fail = (title: string, error: string) => {
    controls.start(shake);
    toast.error(title, { description: error });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy !== "idle") return;
    setBusy("send");
    const target = replyTo;
    const res = draft ? await trame.sendDraft(draft.id, body, target) : await trame.sendInThread(c.threadId, body, target);
    setBusy("idle");
    if (!res.ok) return fail(`Envoi impossible à ${c.displayName}`, `${res.error} Ton message est conservé.`);
    if (draft) trame.removeDraft(draft.id);
    setMessages((m) => [...(m ?? []), { sender: "Toi", text: body, at: "à l'instant", mine: true, replyTo: target }]);
    setText("");
    setReplyTo(null);
    base.current = "";
  };

  const react = async (m: ThreadMessage, index: number, reaction: Reaction) => {
    if (reacting) return;
    setReacting({ index, reaction });
    const res = await trame.reactInThread(c.threadId, refOf(m), reaction);
    setReacting(null);
    if (!res.ok) return toast.error(`Réaction ${EMOJI[reaction]} impossible`, { description: res.error });
    setMessages((list) =>
      (list ?? []).map((x, i) =>
        i === index && x.text === m.text && !(x.reactions ?? []).includes(reaction) ? { ...x, reactions: [...(x.reactions ?? []), reaction] } : x
      )
    );
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
    base.current = "";
  };

  const suggest = async () => {
    setBusy("suggest");
    const res = await trame.suggestInThread(c.threadId, replyTo);
    setBusy("idle");
    if (!res.ok) return fail("Proposition impossible", res.error);
    setText(res.text);
  };

  const openInTeams = async () => {
    const res = await trame.showInTeams(c.threadId);
    if (!res.ok) toast.error("Ouverture dans Teams impossible", { description: res.error });
  };

  const shown: ThreadMessage[] =
    messages ?? (draft ? [{ sender: draft.from, text: draft.incoming, at: draft.receivedAt, mine: false }] : []);
  const keys = keysOf(shown);
  const foundIndex = foundAt(shown, found);
  // La recherche dans l'excerpt surligne la même plage dans le message entier.
  const foundQuery = found ? found.excerpt.slice(found.match[0], found.match[1]) : "";

  useEffect(() => {
    if (foundIndex < 0) return;
    scroller.current?.stopScroll();
    foundRef.current?.scrollIntoView({ block: "center" });
  }, [found, foundIndex, messages]);
  const edited = draft && text.trim() !== draft.proposal.trim();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-5 py-3">
        <InitialsAvatar name={c.displayName} presence={c.presence} className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{c.displayName}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[KIND[c.surface], c.presence && PRESENCE[c.presence]?.label, draft?.senderLabel].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id={`follow-${c.threadId}`}
              checked={c.watch}
              onCheckedChange={() => trame.toggleWatch(c.threadId).then((r) => !r.ok && toast.error("Modification impossible", { description: r.error }))}
            />
            <Label htmlFor={`follow-${c.threadId}`} className="font-normal">Suivie</Label>
          </div>
          <AnimatePresence initial={false}>
            {c.watch && (
              <motion.div key="mode" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}>
                <Segment
                  label={`Mode pour ${c.displayName}`}
                  value={c.mode}
                  onChange={(v) => trame.setMode(c.threadId, v).then((r) => !r.ok && toast.error("Modification impossible", { description: r.error }))}
                />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center">
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

      <StickToBottom contextRef={scroller} className="relative min-h-0 flex-1 overflow-y-auto" resize="smooth" initial={found ? false : "instant"}>
        <StickToBottom.Content className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 py-5">
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
              {found && messages !== null && foundIndex < 0 && (
                <p className="flex items-center justify-center gap-2 pb-2 text-center text-xs text-muted-foreground">
                  <SearchX className="size-3.5 shrink-0" />
                  Le message trouvé ({found.at || "sans heure"}) est plus ancien que ceux affichés ici.
                </p>
              )}
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
                const showName = !m.mine && c.surface !== "dm" && shown[i - 1]?.sender !== m.sender;
                // Pas de geste sur un message pas encore relu dans Teams, ni sur ce que tu viens d'envoyer.
                const live = messages !== null && m.at !== "à l'instant";
                const canReact = live && caps.react && !m.mine;
                const canReply = live && caps.reply;
                const targeted = sameRef(replyTo, m);
                const pending = reacting?.index === i ? reacting.reaction : null;
                return (
                  <motion.div
                    key={keys[i]}
                    ref={i === foundIndex ? foundRef : undefined}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i, 10) * 0.02 }}
                    className={cn("group relative flex max-w-[80%] flex-col gap-0.5", m.mine ? "items-end self-end" : "items-start self-start", (canReact || canReply) && "pt-1")}
                  >
                    {showName && <span className="ml-1 text-xs text-muted-foreground">{m.sender}</span>}
                    <MessageActions
                      message={m}
                      canReact={canReact}
                      canReply={canReply}
                      pending={pending}
                      onReact={(r) => react(m, i, r)}
                      onReply={() => replyToMessage(m)}
                    />
                    <div
                      aria-current={i === foundIndex ? "true" : undefined}
                      className={cn(
                        "flex flex-col gap-1.5 rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap transition-shadow",
                        m.mine ? "rounded-tr-md border border-primary/30 bg-primary/10 dark:bg-primary/15" : "rounded-tl-md bg-muted",
                        i === foundIndex && "ring-2 ring-warning/70",
                        targeted && "ring-2 ring-link/50"
                      )}
                    >
                      {m.replyTo && <Quote target={m.replyTo} />}
                      {i === foundIndex ? <Highlight text={m.text} range={findFolded(m.text, foundQuery)} /> : m.text}
                    </div>
                    {(m.at || (m.reactions?.length ?? 0) > 0) && (
                      <div className={cn("mx-1 flex items-center gap-1.5", m.mine && "flex-row-reverse")}>
                        {m.at && <span className="text-xs text-muted-foreground tabular-nums">{m.at}</span>}
                        <AnimatePresence initial={false}>
                          {(m.reactions ?? []).map((r) => (
                            <motion.span
                              key={r}
                              initial={{ scale: 0.4, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              transition={{ type: "spring", stiffness: 500, damping: 22 }}
                              title={`Tu as réagi : ${REACTIONS.find((x) => x.key === r)?.label ?? r}`}
                              className="rounded-full border border-primary/30 bg-primary/10 px-1.5 text-xs leading-5"
                            >
                              {EMOJI[r]}
                            </motion.span>
                          ))}
                        </AnimatePresence>
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </>
          )}
        </StickToBottom.Content>
      </StickToBottom>

      <motion.div animate={controls} className="border-t px-5 py-3">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {draft && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", edited ? "bg-link" : "bg-warning")} />
              {edited ? "Ta réponse · modifiée" : "Réponse proposée · modifiable"}
              {draft.usedGithub && (
                <span className="ml-2 flex min-w-0 items-center gap-1 truncate">
                  <GithubLogo className="size-3.5 shrink-0" /> {draft.usedGithub}
                </span>
              )}
              <AnimatePresence initial={false}>
                {fresher && fresher.trim() !== text.trim() && (
                  <motion.span key="fresher" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="ml-auto flex items-center gap-1">
                    Nouvelle proposition
                    <Button size="sm" variant="ghost" className="h-6 rounded-full px-2 text-link" onClick={() => { setText(fresher); setFresher(null); }}>
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
          <Textarea
            ref={composer}
            aria-label={replyTo ? `Réponse au message de ${replyTo.sender}` : `Message à ${c.displayName}`}
            placeholder={replyTo ? `Répondre à ${replyTo.sender || "ce message"}…` : `Écrire à ${c.displayName}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                setReplyTo(null);
              }
            }}
            disabled={busy === "send"}
            rows={2}
            className={cn(
              "field-sizing-content max-h-48 min-h-16 resize-none rounded-xl",
              draft && "border-primary/30 bg-primary/5 dark:bg-primary/10"
            )}
          />
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Kbd>Ctrl</Kbd>+<Kbd>Entrée</Kbd> pour envoyer
            </span>
            <div className="ml-auto flex gap-2">
              {draft && (
                <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" disabled={busy !== "idle"} onClick={dismiss}>
                  Ignorer
                </Button>
              )}
              <Button variant="outline" size="sm" className="rounded-full" disabled={busy !== "idle"} onClick={suggest}>
                {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />}
                {replyTo ? "Proposer une réponse" : draft ? "Autre proposition" : "Proposer"}
              </Button>
              <Button size="sm" className="min-w-24 rounded-full" disabled={busy !== "idle" || !text.trim()} onClick={send}>
                {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Envoyer
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
