import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Clock, Loader2, Paperclip, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QueuedSend, Trame } from "@/api";

const STATUS: Record<QueuedSend["status"], { label: string; tone: string }> = {
  waiting: { label: "En attente d'envoi", tone: "text-muted-foreground" },
  sending: { label: "Envoi en cours…", tone: "text-muted-foreground" },
  failed: { label: "Non envoyé", tone: "text-destructive" },
  uncertain: { label: "Peut-être parti : vérifie dans Teams", tone: "text-warning" },
};

/** Messages d'une conversation qui attendent dans la file d'envoi : envoyés quand Teams
 *  n'était pas prêt, ils partent seuls dès qu'il l'est. Un message refusé ou incertain
 *  n'est jamais renvoyé sans ton clic. */
export function OutboxItems({ trame, threadId }: { trame: Trame; threadId: string }) {
  const items = trame.state.outbox.filter((q) => q.threadId === threadId);
  const act = async (q: QueuedSend, what: "retry" | "cancel") => {
    const res = what === "retry" ? await trame.retryQueued(q.id) : await trame.cancelQueued(q.id);
    if (!res.ok) toast.error(what === "retry" ? "Nouvel essai impossible" : "Annulation impossible", { description: res.error });
  };
  return (
    <AnimatePresence initial={false}>
      {items.map((q) => {
        const s = STATUS[q.status];
        const stuck = q.status === "failed" || q.status === "uncertain";
        return (
          <motion.div
            key={q.id}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            className="flex max-w-[80%] flex-col items-end gap-1 self-end"
            aria-label={`Message en file d'envoi : ${s.label}`}
          >
            <div className="rounded-2xl rounded-tr-md border border-dashed border-primary/40 bg-primary/5 px-3.5 py-2 text-sm whitespace-pre-wrap">
              {q.text}
              {q.files.length > 0 && (
                <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="size-3.5" /> {q.files.join(", ")}
                </span>
              )}
            </div>
            <div className={cn("mx-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs", s.tone)}>
              {q.status === "sending" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : stuck ? (
                <AlertTriangle className="size-3.5" />
              ) : (
                <Clock className="size-3.5" />
              )}
              <span>{s.label}</span>
              {q.reason && <span className="text-muted-foreground">· {q.reason}</span>}
              {q.status !== "sending" && (
                <span className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-6 rounded-full px-2 text-link" onClick={() => act(q, "retry")}>
                    <RotateCcw className="size-3.5" /> {q.status === "uncertain" ? "Renvoyer quand même" : "Réessayer"}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 rounded-full px-2" onClick={() => act(q, "cancel")}>
                    <X className="size-3.5" /> Annuler
                  </Button>
                </span>
              )}
            </div>
          </motion.div>
        );
      })}
    </AnimatePresence>
  );
}
