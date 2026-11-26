import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCheck } from "lucide-react";
import { Trame } from "@/api";
import { ThreadActivity as Activity, ThreadMessage, WatchEntity } from "@/types";

// Le moteur relit la liste de Teams toutes les 5 s : interroger plus souvent n'apporte rien.
const POLL_MS = 3000;

/** Sous le fil : « Ana est en train d'écrire… » et « Vu » sous ton dernier message.
 *  Rien n'est lu dans Teams pour l'afficher : le moteur répond avec ce que montre la liste
 *  des conversations qu'il interroge déjà. */
export function ThreadActivity({ trame, conversation, last }: { trame: Trame; conversation: WatchEntity; last?: ThreadMessage }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const { threadId } = conversation;

  useEffect(() => {
    let alive = true;
    setActivity(null);
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await trame.threadActivity(threadId);
      if (alive && res.ok) setActivity({ typing: res.typing, typingText: res.typingText, seen: res.seen });
    };
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // trame change à chaque rendu : seul l'identifiant compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // En direct quand la fenêtre Teams de Trame montre cette conversation, sinon tel que lu
  // avec le fil. Un message que tu viens d'envoyer n'est pas encore relu : en direct seulement.
  const justSent = last?.at === "à l'instant";
  const seen = Boolean(last?.mine && (activity?.seen ?? (justSent ? null : last.seen)));
  const typing = Boolean(activity?.typing);
  const who =
    activity?.typingText ||
    (conversation.surface === "dm" ? `${conversation.displayName} est en train d'écrire` : "Quelqu'un est en train d'écrire");

  return (
    <>
      {seen && (
        <span className="-mt-2 mr-1 flex items-center gap-1 self-end text-xs text-muted-foreground" title="Teams indique que ton dernier message a été lu">
          <CheckCheck className="size-3.5" aria-hidden /> Vu
        </span>
      )}
      <AnimatePresence initial={false}>
        {typing && (
          <motion.div
            key="typing"
            role="status"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-2 self-start px-1 text-xs text-muted-foreground"
          >
            <span className="flex gap-0.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="size-1.5 rounded-full bg-muted-foreground/70"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </span>
            {who}…
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
