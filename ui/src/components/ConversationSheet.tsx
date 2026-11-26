import { useEffect, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { ExternalLink, Loader2, PenLine, RotateCcw, Send } from "lucide-react";
import { toast } from "sonner";
import { StickToBottom } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { InitialsAvatar, PRESENCE, Segment, shake } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { LinkCards } from "@/components/LinkCards";
import { MessageText } from "@/components/MessageText";
import { ThreadMessage, WatchEntity } from "@/types";

const KIND = { dm: "Conversation privée", group: "Groupe", channel: "Canal" } as const;

/** Mode manuel : l'historique d'une conversation et un champ de réponse, sans quitter Trame. */
export function ConversationSheet({ trame, conversation, onClose }: { trame: Trame; conversation: WatchEntity | null; onClose: () => void }) {
  const live = conversation ? trame.state.watchlist.find((w) => w.threadId === conversation.threadId) ?? conversation : null;
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"idle" | "send" | "suggest">("idle");
  const controls = useAnimationControls();

  const load = async (c: WatchEntity) => {
    setMessages(null);
    setError(null);
    const res = await trame.threadMessages(c.threadId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessages(res.messages);
  };

  useEffect(() => {
    setText("");
    if (conversation) load(conversation);
  }, [conversation?.threadId]);

  if (!live) return <Sheet open={false} />;

  const send = async (force = false) => {
    const body = text.trim();
    if (!body || busy !== "idle") return;
    setBusy("send");
    const res = await trame.sendInThread(live.threadId, body, null, [], [], force);
    setBusy("idle");
    if (!res.ok) {
      // Le même message, resté « non confirmé », est déjà dans le fil : renvoi sur demande seulement.
      if (res.code === "maybe_sent") {
        toast.warning(`Déjà envoyé à ${live.displayName} ?`, {
          description: `${res.error} Ton message est conservé.`,
          duration: 20000,
          action: { label: "Renvoyer quand même", onClick: () => void send(true) },
        });
        return;
      }
      controls.start(shake);
      toast.error(`Envoi impossible à ${live.displayName}`, { description: `${res.error} Ton message est conservé.` });
      return;
    }
    setMessages((m) => [...(m ?? []), { sender: "Toi", text: body, at: "à l'instant", mine: true }]);
    setText("");
  };

  const suggest = async () => {
    setBusy("suggest");
    const res = await trame.suggestInThread(live.threadId);
    setBusy("idle");
    if (!res.ok) {
      toast.error("Proposition impossible", { description: res.error });
      return;
    }
    setText(res.text);
  };

  const openInTeams = async () => {
    const res = await trame.showInTeams(live.threadId);
    if (!res.ok) toast.error("Ouverture dans Teams impossible", { description: res.error });
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[520px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader className="flex-row items-center gap-3 border-b pr-12">
          <InitialsAvatar name={live.displayName} presence={live.presence} className="size-9" />
          <div className="flex min-w-0 flex-1 flex-col">
            <SheetTitle className="truncate">{live.displayName}</SheetTitle>
            <SheetDescription>{[KIND[live.surface], live.presence && PRESENCE[live.presence]?.label].filter(Boolean).join(" · ")}</SheetDescription>
          </div>
          <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Ouvrir dans Teams" title="Ouvrir dans Teams" onClick={openInTeams}>
            <ExternalLink className="size-4" />
          </Button>
        </SheetHeader>

        <div className="flex items-center gap-3 border-b px-4 py-2">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={live.watch}
              onCheckedChange={() => trame.toggleWatch(live.threadId).then((r) => !r.ok && toast.error("Modification impossible", { description: r.error }))}
            />
            Suivie
          </label>
          <AnimatePresence initial={false}>
            {live.watch && (
              <motion.div key="mode" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="ml-auto">
                <Segment
                  label={`Mode pour ${live.displayName}`}
                  value={live.mode}
                  onChange={(v) => trame.setMode(live.threadId, v).then((r) => !r.ok && toast.error("Modification impossible", { description: r.error }))}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <StickToBottom className="relative min-h-0 flex-1 overflow-y-auto" resize="smooth" initial="instant">
          <StickToBottom.Content className="flex flex-col gap-2 px-4 py-4">
            {error ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <p className="max-w-xs text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => load(live)}>
                  <RotateCcw className="size-4" /> Réessayer
                </Button>
              </div>
            ) : messages === null ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Lecture de la conversation dans Teams…
              </div>
            ) : messages.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">Aucun message lisible dans cette conversation.</p>
            ) : (
              messages.map((m, i) => {
                const showName = !m.mine && live.surface !== "dm" && messages[i - 1]?.sender !== m.sender;
                return (
                  <motion.div
                    key={`${i}-${m.at}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i, 10) * 0.02 }}
                    className={cn("flex max-w-[85%] flex-col gap-0.5", m.mine ? "items-end self-end" : "items-start self-start")}
                  >
                    {showName && <span className="ml-1 text-xs text-muted-foreground">{m.sender}</span>}
                    <div
                      className={cn(
                        "rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap",
                        m.mine ? "rounded-tr-md border border-primary/30 bg-primary/10 dark:bg-primary/15" : "rounded-tl-md bg-muted"
                      )}
                    >
                      <MessageText text={m.text} links={m.links} github={trame.githubLink} />
                      <LinkCards cards={m.cards} />
                    </div>
                    {m.at && <span className="mx-1 text-xs text-muted-foreground tabular-nums">{m.at}</span>}
                  </motion.div>
                );
              })
            )}
          </StickToBottom.Content>
        </StickToBottom>

        <motion.div animate={controls} className="flex flex-col gap-2 border-t p-3">
          <Textarea
            aria-label={`Message à ${live.displayName}`}
            placeholder={`Écrire à ${live.displayName}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Entrée envoie, Maj+Entrée va à la ligne (pas pendant une saisie IME).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            disabled={busy === "send"}
            rows={2}
            className="field-sizing-content max-h-40 min-h-16 resize-none rounded-xl"
          />
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1 whitespace-nowrap text-xs text-muted-foreground sm:flex" title="Entrée pour envoyer, Maj+Entrée pour aller à la ligne">
              <Kbd>Entrée</Kbd> envoyer
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" className="rounded-full" disabled={busy !== "idle" || !messages?.length} onClick={suggest}>
                {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />}
                Proposer
              </Button>
              <Button size="sm" className="min-w-24 rounded-full" disabled={busy !== "idle" || !text.trim()} onClick={() => send()}>
                {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Envoyer
              </Button>
            </div>
          </div>
        </motion.div>
      </SheetContent>
    </Sheet>
  );
}
