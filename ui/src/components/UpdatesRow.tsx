import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownToLine, Check, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Segment } from "@/components/kit";
import { appVersion, checkUpdate, installUpdate, isDesktop, setAvailableUpdate } from "@/desktop";
import { cn } from "@/lib/utils";
import { UPDATE_CHECK_CHOICES, UpdateCheckMinutes } from "@/types";

type State = { kind: "idle" } | { kind: "checking" } | { kind: "latest" } | { kind: "available"; version: string } | { kind: "installing" };

/** « toutes les 15 minutes », « toutes les heures »… ; 0 : au lancement seulement. */
function checkEveryLabel(minutes: UpdateCheckMinutes): string {
  if (minutes === 0) return "Vérifiées au lancement seulement";
  const every = minutes === 60 ? "toutes les heures" : minutes > 60 ? `toutes les ${minutes / 60} heures` : `toutes les ${minutes} minutes`;
  return `Vérifiées au lancement puis ${every}`;
}

/** Réglages › Général › Mises à jour : version installée, recherche, installation. */
export function UpdatesRow({ checkMinutes }: { checkMinutes: UpdateCheckMinutes }) {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const desktop = isDesktop();

  useEffect(() => {
    appVersion().then(setVersion);
  }, []);

  const check = async () => {
    setState({ kind: "checking" });
    const res = await checkUpdate();
    if (!res.ok) {
      setState({ kind: "idle" });
      toast.error("Recherche impossible", { description: res.error });
      return;
    }
    setAvailableUpdate(res.update);
    setState(res.update ? { kind: "available", version: res.update.version } : { kind: "latest" });
  };

  const install = async () => {
    setState({ kind: "installing" });
    const error = await installUpdate();
    if (error) {
      setState({ kind: "idle" });
      toast.error("Mise à jour impossible", { description: `${error} Trame reste en version ${version ?? "actuelle"}.` });
    }
  };

  const status =
    state.kind === "checking"
      ? "Recherche…"
      : state.kind === "latest"
        ? "Trame est à jour"
        : state.kind === "available"
          ? `Version ${state.version} disponible`
          : state.kind === "installing"
            ? "Téléchargement et installation…"
            : checkEveryLabel(checkMinutes);

  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
        <ArrowDownToLine className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium tabular-nums">Trame {version ?? "dev"}</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={state.kind}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.15 }}
            className={state.kind === "latest" ? "flex items-center gap-1 text-xs text-success" : "text-xs text-muted-foreground"}
          >
            {state.kind === "latest" && <Check className="size-3" strokeWidth={3} />}
            {status}
          </motion.span>
        </AnimatePresence>
      </div>
      {state.kind === "available" || state.kind === "installing" ? (
        <Button size="sm" className="rounded-full" disabled={state.kind === "installing"} onClick={install}>
          {state.kind === "installing" && <Loader2 className="size-4 animate-spin" />}
          Installer et redémarrer
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="rounded-full" disabled={!desktop || state.kind === "checking"} onClick={check}>
          {state.kind === "checking" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Rechercher
        </Button>
      )}
    </div>
  );
}

const CHECK_OPTIONS = UPDATE_CHECK_CHOICES.map((m) => ({ value: String(m), label: m === 0 ? "Au lancement" : m < 60 ? `${m} min` : `${m / 60} h` }));

/** Réglages › Général › Mises à jour : fréquence de recherche d'une nouvelle version (config.json › ui). */
export function UpdateFrequencyRow({ value, onChange }: { value: UpdateCheckMinutes; onChange: (m: UpdateCheckMinutes) => void }) {
  const desktop = isDesktop();
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className={cn("text-sm transition-colors", !desktop && "text-muted-foreground")}>Rechercher une nouvelle version</span>
      <Segment
        label="Fréquence de recherche des mises à jour"
        value={String(value)}
        disabled={!desktop}
        options={CHECK_OPTIONS}
        onChange={(v) => onChange(Number(v) as UpdateCheckMinutes)}
      />
    </div>
  );
}
