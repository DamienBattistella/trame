import { useEffect, useState } from "react";
import { AlertTriangle, EyeOff, Loader2, MonitorUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { GroupList } from "@/components/kit";
import { TeamsLogo } from "@/brands";
import { isDesktop, restartBackend, teamsWebClose, teamsWebHide, teamsWebOpen } from "@/desktop";
import { Trame } from "@/api";

type Status = { enabled: boolean; relay?: boolean; ready?: boolean; title?: string; error?: string };

/** Réglages › Avancé › Teams intégré (expérimental). */
export function TeamsWebSettings({ trame, enabled, onToggle }: { trame: Trame; enabled: boolean; onToggle: (v: boolean) => Promise<boolean> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!enabled) return setStatus(null);
    let live = true;
    const tick = async () => {
      const res = await trame.teamsWebStatus();
      if (live && res.ok) setStatus(res.status);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [enabled, trame.connected]);

  const toggle = async (v: boolean) => {
    setSwitching(true);
    const saved = await onToggle(v);
    if (saved) {
      if (!v) await teamsWebClose();
      const restarted = await restartBackend();
      const openError = v ? await teamsWebOpen(true) : null;
      if (!restarted || openError) {
        toast.error("Changement incomplet", {
          description: openError ? `Fenêtre Teams : ${openError}` : "Le moteur n'a pas redémarré : relance Trame.",
        });
      } else {
        toast.success(v ? "Teams intégré activé" : "Retour au pilotage de l'appli Teams", {
          description: v ? "Connecte-toi une fois dans la fenêtre Teams de Trame." : "Le moteur a redémarré.",
        });
      }
    }
    setSwitching(false);
  };

  const line = !enabled
    ? "Désactivé : Trame pilote l'appli Teams de ton poste."
    : !status
      ? "Vérification…"
      : !status.relay
        ? "Fenêtre Teams de Trame en cours d'ouverture…"
        : status.ready
          ? `Prêt${status.title ? ` · ${status.title}` : ""}`
          : "Connexion requise : ouvre Teams et connecte-toi.";

  return (
    <div className="flex flex-col gap-3">
      <GroupList>
        <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
            <TeamsLogo className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <Label htmlFor="teams-web" className="font-normal">
              Teams intégré <span className="text-xs text-muted-foreground">expérimental</span>
            </Label>
            <span className="truncate text-xs text-muted-foreground">{line}</span>
          </div>
          {switching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Switch id="teams-web" checked={enabled} disabled={switching || !isDesktop()} onCheckedChange={toggle} />
        </div>
        {enabled && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-2.5">
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => teamsWebOpen(true)}>
              <MonitorUp className="size-4" /> Ouvrir Teams
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => teamsWebHide()}>
              <EyeOff className="size-4" /> Masquer
            </Button>
          </div>
        )}
        <div className="flex gap-2.5 px-4 py-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            Trame lit et écrit dans sa propre fenêtre Teams web, sans toucher à ton appli Teams. C'est une deuxième session :
            ouvrir une conversation peut la marquer comme lue chez tes collègues, un nouvel appareil apparaît dans tes
            connexions, et l'accès conditionnel de ton entreprise peut la refuser. L'envoi reste toujours ton clic ou le
            mode Auto.
          </span>
        </div>
      </GroupList>
    </div>
  );
}
