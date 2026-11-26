import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bot, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Trame, UndoableSend } from "@/api";

const left = (u: UndoableSend, now: number) => Math.max(0, Math.ceil((u.expiresAtMs - now) / 1000));

/** Retire une réponse partie seule ; un échec est dit tel quel. */
async function undo(trame: Trame, u: UndoableSend) {
  const res = await trame.undoAuto(u.id);
  if (res.ok) toast.success("Réponse retirée", { description: `Supprimée dans Teams (${u.conversation}).` });
  else toast.error("Réponse non retirée", { description: res.error });
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Dans la discussion : sous le fil, les réponses que Trame vient d'envoyer seul, avec
 *  « Annuler » tant que la fenêtre est ouverte (la personne verra « message supprimé »). */
export function UndoAutoBar({ trame, threadId }: { trame: Trame; threadId: string }) {
  const items = trame.state.undoable.filter((u) => u.threadId === threadId);
  const now = useNow(items.length > 0);
  const [busy, setBusy] = useState<string | null>(null);
  const open = items.filter((u) => left(u, now) > 0);
  return (
    <AnimatePresence initial={false}>
      {open.map((u) => (
        <motion.div
          key={u.id}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="mx-1 flex items-center justify-end gap-2 self-end text-xs text-muted-foreground"
        >
          <Bot className="size-3.5" />
          <span>Envoyée automatiquement</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-full px-2 text-link"
            disabled={busy === u.id}
            onClick={async () => {
              setBusy(u.id);
              await undo(trame, u);
              setBusy(null);
            }}
          >
            {busy === u.id ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
            Annuler ({left(u, now)} s)
          </Button>
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

/** Partout dans Trame : une notification avec « Annuler » dès qu'une réponse part seule. */
export function UndoAutoToasts({ trame }: { trame: Trame }) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = trame.state.undoable.map((u) => u.id);
    // Premier état reçu : ce qui est déjà là a été annoncé avant (ou n'est plus d'actualité).
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    for (const u of trame.state.undoable) {
      if (seen.current.has(u.id)) continue;
      seen.current.add(u.id);
      const ms = u.expiresAtMs - Date.now();
      if (ms <= 1000) continue;
      toast(`Réponse envoyée à ${u.conversation}`, {
        description: u.text.length > 90 ? `${u.text.slice(0, 90)}…` : u.text,
        duration: ms,
        action: { label: "Annuler", onClick: () => void undo(trame, u) },
      });
    }
  }, [trame.state.undoable]);
  return null;
}
