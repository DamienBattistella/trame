import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { BookOpenText, ExternalLink, Loader2, PenLine, RotateCcw, Send } from "lucide-react";
import { toast } from "sonner";
import { StickToBottom } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InitialsAvatar, Segment, shake } from "@/components/kit";
import { GithubLogo } from "@/brands";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { DraftItem, ThreadMessage, WatchEntity } from "@/types";
import type { BriefTarget } from "@/components/BriefSheet";

const KIND = { dm: "Conversation privée", group: "Groupe", channel: "Canal" } as const;

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

/** Une discussion : historique lu dans Teams, réponse proposée pré-remplie, envoi à la main. */
export function DiscussionView({
  trame,
  conversation: c,
  draft,
  onBrief,
}: {
  trame: Trame;
  conversation: WatchEntity;
  draft: DraftItem | null;
  onBrief: (t: BriefTarget) => void;
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(draft?.proposal ?? "");
  const [busy, setBusy] = useState<"idle" | "send" | "suggest" | "dismiss">("idle");
  const [fresher, setFresher] = useState<string | null>(null);
  const base = useRef(draft?.proposal ?? "");
  const controls = useAnimationControls();

  const load = async (fresh = false) => {
    setError(null);
    if (fresh) setMessages(null);
    const res = await trame.threadMessages(c.threadId, fresh);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessages(res.messages);
  };

  useEffect(() => {
    setMessages(null);
    setText(draft?.proposal ?? "");
    base.current = draft?.proposal ?? "";
    setFresher(null);
    load();
  }, [c.threadId]);

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
    const res = draft ? await trame.sendDraft(draft.id, body) : await trame.sendInThread(c.threadId, body);
    setBusy("idle");
    if (!res.ok) return fail(`Envoi impossible à ${c.displayName}`, `${res.error} Ton message est conservé.`);
    if (draft) trame.removeDraft(draft.id);
    setMessages((m) => [...(m ?? []), { sender: "Toi", text: body, at: "à l'instant", mine: true }]);
    setText("");
    base.current = "";
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
    const res = await trame.suggestInThread(c.threadId);
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
  const edited = draft && text.trim() !== draft.proposal.trim();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b px-5 py-3">
        <InitialsAvatar name={c.displayName} className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{c.displayName}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[KIND[c.surface], draft?.senderLabel].filter(Boolean).join(" · ")}
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

      <StickToBottom className="relative min-h-0 flex-1 overflow-y-auto" resize="smooth" initial="instant">
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
              {messages === null && draft && (
                <span className="flex items-center justify-center gap-2 pb-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Historique en cours de lecture…
                </span>
              )}
              {shown.map((m, i) => {
                const showName = !m.mine && c.surface !== "dm" && shown[i - 1]?.sender !== m.sender;
                return (
                  <motion.div
                    key={`${i}-${m.at}-${m.text.slice(0, 12)}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i, 10) * 0.02 }}
                    className={cn("flex max-w-[80%] flex-col gap-0.5", m.mine ? "items-end self-end" : "items-start self-start")}
                  >
                    {showName && <span className="ml-1 text-xs text-muted-foreground">{m.sender}</span>}
                    <div className={cn("rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap", m.mine ? "rounded-tr-md border border-primary/30 bg-primary/10 dark:bg-primary/15" : "rounded-tl-md bg-muted")}>
                      {m.text}
                    </div>
                    {m.at && <span className="mx-1 text-xs text-muted-foreground tabular-nums">{m.at}</span>}
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
          <Textarea
            aria-label={`Message à ${c.displayName}`}
            placeholder={`Écrire à ${c.displayName}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
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
                {draft ? "Autre proposition" : "Proposer"}
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
