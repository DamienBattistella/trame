import { useEffect, useState } from "react";
import { EyeOff, MonitorUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GroupList } from "@/components/kit";
import { TeamsLogo } from "@/brands";
import { isDesktop, teamsWebHide, teamsWebOpen } from "@/desktop";
import { Trame } from "@/api";

type Status = { enabled: boolean; relay?: boolean; ready?: boolean; title?: string; error?: string };

/** Réglages › Général › Teams : la session Teams web de Trame (lecture et envoi). */
export function TeamsWebSettings({ trame }: { trame: Trame }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
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
  }, [trame.connected]);

  const line = !status
    ? "Vérification…"
    : !status.relay
      ? "Ouverture de la fenêtre Teams de Trame…"
      : status.ready
        ? `Connecté${status.title ? ` · ${status.title}` : ""}`
        : "Connexion requise : affiche Teams et connecte-toi.";

  return (
    <GroupList>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
          <TeamsLogo className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span>Teams</span>
          <span className="truncate text-xs text-muted-foreground">{line}</span>
        </div>
        {isDesktop() && (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => teamsWebOpen(true)}>
              <MonitorUp className="size-4" /> Afficher
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => teamsWebHide()}>
              <EyeOff className="size-4" /> Masquer
            </Button>
          </div>
        )}
      </div>
      <div className="px-4 py-2.5 text-xs text-muted-foreground">
        Trame lit et écrit dans sa propre fenêtre Teams, cachée. C'est une session de plus sur ton compte : ouvrir une
        conversation peut la marquer comme lue. L'envoi reste toujours ton clic ou le mode Auto.
      </div>
    </GroupList>
  );
}
