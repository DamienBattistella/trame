import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Loader2, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Trame } from "@/api";

/** Réglages › Avancé › Diagnostic Teams : rapport de calibration à copier. */
export function DiagnosticRow({ trame }: { trame: Trame }) {
  const [state, setState] = useState<"idle" | "run">("idle");
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const target = trame.state.watchlist.find((w) => w.watch);

  const run = async () => {
    setState("run");
    const res = await trame.diagnoseTeams(target?.threadId);
    setState("idle");
    if (!res.ok) {
      toast.error("Diagnostic impossible", { description: res.error });
      return;
    }
    setReport(JSON.stringify(res.report, null, 2));
  };

  const copy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Copie impossible", { description: "Sélectionne le rapport et copie-le à la main." });
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
          <Stethoscope className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">Diagnostic Teams</span>
          <span className="text-xs text-muted-foreground">
            {target ? `Relève la structure de Teams et teste l'ouverture de « ${target.displayName} ».` : "Relève la structure de Teams pour calibrer Trame."}
          </span>
        </div>
        <Button variant="outline" size="sm" className="rounded-full" disabled={state === "run"} onClick={run}>
          {state === "run" && <Loader2 className="size-4 animate-spin" />}
          {state === "run" ? "Analyse…" : "Lancer"}
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {report && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden border-t"
          >
            <div className="flex items-center justify-between px-4 pt-2.5">
              <span className="text-xs text-muted-foreground">Sans le texte de tes messages. Colle-le dans la conversation avec Claude.</span>
              <Button variant="ghost" size="sm" className="rounded-full" onClick={copy}>
                {copied ? <Check className="size-4 text-success" strokeWidth={3} /> : <Copy className="size-4" />}
                {copied ? "Copié" : "Copier"}
              </Button>
            </div>
            <ScrollArea className="h-56">
              <pre className="px-4 pb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap select-all">{report}</pre>
            </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
