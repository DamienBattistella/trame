import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Loader2, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Trame, TeamsCheck } from "@/api";

const time = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

/** Bandeau du panneau : Teams web a changé et une fonction de Trame ne marchera plus. */
/** onDetail absent : le détail est déjà à l'écran (Réglages). */
export function TeamsCheckBanner({ check, onDetail }: { check: TeamsCheck | null; onDetail?: () => void }) {
  const show = Boolean(check && !check.ok && check.summary);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="teams-check"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="shrink-0 overflow-hidden"
        >
          <div role="alert" className="mb-4 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2 text-sm">
            <AlertTriangle className="size-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">{check!.summary}</span>
            {onDetail && (
              <Button variant="ghost" size="sm" className="h-7 shrink-0 rounded-full" onClick={onDetail}>
                Détail
              </Button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Réglages › Général › Teams : dernier contrôle des repères de la page Teams web. */
export function TeamsCheckRow({ trame }: { trame: Trame }) {
  const [busy, setBusy] = useState(false);
  const check = trame.state.teamsCheck;

  const run = async () => {
    setBusy(true);
    const res = await trame.checkTeams();
    setBusy(false);
    if (!res.ok) toast.error("Contrôle impossible", { description: res.error });
    else if (res.check?.ok) toast.success("Teams n'a pas changé", { description: `${res.check.verified} repères présents.` });
  };

  const line = !check
    ? "Pas encore contrôlée : le contrôle tourne quand Teams se connecte, puis toutes les heures."
    : check.ok
      ? `Rien n'a changé · ${check.verified} repères présents · contrôlé à ${time(check.at)}`
      : `${check.missing.length} repère${check.missing.length > 1 ? "s" : ""} introuvable${check.missing.length > 1 ? "s" : ""} · contrôlé à ${time(check.at)}`;

  return (
    <div className="flex flex-col">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
          {check && !check.ok ? <AlertTriangle className="size-4 text-warning" /> : <ScanSearch className="size-4" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">Page Teams</span>
          <span className="text-xs text-muted-foreground">{line}</span>
        </div>
        <Button variant="outline" size="sm" className="rounded-full" disabled={busy} onClick={run}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? "Contrôle…" : "Vérifier"}
        </Button>
      </div>
      {check && !check.ok && (
        <div className="border-t px-4 py-2.5 text-sm">
          <p className="mb-2">{check.summary}</p>
          <ul className="flex flex-col gap-1.5 text-xs">
            {check.missing.map((m) => (
              <li key={m.key} className="flex flex-col">
                <span>
                  <span className="font-medium">{m.label}</span>{" "}
                  <span className="font-mono text-muted-foreground">{m.key}</span>
                </span>
                <span className="text-muted-foreground">
                  {m.how === "usage" ? `Introuvable quand Trame s'en est servi, à ${time(m.at)}` : "Absent de la page au contrôle"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        Trame repère les éléments de Teams web dont il se sert, sans rien cliquer : au démarrage, à la connexion, toutes
        les heures et après un refus de Teams. Ceux des menus (statut, « Marquer comme lu »…) sont vérifiés quand Trame
        s'en sert.
      </div>
    </div>
  );
}
