import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Ban, Brain, Loader2, Lock, Puzzle, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupList, SectionLabel, StatusDot, spring, type Status } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { ReflectionRun, ReflectionStep } from "@/types";

const STATUS: Record<ReflectionRun["status"], { label: string; dot: Status }> = {
  running: { label: "En cours", dot: "run" },
  done: { label: "Terminé", dot: "ok" },
  error: { label: "Échec", dot: "error" },
  cancelled: { label: "Annulée", dot: "error" },
};

const seconds = (ms: number) => `${(ms / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

/**
 * Panneau Réflexion, ancré à droite de la discussion : ce que fait le modèle pendant
 * « Corriger », « Vérifier » et « Proposer une réponse », en direct (étapes de Trame,
 * réflexion du modèle quand le cerveau la transmet, résultat, durée), et les dernières
 * actions. Tout reste sur ce poste.
 */
export function ReflectionPanel({ trame, onClose }: { trame: Trame; onClose: () => void }) {
  const runs = trame.reflections;
  const [pinned, setPinned] = useState<string | null>(null);
  // Une nouvelle action prend la place de celle qu'on consultait.
  const newest = runs[0]?.id;
  useEffect(() => setPinned(null), [newest]);
  const shown = runs.find((r) => r.id === pinned) ?? runs[0] ?? null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="relative flex flex-row items-center gap-3 px-5 py-4 pr-12">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
          <Brain className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate font-semibold text-foreground">Réflexion du modèle</h2>
          <p className="text-xs text-muted-foreground">
            {shown?.status === "running" ? `${shown.title} en cours…` : "Ce que fait le modèle pendant tes actions"}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="absolute top-3.5 right-3 size-8 rounded-full" aria-label="Fermer la réflexion" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <Separator />

      <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        {shown ? (
          <div className="flex flex-col gap-6 px-5 py-5">
            <RunDetail key={shown.id} run={shown} trame={trame} />
            {runs.length > 1 && (
              <section>
                <SectionLabel>Dernières actions</SectionLabel>
                <GroupList>
                  {runs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      aria-current={r.id === shown.id ? "true" : undefined}
                      onClick={() => setPinned(r.id)}
                      className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60", r.id === shown.id && "bg-secondary")}
                    >
                      <StatusDot status={STATUS[r.status].dot} className="size-5 scale-75" />
                      <span className="min-w-0 flex-1 truncate">
                        {r.title}
                        {r.conversation && <span className="text-muted-foreground"> · {r.conversation}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {r.durationMs !== null ? seconds(r.durationMs) : r.startedAt}
                      </span>
                    </button>
                  ))}
                </GroupList>
              </section>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
            <span className="grid size-12 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Brain className="size-5" />
            </span>
            <p className="font-medium">Aucune action pour l'instant</p>
            <p className="text-sm text-muted-foreground">
              Clique sur « Corriger », « Vérifier » ou « Proposer une réponse » : le panneau montre ici ce que fait le modèle, en direct.
            </p>
          </div>
        )}
      </ScrollArea>

      <Separator />
      <p className="flex items-center gap-1.5 px-5 py-3 text-xs text-muted-foreground">
        <Lock className="size-3" /> Reste sur ce poste : jamais envoyé dans Teams.
      </p>
    </div>
  );
}

function RunDetail({ run, trame }: { run: ReflectionRun; trame: Trame }) {
  const [stopping, setStopping] = useState(false);
  const running = run.status === "running";
  const stop = async () => {
    setStopping(true);
    const res = await trame.cancelReflection(run.id);
    if (!res.ok) {
      setStopping(false);
      toast.error("Impossible d'arrêter l'action", { description: res.error });
    }
  };
  const meta = [run.provider, run.model, run.startedAt, run.conversation].filter(Boolean).join(" · ");

  return (
    <section data-testid="reflection-run" data-status={run.status} className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <StatusDot status={STATUS[run.status].dot} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">
            {run.title} <span className="font-normal text-muted-foreground">· {STATUS[run.status].label}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{meta}</span>
        </div>
        {running && (
          <Button variant="outline" size="sm" className="rounded-full" disabled={stopping} onClick={stop}>
            {stopping ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
            Arrêter
          </Button>
        )}
      </div>

      {!!run.skills?.length && (
        <div data-testid="reflection-skills" className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Puzzle className="size-3.5" /> Skill{run.skills.length > 1 ? "s" : ""} chargé{run.skills.length > 1 ? "s" : ""} :
          {run.skills.map((s) => (
            <span key={s} className="rounded-full bg-secondary px-2 py-0.5 font-mono text-foreground">{s}</span>
          ))}
        </div>
      )}

      <ol className="flex flex-col gap-2.5" aria-label="Étapes">
        <AnimatePresence initial={false}>
          {run.steps.map((s, i) => (
            <motion.li key={`${i}-${s.kind}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
              <StepLine step={s} live={running && i === run.steps.length - 1} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>

      {!running && !run.reasoning && run.status !== "cancelled" && (
        <p className="text-xs text-muted-foreground">
          Ce cerveau ne transmet pas le texte de sa réflexion : seules les étapes de Trame sont affichées.
        </p>
      )}

      {run.status === "done" && (
        <div>
          <SectionLabel>Résultat{run.durationMs !== null && ` · en ${seconds(run.durationMs)}`}</SectionLabel>
          <GroupList data-testid="reflection-result" className="px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {run.result || "—"}
          </GroupList>
        </div>
      )}
      {(run.status === "error" || run.status === "cancelled") && run.durationMs !== null && (
        <p className="text-xs text-muted-foreground">Arrêtée après {seconds(run.durationMs)}.</p>
      )}
    </section>
  );
}

export function StepLine({ step, live }: { step: ReflectionStep; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // La réflexion défile avec le texte qui arrive.
  useEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [live, step.text]);
  const time = <span className="shrink-0 text-xs text-muted-foreground tabular-nums">+{seconds(step.atMs)}</span>;

  if (step.kind === "thinking") {
    return (
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Brain className="size-3.5" /> Réflexion du modèle <span className="ml-auto font-normal">{time}</span>
        </span>
        <div
          ref={box}
          data-testid="reflection-thinking"
          className="max-h-72 overflow-y-auto rounded-xl border bg-muted/40 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words text-muted-foreground italic"
        >
          {step.text}
          {live && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-muted-foreground/60 align-middle" />}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-start gap-2 text-sm", step.kind === "error" && "text-destructive")}>
      <span className="mt-1.5 grid size-2 shrink-0 place-items-center">
        {live ? <Loader2 className="size-3 animate-spin text-link" /> : <span className={cn("size-1.5 rounded-full", step.kind === "error" ? "bg-destructive" : "bg-muted-foreground/50")} />}
      </span>
      <span className="min-w-0 flex-1">{step.text}</span>
      {time}
    </div>
  );
}
