import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BellRing, Clock, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FollowUpItem, Trame } from "@/api";

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** « depuis hier 16:05 », « depuis lundi 09:40 », « depuis le 12/11 » : quand la question a été posée. */
export function askedSince(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return `depuis ${hm}`;
  if (days === 1) return `depuis hier ${hm}`;
  if (days < 7) return `depuis ${DAYS[d.getDay()]} ${hm}`;
  return `depuis le ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Relances d'une conversation : ta question restée sans réponse, et la relance
 *  proposée, modifiable. Rien ne part sans ton clic sur « Envoyer ». */
export function FollowUpCards({ trame, threadId }: { trame: Trame; threadId: string }) {
  const items = trame.state.followUps.filter((f) => f.threadId === threadId);
  return (
    <AnimatePresence initial={false}>
      {items.map((f) => (
        <FollowUpCard key={f.id} trame={trame} item={f} />
      ))}
    </AnimatePresence>
  );
}

function FollowUpCard({ trame, item }: { trame: Trame; item: FollowUpItem }) {
  const [text, setText] = useState(item.proposal);
  const [busy, setBusy] = useState<"send" | "snooze" | "ignore" | null>(null);

  const send = async () => {
    const body = text.trim();
    if (!body) return void toast.error("La relance est vide");
    setBusy("send");
    const res = await trame.sendFollowUp(item.id, body);
    setBusy(null);
    if (!res.ok) return void toast.error("Relance non envoyée", { description: res.error });
    toast.success(res.queued ? "Relance en file d'envoi : elle part dès que Teams est prêt" : `Relance envoyée à ${item.conversation}`);
  };
  const later = async () => {
    setBusy("snooze");
    const res = await trame.snoozeFollowUp(item.id, 24);
    setBusy(null);
    if (!res.ok) return void toast.error("Report impossible", { description: res.error });
    toast.info("Relance reportée à demain");
  };
  const ignore = async () => {
    setBusy("ignore");
    const res = await trame.ignoreFollowUp(item.id);
    setBusy(null);
    if (!res.ok) toast.error("Impossible d'ignorer cette relance", { description: res.error });
  };

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      aria-label={`Relance proposée pour ${item.conversation}`}
      className="flex w-full flex-col gap-2 rounded-2xl border border-warning/40 bg-warning/5 p-3"
    >
      <header className="flex items-center gap-2 text-xs text-muted-foreground">
        <BellRing className="size-3.5 text-warning" />
        <span className="font-medium text-foreground">À relancer</span>
        <span>· ta question est sans réponse {askedSince(item.askedAt)}</span>
      </header>
      <blockquote className="border-l-2 border-border pl-2.5 text-sm text-muted-foreground whitespace-pre-wrap">{item.question}</blockquote>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Relance proposée"
        className="min-h-12 resize-none bg-background"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="rounded-full" disabled={busy !== null} onClick={ignore}>
              {busy === "ignore" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />} Ignorer
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ne plus proposer de relance pour cette question</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="rounded-full" disabled={busy !== null} onClick={later}>
              {busy === "snooze" ? <Loader2 className="size-3.5 animate-spin" /> : <Clock className="size-3.5" />} Plus tard
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reproposer demain</TooltipContent>
        </Tooltip>
        <Button size="sm" className="rounded-full" disabled={busy !== null || !text.trim()} onClick={send}>
          {busy === "send" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Envoyer
        </Button>
      </div>
    </motion.section>
  );
}
