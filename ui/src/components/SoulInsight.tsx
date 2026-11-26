import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GroupList, pop } from "@/components/kit";
import { analyzeSoul, Quality } from "@/lib/soulInsight";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";

const QUALITY: Record<Quality, { label: string; className: string }> = {
  complet: { label: "Complet", className: "bg-success/15 text-success" },
  correct: { label: "Correct", className: "bg-link/10 text-link" },
  "a-completer": { label: "À compléter", className: "bg-warning/15 text-warning" },
};

/** Après le dépôt du SOUL.md : ce que Trame en retient, sa qualité, et un exemple de réponse. */
export function SoulInsight({ trame, content }: { trame: Trame; content: string }) {
  const { aspects, score, quality } = useMemo(() => analyzeSoul(content), [content]);
  const [sample, setSample] = useState<{ incoming: string; reply: string } | null>(null);
  const [state, setState] = useState<"idle" | "run" | "error">("idle");
  const [error, setError] = useState("");
  const q = QUALITY[quality];
  const missing = aspects.filter((a) => !a.found);

  const preview = async () => {
    setState("run");
    const res = await trame.previewSoul(content);
    if (!res.ok) {
      setState("error");
      setError(res.error);
      return;
    }
    setSample({ incoming: res.incoming, reply: res.reply });
    setState("idle");
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full text-left">
      <GroupList>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm font-medium">Ce que Trame en retient</span>
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums", q.className)}>
            {q.label} · {score}/{aspects.length}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-3">
          {aspects.map((a, i) => (
            <div key={a.id} className="flex items-center gap-2 text-sm" title={a.found ? undefined : a.hint}>
              {a.found ? (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ ...pop, delay: 0.05 * i }}
                  className="grid size-4 shrink-0 place-items-center rounded-full bg-success text-success-foreground"
                >
                  <Check className="size-2.5" strokeWidth={4} />
                </motion.span>
              ) : (
                <span className="size-4 shrink-0 rounded-full border border-muted-foreground/40" />
              )}
              <span className={cn(!a.found && "text-muted-foreground")}>{a.label}</span>
            </div>
          ))}
        </div>
        {missing.length > 0 && (
          <div className="px-4 py-2.5 text-xs text-muted-foreground">
            Pour l'améliorer : {missing.slice(0, 2).map((m) => m.hint.toLowerCase().replace(/\.$/, "")).join(" ; ")}.
          </div>
        )}
        <div className="flex flex-col gap-2.5 px-4 py-3">
          <AnimatePresence mode="wait" initial={false}>
            {sample ? (
              <motion.div key="sample" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-2">
                <div className="max-w-[85%] self-start rounded-2xl rounded-tl-md bg-muted px-3.5 py-2 text-sm">{sample.incoming}</div>
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 }}
                  className="max-w-[85%] self-end rounded-2xl rounded-tr-md border border-primary/30 bg-primary/10 px-3.5 py-2 text-sm whitespace-pre-wrap dark:bg-primary/15"
                >
                  {sample.reply}
                </motion.div>
                <span className="self-end text-xs text-muted-foreground">Ce que Trame répondrait avec ce fichier</span>
              </motion.div>
            ) : (
              <motion.div key="cta" className="flex items-center justify-between gap-3">
                <span className={cn("text-sm", state === "error" ? "text-destructive" : "text-muted-foreground")}>
                  {state === "error" ? error : "Voir une réponse écrite avec ta voix."}
                </span>
                <Button size="sm" variant="outline" className="shrink-0 rounded-full" disabled={state === "run"} onClick={preview}>
                  {state === "run" && <Loader2 className="size-4 animate-spin" />}
                  {state === "run" ? "Rédaction…" : state === "error" ? "Réessayer" : "Voir un exemple"}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </GroupList>
    </motion.div>
  );
}
